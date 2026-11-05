// src/core/peerApp.ts

import { TcpConnectionManager, ManagedConnection } from '../net/tcpConnection';
import { CryptoEngine } from '../crypto/cryptoEngine';
import { TerminalUI } from '../ui/terminalUI';
import { AnyMessage, HandshakeMessage, IdentityProofMessage, ChatMessage } from '../types/messages';
import { Identity, fingerprintOf, verifyWithPeerId } from '../identity/identity';
import { DiscoveryClient } from '../discovery/discoveryClient';
import { ChatSessionMeta, HistoryEntry, SolidClient } from '../pod/solidClient';

export interface PeerAppOptions {
  identity: Identity;
  homeDir: string;
  discoveryUrl: string;
  podUrl?: string;
  listenPort: number;
  targetPeerId?: string;
}

const CONNECT_RETRY_INTERVAL_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

export class PeerApp {
  private readonly identity: Identity;
  private readonly tcpManager = new TcpConnectionManager();
  private readonly crypto = new CryptoEngine();
  private readonly ui: TerminalUI;
  private readonly discovery: DiscoveryClient;
  private readonly pod: SolidClient | null;
  private readonly listenPort: number;
  private readonly targetPeerId: string | null;

  private conn: ManagedConnection | null = null;
  private seq = 1;
  private sessionReady = false;
  private closing = false;
  private exitCode = 0;

  private remotePeerId: string | null = null;
  private remoteDisplayName: string | null = null;
  private transcript: string | null = null;
  private chatId: string | null = null;
  private history: HistoryEntry[] = [];
  private readonly sessionStartedAt = new Date().toISOString();

  constructor(options: PeerAppOptions) {
    this.identity = options.identity;
    this.listenPort = options.listenPort;
    this.targetPeerId = options.targetPeerId ?? null;
    this.discovery = new DiscoveryClient(options.discoveryUrl);
    this.ui = new TerminalUI(this.identity.displayName, () => {
      void this.shutdown('Input ditutup (Ctrl+D)...');
    });
    this.pod = options.podUrl ? new SolidClient(options.homeDir, options.podUrl) : null;
  }

  get peerId(): string {
    return this.identity.peerId;
  }

  /**
   * Mode online (semua peran sama): dengarkan koneksi TCP, daftar ke Discovery Platform,
   * lalu (bila ada target) hubungi target secara berkala sampai online — urutan start bebas.
   */
  async start(): Promise<void> {
    this.setupShutdownHooks();

    const boundPort = await this.tcpManager.listen(this.listenPort, (conn) => this.handleIncoming(conn));
    this.ui.printSystem(`Mendengarkan koneksi TCP di port ${boundPort}.`);

    await this.discovery.register(this.identity.peerId, boundPort, this.targetPeerId ?? undefined);
    this.discovery.startHeartbeat(this.identity.peerId, boundPort, this.targetPeerId ?? undefined);
    this.ui.printSystem('Terdaftar di Discovery Platform (urutan start bebas).');
    this.ui.printSystem('Peer ID Anda (bisa diberikan ke peer mana pun):');
    console.log(`  ${this.identity.peerId}`);
    this.ui.printSystem(`Fingerprint: ${this.identity.fingerprint}`);

    if (this.targetPeerId) {
      this.ui.printSystem(
        `Akan menghubungi peer dengan fingerprint ${fingerprintOf(this.targetPeerId)} — dicoba berkala sampai online...`
      );
      void this.runConnectWatcher();
    } else {
      this.ui.printSystem('Menunggu koneksi masuk...');
    }

    await new Promise<void>(() => {
      // tetap hidup sampai sesi terbentuk / sinyal shutdown
    });
  }

