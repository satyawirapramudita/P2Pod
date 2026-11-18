// packages/user-client/src/core/peerApp.ts

import { TcpConnectionManager, ManagedConnection } from '../net/tcpConnection';
import { CryptoEngine } from '../crypto/cryptoEngine';
import { TerminalUI } from '../ui/terminalUI';
import type { AnyMessage, HandshakeMessage, IdentityProofMessage, ChatMessage } from '@p2pod/shared';
import { Identity, fingerprintOf, verifyWithPeerId } from '../identity/identity';
import { DiscoveryClient, isValidIpv4 } from '../discovery/discoveryClient';
import { ChatSessionMeta, HistoryEntry, SolidClient } from '../modules/pod/solidClient';
import { looksLikePeerId, pickPeerBySpec } from '../targetResolver';
import { LocalStorage } from '../modules/storage/localStorage';
import { SyncManager } from '../modules/storage/syncManager';

export interface PeerAppOptions {
  identity: Identity;
  homeDir: string;
  discoveryUrl: string;
  podUrl?: string;
  listenPort: number;
  targetPeerId?: string;
  targetIp?: string;
  targetPort?: number;
}

const CONNECT_RETRY_INTERVAL_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

type ConnectAttemptResult = 'connected' | 'retry' | 'wait';

export class PeerApp {
  private readonly identity: Identity;
  private readonly tcpManager = new TcpConnectionManager();
  private readonly crypto = new CryptoEngine();
  private readonly ui: TerminalUI;
  private readonly discovery: DiscoveryClient;
  private readonly pod: SolidClient | null;
  private readonly podInitError: string | null;
  private readonly localStorage: LocalStorage;
  private readonly syncManager: SyncManager;
  private readonly listenPort: number;
  private readonly targetPort: number;

  private targetPeerId: string | null;
  private targetIp: string | null;

  private conn: ManagedConnection | null = null;
  private seq = 1;
  private sessionReady = false;
  private closing = false;
  private exitCode = 0;
  private connecting = false;
  private watcherRunning = false;
  private mutualNoticeShown = false;

  private remotePeerId: string | null = null;
  private remoteDisplayName: string | null = null;
  private remoteWebId: string | null = null;
  private transcript: string | null = null;
  private chatId: string | null = null;
  private currentSessionFile: string | null = null;
  private stopPeriodicSync: (() => void) | null = null;
  private history: HistoryEntry[] = [];
  private readonly sessionStartedAt = new Date().toISOString();

  constructor(options: PeerAppOptions) {
    this.identity = options.identity;
    this.listenPort = options.listenPort;
    this.targetPeerId = options.targetPeerId ?? null;
    this.targetIp = options.targetIp ?? null;
    this.targetPort = options.targetPort ?? 5000;
    this.discovery = new DiscoveryClient(options.discoveryUrl);
    this.ui = new TerminalUI(this.identity.displayName, () => {
      void this.shutdown('Input ditutup (Ctrl+D)...');
    });

    let pod: SolidClient | null = null;
    let podInitError: string | null = null;
    if (options.podUrl) {
      try {
        pod = new SolidClient(options.homeDir, options.podUrl);
      } catch (err: any) {
        podInitError = err.message;
      }
    }
    this.pod = pod;
    this.podInitError = podInitError;
    this.localStorage = new LocalStorage(options.homeDir);
    this.syncManager = new SyncManager(this.localStorage, this.pod);
  }

  get peerId(): string {
    return this.identity.peerId;
  }

  /**
   * Mode online (semua peran sama): dengarkan koneksi TCP, daftar ke Discovery Platform,
   * aktifkan command loop pra-sesi (/connect, /list, /help), lalu bila ada target
   * hubungi target secara berkala sampai online.
   */
  async start(): Promise<void> {
    this.setupShutdownHooks();

    const boundPort = await this.tcpManager.listen(this.listenPort, (conn) => this.handleIncoming(conn));
    this.ui.printSystem(`Mendengarkan koneksi TCP di port ${boundPort}.`);

    const registerOpts = {
      targetPeerId: this.targetPeerId ?? undefined,
      displayName: this.identity.displayName,
      webId: this.pod?.webId,
    };
    await this.discovery.register(this.identity.peerId, boundPort, registerOpts);
    this.discovery.startHeartbeat(this.identity.peerId, boundPort, registerOpts);
    this.ui.printSystem('Terdaftar di Discovery Platform.');

    this.ui.printSystem('Penyimpanan: Local-First aktif (pesan langsung disimpan ke disk lokal).');
    if (this.podInitError) {
      this.ui.printSystem(`⚠ Solid Pod: ${this.podInitError} (sinkronisasi cloud dinonaktifkan).`);
    } else if (this.pod) {
      const podReachable = await this.pod.ping();
      if (!podReachable) {
        this.ui.printSystem('⚠ Solid Pod offline/tidak terjangkau — sinkronisasi akan ditunda sampai Pod online.');
      } else {
        await this.pod.linkIdentity(this.identity).catch(() => undefined);
        this.ui.printSystem(`Solid Pod terhubung (${this.pod.basePodUrl}) — sinkronisasi cloud siap.`);
      }
    }

    this.ui.printSystem('Perintah: /connect <nama|PeerID> · /list · /help · /quit');

    this.startCommandLoop();

    if (this.targetPeerId || this.targetIp) {
      this.beginConnecting(this.targetIp ? `di ${this.targetIp}:${this.targetPort}` : 'via Discovery Platform');
    } else {
      this.ui.printSystem(
        'Menunggu koneksi masuk... (ketik /connect untuk menghubungi user lain, /list untuk daftar user)'
      );
    }

    await new Promise<void>(() => {
      // tetap hidup sampai sesi terbentuk / sinyal shutdown
    });
  }

  /** Mulai proses menghubungi peer (dipakai CLI & perintah runtime /connect). */
  private beginConnecting(viaText: string, label?: string): void {
    if (!this.targetPeerId || this.watcherRunning || this.closing) return;
    this.connecting = true;
    const who = label ? `"${label}" ` : '';
    this.ui.printSystem(
      `Menghubungi ${who}target fingerprint ${fingerprintOf(this.targetPeerId)} ${viaText} — dicoba berkala sampai online...`
    );
    void this.startConnectWatcher();
  }

  /** Watcher: cari target lewat Discovery (atau koneksi langsung bila targetIp diisi) secara berkala. */
  private async startConnectWatcher(): Promise<void> {
    if (this.watcherRunning || !this.targetPeerId) return;
    this.watcherRunning = true;
    const target = this.targetPeerId;
    let attempt = 0;

    try {
      while (!this.closing && !this.sessionReady) {
        attempt++;

        if (!this.conn) {
          const result = await this.tryConnectOnce(target);
          if (result === 'connected') break;
          if (result === 'retry' && (attempt === 1 || attempt % 5 === 0)) {
            this.ui.printSystem(`Menunggu peer online... (percobaan ${attempt})`);
          }
        }

        await delay(CONNECT_RETRY_INTERVAL_MS);
      }
    } finally {
      this.watcherRunning = false;
    }
  }

  private async tryConnectOnce(target: string): Promise<ConnectAttemptResult> {
    // Mode direct: koneksi TCP langsung ke IP target, tanpa lookup Discovery.
    if (this.targetIp) {
      try {
        const conn = await this.tcpManager.connect(this.targetIp, this.targetPort);
        if (this.closing || this.sessionReady || this.conn) {
          conn.close();
          return 'retry';
        }
        this.beginSession(conn);
        return 'connected';
      } catch {
        return 'retry';
      }
    }

    let endpoint;
    try {
      endpoint = await this.discovery.lookup(target);
    } catch {
      return 'retry';
    }

    // Tie-break: bila kedua sisi saling connect, Peer ID lebih besar yang menginisiasi.
    const mutual = endpoint.targetPeerId === this.identity.peerId;
    if (mutual && this.identity.peerId < target) {
      if (!this.mutualNoticeShown) {
        this.mutualNoticeShown = true;
        this.ui.printSystem(
          'Kedua peer saling connect: Peer ID lebih besar yang menginisiasi — menunggu koneksi masuk...'
        );
      }
      return 'wait';
    }

    try {
      const conn = await this.tcpManager.connect(endpoint.ip, endpoint.port);
      if (this.closing || this.sessionReady || this.conn) {
        conn.close();
        return 'retry';
      }
      this.beginSession(conn);
      return 'connected';
    } catch {
      return 'retry';
    }
  }

  private handleIncoming(conn: ManagedConnection): void {
    if (this.conn || this.closing) {
      // satu sesi per proses: tolak koneksi tambahan
      conn.close();
      return;
    }
    this.beginSession(conn);
  }

  private beginSession(conn: ManagedConnection): void {
    this.conn = conn;
    this.handleConnection(conn).catch((err) => void this.fatal(err));
  }