  /** Watcher: cari target di discovery secara berkala, lalu inisiasi koneksi (atau tunggu bila tie-break). */
  private async runConnectWatcher(): Promise<void> {
    const target = this.targetPeerId!;
    let attempt = 0;

    while (!this.closing && !this.sessionReady) {
      attempt++;

      if (!this.conn) {
        try {
          const endpoint = await this.discovery.lookup(target);

          // Tie-break: bila kedua sisi saling --connect, Peer ID lebih besar yang menginisiasi.
          const mutual = endpoint.targetPeerId === this.identity.peerId;
          const iAmInitiator = this.identity.peerId > target;

          if (mutual && !iAmInitiator) {
            if (attempt === 1) {
              this.ui.printSystem(
                'Kedua peer saling --connect: Peer ID lebih besar yang menginisiasi. Menunggu koneksi masuk...'
              );
            }
          } else {
            try {
              const conn = await this.tcpManager.connect(endpoint.ip, endpoint.port);
              if (this.closing || this.sessionReady || this.conn) {
                conn.close(); // sudah ada koneksi/sesi lain — batalkan outbound ini
              } else {
                this.beginSession(conn);
                return;
              }
            } catch {
              // konek gagal (peer mungkin baru saja keluar) — coba lagi pada iterasi berikutnya
            }
          }
        } catch {
          if (attempt === 1 || attempt % 5 === 0) {
            this.ui.printSystem(`Menunggu peer online... (percobaan ${attempt})`);
          }
        }
      }

      await delay(CONNECT_RETRY_INTERVAL_MS);
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
    this.transcript = null;
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

    this.ui.printSystem(`Sesi aman terbentuk dengan "${this.remoteDisplayName}".`);
    this.ui.printSystem(`Peer terverifikasi: fingerprint ${fingerprintOf(peerId)}.`);
    this.ui.printSystem(`chat_id: ${this.chatId}`);

    await this.loadHistoryFromPod();
    this.startChatLoop(conn);
  }

  private async loadHistoryFromPod(): Promise<void> {
    if (!this.pod || !this.chatId) return;

    try {
      const priorMessages = await this.pod.loadChatSession(this.chatId);
      if (priorMessages.length === 0) return;

      this.ui.printSystem(`— History sebelumnya dari Solid Pod (${priorMessages.length} pesan) —`);
      for (const stored of priorMessages) {
        this.ui.printChat(stored.senderName, stored.timestamp, stored.text);
      }
      this.ui.printSystem('— Akhir history —');
    } catch (err: any) {
      this.ui.printSystem(`Gagal memuat history dari Pod: ${err.message}`);
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

  private startChatLoop(conn: ManagedConnection): void {
    this.ui.printSystem('Ketik pesan lalu Enter. /quit untuk mengakhiri sesi.');

    this.ui.startInputLoop((text) => {
      if (text === '/quit') {
        void this.shutdown('Keluar atas permintaan user...');
        return;
      }

      if (!this.sessionReady) {
        this.ui.printSystem('Sesi belum siap.');
        return;
      }

      const msg = this.crypto.encryptChat(this.identity.displayName, text, this.seq++);
      conn.send(msg);

      // local echo + catat ke history sesi
      this.recordHistory('sent', this.identity.displayName, text, msg.timestamp, msg.seq);
      this.ui.printChat(this.identity.displayName, msg.timestamp, text);
    });
  }

  private recordHistory(
    direction: 'sent' | 'received',
    displayName: string,
    text: string,
    timestamp: number,
    seq: number
  ): void {
    this.history.push({ direction, displayName, text, timestamp, seq });
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    this.discovery.stopHeartbeat();
    this.tcpManager.closeServer();
    this.ui.printSystem(reason);

    try {
      this.conn?.close();
    } catch {
      // koneksi mungkin sudah tertutup
    }

    await this.discovery.unregister(this.identity.peerId).catch(() => undefined);

    if (this.pod) {
      if (this.chatId && this.history.length > 0) {
        this.ui.printSystem('Menyimpan history sesi ke Solid Pod...');
        try {
          const meta: ChatSessionMeta = {
            chatId: this.chatId,
            localDisplayName: this.identity.displayName,
            localPeerId: this.identity.peerId,
            remoteDisplayName: this.remoteDisplayName ?? 'unknown',
            remotePeerId: this.remotePeerId ?? '',
            startedAt: this.sessionStartedAt,
            endedAt: new Date().toISOString(),
          };
          const savedFile = await this.pod.saveChatSession(this.chatId, meta, this.history);
          this.ui.printSystem(`History tersimpan di Pod (${savedFile}).`);
        } catch (err: any) {
          this.ui.printSystem(`Gagal menyimpan history ke Pod: ${err.message}`);
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