  private async handleConnection(conn: ManagedConnection): Promise<void> {
    this.ui.printSystem('Peer terhubung. Memulai handshake terautentikasi...');

    const { publicKeyBase64 } = this.crypto.initEphemeralKeyPair();

    const handshake: HandshakeMessage = {
      type: 'handshake',
      displayName: this.identity.displayName,
      peerId: this.identity.peerId,
      ephemeralKey: publicKeyBase64,
      fingerprint: this.identity.fingerprint,
      webId: this.pod?.webId,
      podUrl: this.pod?.basePodUrl,
    };
    conn.send(handshake);

    conn.on('message', (msg: AnyMessage) => {
      if (this.conn !== conn) return; // koneksi sudah ditinggalkan (mis. ditolak)
      this.handleMessage(conn, msg).catch((err) => void this.fatal(err));
    });

    conn.on('close', () => {
      if (this.conn !== conn) return;
      void this.shutdown('Koneksi ditutup.');
    });

    conn.on('error', (err: Error) => {
      if (this.conn !== conn) return;
      void this.shutdown(`Connection error: ${err.message}`);
    });
  }

  private async handleMessage(conn: ManagedConnection, msg: AnyMessage): Promise<void> {
    switch (msg.type) {
      case 'handshake':
        return this.handleHandshake(conn, msg);
      case 'identity-proof':
        return this.handleIdentityProof(conn, msg);
      case 'chat':
        return this.handleChatMessage(msg);
    }
  }

  private async handleHandshake(conn: ManagedConnection, msg: HandshakeMessage): Promise<void> {
    if (this.remotePeerId) return; // handshake hanya diproses sekali

    if (this.targetPeerId && msg.peerId !== this.targetPeerId) {
      // bukan peer yang dituju — tolak tanpa menghentikan proses (kita kembali menunggu)
      this.ui.printSystem(`Koneksi dari peer tak dikenal (fingerprint ${msg.fingerprint}) — ditolak.`);
      this.rejectConnection(conn);
      return;
    }

    this.remotePeerId = msg.peerId;
    this.remoteDisplayName = msg.displayName;
    this.remoteWebId = msg.webId ?? null;

    this.crypto.deriveTempKey(msg.ephemeralKey);
    const transcript = this.crypto.buildTranscript(msg.ephemeralKey, this.identity.peerId, msg.peerId);
    this.transcript = transcript;

    const proof = this.crypto.buildProof(this.identity.peerId, transcript, (data) => this.identity.sign(data));
    conn.send(proof);
  }

  private rejectConnection(conn: ManagedConnection): void {
    if (this.conn === conn) {
      this.conn = null;
    }
    this.remotePeerId = null;
    this.remoteDisplayName = null;
    this.remoteWebId = null;
    this.transcript = null;
    this.connecting = false;
    this.crypto.reset();
    try {
      conn.close();
    } catch {
      // koneksi mungkin sudah tertutup
    }
  }

  private async handleIdentityProof(conn: ManagedConnection, msg: IdentityProofMessage): Promise<void> {
    if (this.sessionReady) return;
    if (!this.remotePeerId || !this.transcript) {
      throw new Error('Menerima identity-proof sebelum handshake selesai.');
    }

    const { peerId, signature } = this.crypto.parseProof(msg);
    if (peerId !== this.remotePeerId) {
      throw new Error('Peer ID di dalam identity-proof tidak cocok dengan handshake.');
    }
    if (!verifyWithPeerId(peerId, Buffer.from(this.transcript, 'utf8'), signature)) {
      throw new Error('Tanda tangan identitas peer TIDAK VALID (kemungkinan man-in-the-middle).');
    }

    this.crypto.activateSessionKey(this.transcript);
    this.chatId = this.crypto.deriveChatId(this.identity.peerId, peerId);
    this.sessionReady = true;
    this.connecting = false;

    this.ui.printSystem(`Sesi aman terbentuk dengan "${this.remoteDisplayName}".`);
    this.ui.printSystem(
      `Peer terverifikasi: fingerprint ${fingerprintOf(peerId)}${
        this.remoteWebId ? ` · WebID: ${this.remoteWebId}` : ''
      }.`
    );
    this.ui.printSystem(`chat_id: ${this.chatId}`);

    const meta: ChatSessionMeta = {
      chatId: this.chatId,
      localDisplayName: this.identity.displayName,
      localPeerId: this.identity.peerId,
      localWebId: this.pod?.webId,
      remoteDisplayName: this.remoteDisplayName ?? 'unknown',
      remotePeerId: this.remotePeerId ?? '',
      remoteWebId: this.remoteWebId ?? undefined,
      startedAt: this.sessionStartedAt,
      endedAt: this.sessionStartedAt,
    };
    this.currentSessionFile = this.localStorage.initSession(this.chatId, meta);

    // 1. Muat riwayat dari disk lokal secara instan (zero-delay & offline-ready)
    this.loadHistoryFromLocal();

    // 2. Jalankan sinkronisasi awal dengan Solid Pod di latar belakang
    void this.triggerInitialSync();

    // 3. Pasang auto-sync berkala ke Solid Pod setiap 25 detik
    this.stopPeriodicSync = this.syncManager.startPeriodicSync(this.chatId, 25000, (res) => {
      if (res.pushed > 0) {
        this.ui.printSystem(`[Auto-Sync] ${res.pushed} sesi tersinkronisasi ke Solid Pod.`);
      }
      if (res.pulled > 0) {
        this.ui.printSystem(`[Auto-Sync] ${res.pulled} sesi baru ditarik dari Solid Pod.`);
      }
    });

    this.ui.printSystem('Ketik pesan lalu Enter. Perintah: /sync · /history · /quit');
  }

  private loadHistoryFromLocal(): void {
    if (!this.chatId) return;

    try {
      const priorMessages = this.localStorage.loadChatHistory(this.chatId);
      if (priorMessages.length === 0) return;

      this.ui.printSystem(`— History percakapan (${priorMessages.length} pesan) [Tersimpan Lokal] —`);
      for (const stored of priorMessages) {
        this.ui.printChat(stored.senderName, stored.timestamp, stored.text);
      }
      this.ui.printSystem('— Akhir history —');
    } catch (err: any) {
      this.ui.printSystem(`Gagal memuat history lokal: ${err.message}`);
    }
  }

  private async triggerInitialSync(): Promise<void> {
    if (!this.chatId || !this.pod) return;

    try {
      const res = await this.syncManager.sync(this.chatId);
      if (res.status === 'synced') {
        if (res.pulled > 0) {
          this.ui.printSystem(`[Sync] Menarik ${res.pulled} sesi riwayat baru dari Solid Pod.`);
        }
        if (res.pushed > 0) {
          this.ui.printSystem(`[Sync] ${res.pushed} sesi lokal tersinkronisasi ke Solid Pod.`);
        }
        if (res.pushed === 0 && res.pulled === 0) {
          this.ui.printSystem('[Sync] Riwayat lokal dan Solid Pod sudah sinkron.');
        }
      } else if (res.status === 'pod_unreachable') {
        this.ui.printSystem('[Sync] Solid Pod offline — riwayat tetap aman di disk lokal.');
      }
    } catch (err: any) {
      this.ui.printSystem(`[Sync] Gagal sinkronisasi Pod: ${err.message}`);
    }
  }

  private handleChatMessage(msg: ChatMessage): void {
    if (!this.sessionReady) {
      this.ui.printSystem('Menerima chat sebelum sesi siap. Diabaikan.');
      return;
    }

    try {
      const plaintext = this.crypto.decryptChat(msg);
      const from = this.remoteDisplayName ?? msg.from;
      this.recordHistory('received', from, plaintext, msg.timestamp, msg.seq);
      this.ui.printChat(from, msg.timestamp, plaintext);
    } catch (err: any) {
      this.ui.printSystem(`Gagal mendekripsi pesan: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Command loop pra-sesi (aktif sejak start; perintah + chat lewat satu jalur)
  // ---------------------------------------------------------------------------

  private startCommandLoop(): void {
    this.ui.startInputLoop((text) => {
      void this.handleInput(text);
    });
  }

  private async handleInput(text: string): Promise<void> {
    if (text === '/quit') {
      void this.shutdown('Keluar atas permintaan user...');
      return;
    }
    if (text === '/help') {
      this.printHelp();
      return;
    }
    if (text === '/list') {
      await this.printOnlinePeers();
      return;
    }
    if (text === '/sync') {
      await this.handleSyncCommand();
      return;
    }
    if (text === '/history') {
      this.handleHistoryCommand();
      return;
    }
    if (text === '/connect' || text.startsWith('/connect ')) {
      await this.handleConnectCommand(text);
      return;
    }

    if (!this.sessionReady) {
      this.ui.printSystem(
        'Sesi belum aktif. Gunakan /connect <nama|PeerID> untuk menghubungi user, /list untuk daftar user, /help untuk bantuan.'
      );
      return;
    }

    const conn = this.conn;
    if (!conn) return;

    const msg = this.crypto.encryptChat(this.identity.displayName, text, this.seq++);
    conn.send(msg);

    // local echo + catat ke history sesi
    this.recordHistory('sent', this.identity.displayName, text, msg.timestamp, msg.seq);
    this.ui.printChat(this.identity.displayName, msg.timestamp, text);
  }

  private printHelp(): void {
    this.ui.printSystem('Perintah yang tersedia:');
    console.log('  /connect <nama|PeerID>   Hubungi user (nama dari /list, atau Peer ID)');
    console.log('  /connect <IP> <PeerID>   Hubungi langsung tanpa Discovery (TCP langsung ke IP)');
    console.log('  /list                    Tampilkan user yang sedang online');
    console.log('  /sync                    Sinkronkan riwayat chat lokal dengan Solid Pod');
    console.log('  /history                 Tampilkan statistik riwayat percakapan lokal');
    console.log('  /help                    Tampilkan bantuan ini');
    console.log('  /quit                    Akhiri sesi & simpan history');
  }

  private async handleSyncCommand(): Promise<void> {
    if (!this.chatId) {
      this.ui.printSystem('Perintah /sync memerlukan sesi chat yang aktif.');
      return;
    }
    this.ui.printSystem('Memulai sinkronisasi manual ke Solid Pod...');
    const res = await this.syncManager.sync(this.chatId);
    if (res.status === 'synced') {
      this.ui.printSystem(
        `Sinkronisasi sukses: ${res.pushed} sesi terkirim ke Pod, ${res.pulled} sesi baru ditarik dari Pod.`
      );
    } else if (res.status === 'pod_unreachable') {
      this.ui.printSystem('Solid Pod tidak terjangkau (offline). Riwayat tetap aman di disk lokal.');
    } else if (res.status === 'pod_disabled') {
      this.ui.printSystem('Solid Pod dinonaktifkan (--no-pod). Mode penyimpanan adalah murni Local-First.');
    } else {
      this.ui.printSystem(`Sinkronisasi gagal: ${res.error}`);
    }
  }

  private handleHistoryCommand(): void {
    if (!this.chatId) {
      this.ui.printSystem('Perintah /history memerlukan sesi chat yang aktif.');
      return;
    }
    const msgs = this.localStorage.loadChatHistory(this.chatId);
    const unsynced = this.localStorage.listUnsyncedSessions(this.chatId);
    this.ui.printSystem(
      `Riwayat Lokal: ${msgs.length} total pesan tersimpan. Sesi belum disinkronkan ke Pod: ${unsynced.length}.`
    );
  }

  private async handleConnectCommand(text: string): Promise<void> {
    if (this.sessionReady) {
      this.ui.printSystem('Sesi sudah aktif — /connect hanya bisa dipakai sebelum sesi terbentuk.');
      return;
    }
    if (this.connecting) {
      this.ui.printSystem('Sedang dalam proses menghubungi peer — tunggu sebentar. (/quit untuk membatalkan)');
      return;
    }
    if (this.conn) {
      this.ui.printSystem('Sedang ada koneksi masuk/aktif — tunggu sesi terbentuk.');
      return;
    }

    const parts = text.trim().split(/\s+/).slice(1);
    if (parts.length === 0) {
      this.ui.printSystem('Penggunaan: /connect <nama|PeerID>  |  /connect <IP> <PeerID>');
      return;
    }

    if (parts.length >= 2) {
      // Direct: /connect <IP> <PeerID>
      const [ip, peerId] = parts;
      if (!isValidIpv4(ip)) {
        this.ui.printSystem(`IP tidak valid: ${ip}`);
        return;
      }
      if (!looksLikePeerId(peerId)) {
        this.ui.printSystem('Argumen kedua harus Peer ID (berawalan MCowBQYDK2Vw...).');
        return;
      }
      this.beginConnectTo(peerId, ip);
      return;
    }

    // Satu argumen: nama atau Peer ID
    const spec = parts[0];
    if (looksLikePeerId(spec)) {
      this.beginConnectTo(spec, null);
      return;
    }

    try {
      const peers = await this.discovery.listPeers();
      const resolved = pickPeerBySpec(spec, peers);
      this.beginConnectTo(resolved.peerId, null, resolved.displayName);
    } catch (err: any) {
      this.ui.printSystem(`Gagal menghubungi "${spec}": ${err.message}`);
    }
  }

  private beginConnectTo(peerId: string, ip: string | null, label?: string): void {
    this.targetPeerId = peerId;
    this.targetIp = ip;
    this.beginConnecting(ip ? `di ${ip}:${this.targetPort}` : 'via Discovery Platform', label);
  }

  private async printOnlinePeers(): Promise<void> {
    try {
      const peers = await this.discovery.listPeers();
      const others = peers.filter((peer) => peer.peerId !== this.identity.peerId);
      if (others.length === 0) {
        this.ui.printSystem('Belum ada user lain yang online di Discovery Platform.');
        return;
      }
      this.ui.printSystem(`User online (${others.length}):`);
      for (const peer of others) {
        const name = peer.displayName ?? '(tanpa nama)';
        const webIdSuffix = peer.webId ? `  (${peer.webId})` : '';
        console.log(`  • ${name}  [${fingerprintOf(peer.peerId)}]${webIdSuffix}`);
      }
      this.ui.printSystem('Hubungi dengan: /connect <nama|PeerID>');
    } catch (err: any) {
      this.ui.printSystem(`Gagal mengambil daftar user: ${err.message}`);
    }
  }

  private recordHistory(
    direction: 'sent' | 'received',
    displayName: string,
    text: string,
    timestamp: number,
    seq: number
  ): void {
    const entry: HistoryEntry = { direction, displayName, text, timestamp, seq };
    this.history.push(entry);

    // Tulis seketika ke penyimpanan disk lokal (crash-proof)
    if (this.chatId && this.currentSessionFile) {
      this.localStorage.appendMessage(this.chatId, this.currentSessionFile, entry);
    }
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    if (this.stopPeriodicSync) {
      this.stopPeriodicSync();
      this.stopPeriodicSync = null;
    }

    this.discovery.stopHeartbeat();
    this.tcpManager.closeServer();
    this.ui.printSystem(reason);

    try {
      this.conn?.close();
    } catch {
      // koneksi mungkin sudah tertutup
    }

    await this.discovery.unregister(this.identity.peerId).catch(() => undefined);

    if (this.chatId && this.currentSessionFile) {
      this.localStorage.finalizeSession(this.chatId, this.currentSessionFile, new Date().toISOString());
      if (this.history.length > 0) {
        this.ui.printSystem(`History sesi (${this.history.length} pesan) tersimpan aman di disk lokal.`);
      }
    }

    if (this.pod && this.chatId) {
      if (this.history.length > 0) {
        this.ui.printSystem('Menyinkronkan sesi ke Solid Pod...');
        try {
          const syncRes = await this.syncManager.sync(this.chatId);
          if (syncRes.status === 'synced') {
            this.ui.printSystem(`Sesi tersinkronisasi ke Solid Pod (${syncRes.pushed} sesi dikirim).`);
          } else if (syncRes.status === 'pod_unreachable') {
            this.ui.printSystem('Solid Pod offline — riwayat tetap tersimpan di lokal & akan disinkronkan nanti.');
          } else {
            this.ui.printSystem(`Sync ke Pod dilewati (${syncRes.status}).`);
          }
        } catch (err: any) {
          this.ui.printSystem(`Sinkronisasi Pod gagal: ${err.message} (riwayat tetap aman di lokal).`);
        }
      }
      // logout melepas handle internal session agar proses bisa keluar natural
      await this.pod.logout().catch(() => undefined);
    }

    await this.ui.close();
    process.exitCode = this.exitCode;

    // Jangan panggil process.exit() langsung: pada Windows, exit saat handle undici
    // (global fetch) masih menutup memicu assertion libuv. Biarkan event loop kosong
    // secara natural; timer unref ini hanya memaksa keluar jika masih ada handle tertinggal.
    const forceExit = setTimeout(() => process.exit(this.exitCode), 1000);
    forceExit.unref();
  }

  private async fatal(err: Error): Promise<void> {
    this.exitCode = 1;
    await this.shutdown(`Error: ${err.message}`);
  }

  private setupShutdownHooks(): void {
    process.on('SIGINT', () => {
      void this.shutdown('Keluar (Ctrl+C)...');
    });
    process.on('SIGTERM', () => {
      void this.shutdown('Keluar (SIGTERM)...');
    });
  }
}
