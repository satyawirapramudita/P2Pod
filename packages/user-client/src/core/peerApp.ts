// packages/user-client/src/core/peerApp.ts

import { EventEmitter } from 'events';
import * as fs from 'fs';
import { TcpConnectionManager, ManagedConnection } from '../net/tcpConnection';
import { CryptoEngine } from '../crypto/cryptoEngine';
import { TerminalUI } from '../ui/terminalUI';
import type {
  AnyMessage,
  HandshakeMessage,
  IdentityProofMessage,
  ChatMessage,
  OnlinePeer,
  ProbeResponse,
} from '@p2pod/shared';
import { Identity, fingerprintOf, verifyWithPeerId } from '../identity/identity';
import { DiscoveryClient, detectLocalIp, isPrivateIp, isValidHost, normalizePublicHost } from '../discovery/discoveryClient';
import { ChatSessionMeta, HistoryEntry, SolidClient, StoredMessage } from '../modules/pod/solidClient';
import { looksLikePeerId, pickPeerBySpec } from '../targetResolver';
import { ChatSummary, LocalStorage } from '../modules/storage/localStorage';
import { SyncAllResult, SyncManager, SyncResult } from '../modules/storage/syncManager';

export interface PeerAppOptions {
  identity: Identity;
  homeDir: string;
  discoveryUrl: string;
  podUrl?: string;
  listenPort: number;
  targetPeerId?: string;
  targetIp?: string;
  targetPort?: number;
  /** Public host/port advertised to Discovery for cross-network chat. */
  publicHost?: string;
  publicPort?: number;
  /** Optional shared secret required by a public Discovery Platform. */
  discoveryToken?: string;
  /** 'cli' (default): readline UI + exit on remote close. 'daemon': headless multi-session node. */
  mode?: 'cli' | 'daemon';
}

export interface ActiveSessionInfo {
  chatId: string;
  remotePeerId: string;
  remoteDisplayName: string;
  remoteFingerprint: string;
  remoteWebId?: string;
  startedAt: string;
  messageCount: number;
}

export interface PeerChatEvent {
  chatId: string;
  senderName: string;
  direction: 'sent' | 'received';
  text: string;
  timestamp: number;
  seq: number;
}

export interface PeerAppState {
  nodeStatus: 'stopped' | 'running';
  sessionStatus: 'idle' | 'connecting' | 'handshaking' | 'connected';
  local: {
    displayName: string;
    peerId: string;
    fingerprint: string;
    homeDir: string;
    discoveryUrl: string;
    listenPort: number;
    boundPort: number | null;
    localIp: string;
    publicHost?: string;
    publicPort?: number;
    publicEndpoint?: string;
    observedIp?: string;
  };
  pod: {
    enabled: boolean;
    reachable: boolean;
    podUrl?: string;
    webId?: string;
    authMode?: 'clientCredentials' | 'oidc';
    error?: string;
  };
  connectingTarget?: {
    peerId: string;
    fingerprint: string;
    label?: string;
    ip?: string;
    port?: number;
  };
  session: ActiveSessionInfo | null;
}

const CONNECT_RETRY_INTERVAL_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** True when the process is running inside a container (Docker/Podman). */
function isRunningInContainer(): boolean {
  if (process.env.P2POD_IN_CONTAINER === '1') return true;
  try {
    return process.platform !== 'win32' && fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

type ConnectAttemptResult = 'connected' | 'retry' | 'wait';

export class PeerApp extends EventEmitter {
  private readonly identity: Identity;
  private readonly homeDir: string;
  private readonly discoveryUrl: string;
  private readonly mode: 'cli' | 'daemon';
  private readonly tcpManager = new TcpConnectionManager();
  private readonly crypto = new CryptoEngine();
  private readonly ui: TerminalUI | null;
  private readonly discovery: DiscoveryClient;
  private readonly localStorage: LocalStorage;
  private readonly syncManager: SyncManager;
  private readonly listenPort: number;
  private readonly publicHost?: string;
  private readonly publicPort?: number;
  private targetPort: number;

  private pod: SolidClient | null = null;
  private podInitError: string | null = null;
  private podReachable = false;

  private nodeRunning = false;
  private boundPort: number | null = null;
  private localIp = '';
  private closing = false;
  private exitCode = 0;

  private targetPeerId: string | null;
  private targetIp: string | null;
  private targetLabel: string | null = null;
  private connecting = false;
  private connectGeneration = 0;
  private mutualNoticeShown = false;

  private conn: ManagedConnection | null = null;
  private seq = 1;
  private sessionReady = false;
  private remotePeerId: string | null = null;
  private remoteDisplayName: string | null = null;
  private remoteWebId: string | null = null;
  private transcript: string | null = null;
  private chatId: string | null = null;
  private currentSessionFile: string | null = null;
  private stopPeriodicSync: (() => void) | null = null;
  private history: HistoryEntry[] = [];
  private sessionStartedAt = new Date().toISOString();

  constructor(options: PeerAppOptions) {
    super();
    this.identity = options.identity;
    this.homeDir = options.homeDir;
    this.discoveryUrl = options.discoveryUrl;
    this.mode = options.mode ?? 'cli';
    this.listenPort = options.listenPort;
    this.publicHost = normalizePublicHost(options.publicHost);
    this.publicPort = options.publicPort;
    this.targetPeerId = options.targetPeerId ?? null;
    this.targetIp = options.targetIp ?? null;
    this.targetPort = options.targetPort ?? 5000;
    this.discovery = new DiscoveryClient(options.discoveryUrl, options.discoveryToken);
    this.ui =
      this.mode === 'cli'
        ? new TerminalUI(this.identity.displayName, () => {
            void this.shutdown('Input ditutup (Ctrl+D)...');
          })
        : null;

    this.initPodClient(options.podUrl);
    this.localStorage = new LocalStorage(options.homeDir);
    this.syncManager = new SyncManager(this.localStorage, this.pod);
  }

  private initPodClient(podUrl?: string): void {
    this.pod = null;
    this.podInitError = null;
    this.podReachable = false;
    if (podUrl) {
      try {
        this.pod = new SolidClient(this.homeDir, podUrl);
      } catch (err: any) {
        this.podInitError = err.message;
      }
    }
  }

  get peerId(): string {
    return this.identity.peerId;
  }

  getState(): PeerAppState {
    let sessionStatus: PeerAppState['sessionStatus'] = 'idle';
    if (this.sessionReady) {
      sessionStatus = 'connected';
    } else if (this.conn) {
      sessionStatus = 'handshaking';
    } else if (this.connecting && this.targetPeerId) {
      sessionStatus = 'connecting';
    }

    const observedIp = this.discovery.observed?.observedIp;
    const publicHost =
      this.publicHost ?? (observedIp && !isPrivateIp(observedIp) ? observedIp : undefined);
    const publicPort = publicHost
      ? this.publicPort ?? this.boundPort ?? this.listenPort
      : undefined;
    const endpointHost = publicHost?.includes(':') ? `[${publicHost}]` : publicHost;
    const publicEndpoint = endpointHost && publicPort ? `${endpointHost}:${publicPort}` : undefined;

    return {
      nodeStatus: this.nodeRunning ? 'running' : 'stopped',
      sessionStatus,
      local: {
        displayName: this.identity.displayName,
        peerId: this.identity.peerId,
        fingerprint: this.identity.fingerprint,
        homeDir: this.homeDir,
        discoveryUrl: this.discoveryUrl,
        listenPort: this.listenPort,
        boundPort: this.boundPort,
        localIp: this.localIp,
        publicHost,
        publicPort,
        publicEndpoint,
        observedIp,
      },
      pod: {
        enabled: Boolean(this.pod),
        reachable: this.podReachable,
        podUrl: this.pod?.basePodUrl,
        webId: this.pod?.webId,
        authMode: this.pod?.authMode,
        error: this.podInitError ?? undefined,
      },
      connectingTarget:
        this.connecting && this.targetPeerId
          ? {
              peerId: this.targetPeerId,
              fingerprint: fingerprintOf(this.targetPeerId),
              label: this.targetLabel ?? undefined,
              ip: this.targetIp ?? undefined,
              port: this.targetIp ? this.targetPort : undefined,
            }
          : undefined,
      session:
        this.sessionReady && this.chatId && this.remotePeerId
          ? {
              chatId: this.chatId,
              remotePeerId: this.remotePeerId,
              remoteDisplayName: this.remoteDisplayName ?? 'unknown',
              remoteFingerprint: fingerprintOf(this.remotePeerId),
              remoteWebId: this.remoteWebId ?? undefined,
              startedAt: this.sessionStartedAt,
              messageCount: this.history.length,
            }
          : null,
    };
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  private emitSystem(text: string): void {
    this.ui?.printSystem(text);
    this.emit('system', { text, timestamp: Date.now() });
  }

  private registerOpts(): {
    targetPeerId?: string;
    displayName: string;
    webId?: string;
    publicHost?: string;
    publicPort?: number;
  } {
    return {
      targetPeerId: this.targetPeerId ?? undefined,
      displayName: this.identity.displayName,
      webId: this.pod?.webId,
      publicHost: this.publicHost,
      publicPort: this.publicPort,
    };
  }

  private async refreshDiscoveryRegistration(): Promise<void> {
    if (!this.nodeRunning || this.boundPort === null) return;
    const opts = this.registerOpts();
    await this.discovery.register(this.identity.peerId, this.boundPort, opts).catch(() => undefined);
    this.discovery.startHeartbeat(this.identity.peerId, this.boundPort, opts);
  }

  /**
   * Warn when the endpoint advertised to Discovery is unreachable from other
   * machines — the classic Docker case where the app reports its container IP
   * (e.g. 172.22.0.3) instead of the host's LAN/public address.
   */
  private warnIfEndpointUnreachable(): void {
    if (this.publicHost) return;
    const observed = this.discovery.observed;
    if (!observed || !observed.ip) return;
    if (!isPrivateIp(observed.ip)) return;
    if (!isRunningInContainer()) return;
    this.emitSystem(
      `⚠ Endpoint yang diiklankan (${observed.ip}:${observed.port}) adalah alamat di dalam container Docker — ` +
        'peer di perangkat lain tidak akan bisa menjangkaunya. Set P2P_PUBLIC_HOST (atau --public-host) ke IP host ' +
        'yang dapat dijangkau: IP LAN untuk satu jaringan, atau IP publik/DNS untuk lintas jaringan.'
    );
  }

  /**
   * Nyalakan node P2P (TCP listener, registrasi Discovery, cek Solid Pod).
   * Bisa dipakai langsung oleh mode daemon (WebBridge) maupun oleh `start()` CLI.
   */
  async startNode(): Promise<void> {
    if (this.nodeRunning) return;
    this.closing = false;

    const boundPort = await this.tcpManager.listen(this.listenPort, (conn) => this.handleIncoming(conn));
    this.boundPort = boundPort;
    this.nodeRunning = true;
    this.emitSystem(`Mendengarkan koneksi TCP di port ${boundPort}.`);

    this.localIp = await detectLocalIp(this.discoveryUrl).catch(() => '');

    const registerOpts = this.registerOpts();
    try {
      await this.discovery.register(this.identity.peerId, boundPort, registerOpts);
      this.emitSystem('Terdaftar di Discovery Platform.');
      this.warnIfEndpointUnreachable();
    } catch (err: any) {
      this.emitSystem(`⚠ Discovery Platform belum terjangkau: ${err.message}. Node tetap berjalan dan akan mencoba ulang.`);
    }
    this.discovery.startHeartbeat(this.identity.peerId, boundPort, registerOpts);

    this.emitSystem('Penyimpanan: Local-First aktif (pesan langsung disimpan ke disk lokal).');
    await this.checkAndLinkPod();
    this.emitState();
  }

  private async checkAndLinkPod(): Promise<void> {
    if (this.podInitError) {
      this.podReachable = false;
      this.emitSystem(`⚠ Solid Pod: ${this.podInitError} (sinkronisasi cloud dinonaktifkan).`);
      return;
    }
    if (!this.pod) {
      this.podReachable = false;
      return;
    }

    const reachable = await this.pod.ping();
    this.podReachable = reachable;
    if (!reachable) {
      this.emitSystem('⚠ Solid Pod offline/tidak terjangkau — sinkronisasi akan ditunda sampai Pod online.');
    } else {
      await this.pod.linkIdentity(this.identity).catch(() => undefined);
      this.emitSystem(`Solid Pod terhubung (${this.pod.basePodUrl}) — sinkronisasi cloud siap.`);
    }
  }

  /**
   * Reload SolidClient setelah login/re-konfigurasi Pod dari Web UI tanpa me-restart node.
   */
  async reloadPod(podUrl?: string): Promise<void> {
    if (this.pod) {
      await this.pod.logout().catch(() => undefined);
    }
    this.initPodClient(podUrl);
    this.syncManager.setPodClient(this.pod);
    await this.checkAndLinkPod();
    await this.refreshDiscoveryRegistration();
    this.emitState();
  }

  /**
   * Mode online CLI: nyalakan node, aktifkan command loop readline, lalu tunggu shutdown.
   */
  async start(): Promise<void> {
    this.setupShutdownHooks();
    await this.startNode();

    this.emitSystem('Perintah: /connect <nama|PeerID> · /list · /help · /quit');
    this.startCommandLoop();

    if (this.targetPeerId || this.targetIp) {
      this.beginConnecting(this.targetIp ? `di ${this.targetIp}:${this.targetPort}` : 'via Discovery Platform');
    } else {
      this.emitSystem(
        'Menunggu koneksi masuk... (ketik /connect untuk menghubungi user lain, /list untuk daftar user)'
      );
    }

    await new Promise<void>(() => {
      // tetap hidup sampai sinyal shutdown
    });
  }

  // ---------------------------------------------------------------------------
  // API Sesi Publik (dipakai oleh CLI & WebBridge)
  // ---------------------------------------------------------------------------

  async connectTo(target: { peerId: string; label?: string; ip?: string; port?: number }): Promise<void> {
    if (!this.nodeRunning || this.closing) {
      throw new Error('Node P2Pod belum berjalan.');
    }
    if (target.peerId === this.identity.peerId) {
      throw new Error('Tidak dapat menghubungi Peer ID sendiri.');
    }
    const normalizedTargetIp = target.ip?.trim().replace(/^\[|\]$/g, '');
    if (normalizedTargetIp && !isValidHost(normalizedTargetIp)) {
      throw new Error(`Host/IP tidak valid: ${target.ip}`);
    }

    // Jika sudah terhubung dengan peer yang sama, tidak perlu reconnect
    if (this.sessionReady && this.remotePeerId === target.peerId) {
      return;
    }

    // Putus sesi sebelumnya (jika ada) sebelum membuka koneksi baru
    if (this.conn || this.sessionReady) {
      await this.disconnectSession('Berpindah ke peer lain...');
    }

    this.cancelConnect();
    this.targetPeerId = target.peerId;
    this.targetIp = normalizedTargetIp || null;
    this.targetLabel = target.label ?? null;
    if (target.port !== undefined) {
      this.targetPort = target.port;
    }

    await this.refreshDiscoveryRegistration();
    this.beginConnecting(
      this.targetIp ? `di ${this.targetIp}:${this.targetPort}` : 'via Discovery Platform',
      target.label
    );
  }

  cancelConnect(): void {
    this.connectGeneration++;
    const wasConnecting = this.connecting || this.targetPeerId !== null;
    this.connecting = false;
    this.targetPeerId = null;
    this.targetIp = null;
    this.targetLabel = null;
    this.mutualNoticeShown = false;
    if (wasConnecting) {
      void this.refreshDiscoveryRegistration();
      this.emitState();
    }
  }

  async disconnectSession(reason = 'Sesi diputus.'): Promise<void> {
    const hadSession = Boolean(this.conn || this.sessionReady || this.chatId);
    if (!hadSession) {
      if (this.connecting) this.cancelConnect();
      return;
    }

    const activeConn = this.conn;
    const endedChatId = this.chatId;
    const sessionFile = this.currentSessionFile;
    const messageCount = this.history.length;

    // Lepaskan referensi conn sebelum close() agar event 'close' tidak re-enter
    this.conn = null;
    if (this.stopPeriodicSync) {
      this.stopPeriodicSync();
      this.stopPeriodicSync = null;
    }

    try {
      activeConn?.close();
    } catch {
      // koneksi mungkin sudah tertutup
    }

    if (endedChatId && sessionFile) {
      this.localStorage.finalizeSession(endedChatId, sessionFile, new Date().toISOString());
      if (messageCount > 0) {
        this.emitSystem(`History sesi (${messageCount} pesan) tersimpan aman di disk lokal.`);
      }
    }

    if (this.pod && endedChatId && messageCount > 0) {
      this.emitSystem('Menyinkronkan sesi ke Solid Pod...');
      try {
        const syncRes = await this.syncManager.sync(endedChatId);
        this.emit('sync', { chatId: endedChatId, ...syncRes });
        if (syncRes.status === 'synced') {
          this.podReachable = true;
          this.emitSystem(`Sesi tersinkronisasi ke Solid Pod (${syncRes.pushed} sesi dikirim).`);
        } else if (syncRes.status === 'pod_unreachable') {
          this.podReachable = false;
          this.emitSystem('Solid Pod offline — riwayat tetap tersimpan di lokal & akan disinkronkan nanti.');
        } else {
          this.emitSystem(`Sync ke Pod dilewati (${syncRes.status}).`);
        }
      } catch (err: any) {
        this.emitSystem(`Sinkronisasi Pod gagal: ${err.message} (riwayat tetap aman di lokal).`);
      }
    }

    this.resetSessionState();
    if (!this.closing) {
      await this.refreshDiscoveryRegistration();
    }
    this.emitSystem(reason);
    this.emit('sessionClosed', { reason, chatId: endedChatId });
    this.emitState();
  }

  private resetSessionState(): void {
    this.connectGeneration++;
    this.conn = null;
    this.seq = 1;
    this.sessionReady = false;
    this.connecting = false;
    this.targetPeerId = null;
    this.targetIp = null;
    this.targetLabel = null;
    this.mutualNoticeShown = false;
    this.remotePeerId = null;
    this.remoteDisplayName = null;
    this.remoteWebId = null;
    this.transcript = null;
    this.chatId = null;
    this.currentSessionFile = null;
    this.history = [];
    this.sessionStartedAt = new Date().toISOString();
    this.crypto.reset();
  }

  sendChat(text: string): PeerChatEvent {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Pesan tidak boleh kosong.');
    }
    if (!this.sessionReady || !this.conn || !this.chatId) {
      throw new Error('Sesi chat belum aktif.');
    }

    const msg = this.crypto.encryptChat(this.identity.displayName, trimmed, this.seq++);
    this.conn.send(msg);

    this.recordHistory('sent', this.identity.displayName, trimmed, msg.timestamp, msg.seq);
    this.ui?.printChat(this.identity.displayName, msg.timestamp, trimmed);

    const event: PeerChatEvent = {
      chatId: this.chatId,
      senderName: this.identity.displayName,
      direction: 'sent',
      text: trimmed,
      timestamp: msg.timestamp,
      seq: msg.seq,
    };
    this.emit('message', event);
    this.emitState();
    return event;
  }

  async getOnlinePeers(): Promise<OnlinePeer[]> {
    const peers = await this.discovery.listPeers();
    return peers.filter((peer) => peer.peerId !== this.identity.peerId);
  }

  async probePublicEndpoint(): Promise<ProbeResponse> {
    return this.discovery.probe(this.identity.peerId);
  }

  listChats(): ChatSummary[] {
    return this.localStorage.listAllChats();
  }

  getChatMessages(chatId: string): StoredMessage[] {
    return this.localStorage.loadChatHistory(chatId);
  }

  getChatStats(chatId: string): { totalMessages: number; unsyncedSessions: number } {
    const msgs = this.localStorage.loadChatHistory(chatId);
    const unsynced = this.localStorage.listUnsyncedSessions(chatId);
    return { totalMessages: msgs.length, unsyncedSessions: unsynced.length };
  }

  async syncChat(chatId?: string): Promise<SyncResult> {
    const targetChatId = chatId ?? this.chatId;
    if (!targetChatId) {
      return { status: 'error', pushed: 0, pulled: 0, error: 'Tidak ada chatId yang ditentukan.' };
    }
    const res = await this.syncManager.sync(targetChatId);
    if (res.status === 'synced') this.podReachable = true;
    if (res.status === 'pod_unreachable') this.podReachable = false;
    this.emit('sync', { chatId: targetChatId, ...res });
    this.emitState();
    return res;
  }

  async syncAllChats(): Promise<SyncAllResult> {
    const res = await this.syncManager.syncAll();
    if (res.status === 'synced') this.podReachable = true;
    if (res.status === 'pod_unreachable') this.podReachable = false;
    this.emit('sync', { ...res });
    this.emitState();
    return res;
  }

  /**
   * Matikan node dengan bersih (tanpa memanggil process.exit).
   */
  async stopNode(reason = 'Node dihentikan.'): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.connectGeneration++;

    const hadSession = Boolean(this.conn || this.sessionReady || this.chatId);
    if (hadSession) {
      await this.disconnectSession(reason);
    } else {
      if (this.connecting) this.cancelConnect();
      this.emitSystem(reason);
    }

    this.discovery.stopHeartbeat();
    this.tcpManager.closeServer();
    this.nodeRunning = false;
    this.boundPort = null;

    await this.discovery.unregister(this.identity.peerId).catch(() => undefined);

    if (this.pod) {
      await this.pod.logout().catch(() => undefined);
    }

    if (this.ui) {
      await this.ui.close();
    }
    this.emitState();
  }

  // ---------------------------------------------------------------------------
  // Internal Connection & Handshake
  // ---------------------------------------------------------------------------

  private beginConnecting(viaText: string, label?: string): void {
    if (!this.targetPeerId || this.closing) return;
    const gen = ++this.connectGeneration;
    this.connecting = true;
    this.mutualNoticeShown = false;
    const who = label ? `"${label}" ` : '';
    this.emitSystem(
      `Menghubungi ${who}target fingerprint ${fingerprintOf(this.targetPeerId)} ${viaText} — dicoba berkala sampai online...`
    );
    this.emitState();
    void this.startConnectWatcher(gen, this.targetPeerId);
  }

  private async startConnectWatcher(gen: number, target: string): Promise<void> {
    let attempt = 0;

    while (!this.closing && !this.sessionReady && gen === this.connectGeneration) {
      attempt++;

      if (!this.conn) {
        const result = await this.tryConnectOnce(target, gen);
        if (result === 'connected') break;
        if (gen !== this.connectGeneration) break;
        if (result === 'retry' && (attempt === 1 || attempt % 5 === 0)) {
          this.emitSystem(`Menunggu peer online... (percobaan ${attempt})`);
        }
      }

      await delay(CONNECT_RETRY_INTERVAL_MS);
    }
  }

  private async tryConnectOnce(target: string, gen: number): Promise<ConnectAttemptResult> {
    if (gen !== this.connectGeneration) return 'wait';

    if (this.targetIp) {
      try {
        const conn = await this.tcpManager.connect(this.targetIp, this.targetPort);
        if (this.closing || this.sessionReady || this.conn || gen !== this.connectGeneration) {
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

    if (gen !== this.connectGeneration) return 'wait';

    // Tie-break: bila kedua sisi saling connect, Peer ID lebih besar yang menginisiasi.
    const mutual = endpoint.targetPeerId === this.identity.peerId;
    if (mutual && this.identity.peerId < target) {
      if (!this.mutualNoticeShown) {
        this.mutualNoticeShown = true;
        this.emitSystem(
          'Kedua peer saling connect: Peer ID lebih besar yang menginisiasi — menunggu koneksi masuk...'
        );
      }
      return 'wait';
    }

    try {
      const conn = await this.tcpManager.connect(endpoint.ip, endpoint.port);
      if (this.closing || this.sessionReady || this.conn || gen !== this.connectGeneration) {
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
      // satu sesi aktif per node: tolak koneksi tambahan
      conn.close();
      return;
    }
    this.beginSession(conn);
  }

  private beginSession(conn: ManagedConnection): void {
    this.conn = conn;
    this.seq = 1;
    this.history = [];
    this.sessionStartedAt = new Date().toISOString();
    this.emitState();
    this.handleConnection(conn).catch((err) => void this.handleSessionFatal(err));
  }

  private async handleConnection(conn: ManagedConnection): Promise<void> {
    this.emitSystem('Peer terhubung. Memulai handshake terautentikasi...');

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
      if (this.conn !== conn) return;
      this.handleMessage(conn, msg).catch((err) => void this.handleSessionFatal(err));
    });

    conn.on('close', () => {
      if (this.conn !== conn) return;
      if (this.mode === 'cli') {
        void this.shutdown('Koneksi ditutup.');
      } else {
        void this.disconnectSession('Koneksi ditutup oleh peer.');
      }
    });

    conn.on('error', (err: Error) => {
      if (this.conn !== conn) return;
      if (this.mode === 'cli') {
        void this.shutdown(`Connection error: ${err.message}`);
      } else {
        void this.disconnectSession(`Connection error: ${err.message}`);
      }
    });
  }

  private async handleSessionFatal(err: Error): Promise<void> {
    if (this.mode === 'cli') {
      await this.fatal(err);
    } else {
      await this.disconnectSession(`Error sesi: ${err.message}`);
    }
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
    if (this.remotePeerId) return;

    if (this.targetPeerId && msg.peerId !== this.targetPeerId) {
      this.emitSystem(`Koneksi dari peer tak dikenal (fingerprint ${msg.fingerprint}) — ditolak.`);
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
    this.crypto.reset();
    try {
      conn.close();
    } catch {
      // koneksi mungkin sudah tertutup
    }
    this.emitState();
  }

  private async handleIdentityProof(_conn: ManagedConnection, msg: IdentityProofMessage): Promise<void> {
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
    this.connectGeneration++;

    this.emitSystem(`Sesi aman terbentuk dengan "${this.remoteDisplayName}".`);
    this.emitSystem(
      `Peer terverifikasi: fingerprint ${fingerprintOf(peerId)}${
        this.remoteWebId ? ` · WebID: ${this.remoteWebId}` : ''
      }.`
    );
    this.emitSystem(`chat_id: ${this.chatId}`);

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
    const activeChatId = this.chatId;
    this.stopPeriodicSync = this.syncManager.startPeriodicSync(activeChatId, 25000, (res) => {
      this.emit('sync', { chatId: activeChatId, ...res });
      if (res.pushed > 0) {
        this.emitSystem(`[Auto-Sync] ${res.pushed} sesi tersinkronisasi ke Solid Pod.`);
      }
      if (res.pulled > 0) {
        this.emitSystem(`[Auto-Sync] ${res.pulled} sesi baru ditarik dari Solid Pod.`);
      }
    });

    const sessionInfo = this.getState().session;
    if (sessionInfo) {
      this.emit('sessionStarted', sessionInfo);
    }
    this.emitState();

    if (this.mode === 'cli') {
      this.emitSystem('Ketik pesan lalu Enter. Perintah: /sync · /history · /quit');
    }
  }

  private loadHistoryFromLocal(): void {
    if (!this.chatId) return;

    try {
      const priorMessages = this.localStorage.loadChatHistory(this.chatId);
      this.emit('historyLoaded', { chatId: this.chatId, messages: priorMessages });
      if (priorMessages.length === 0) return;

      if (this.ui) {
        this.ui.printSystem(`— History percakapan (${priorMessages.length} pesan) [Tersimpan Lokal] —`);
        for (const stored of priorMessages) {
          this.ui.printChat(stored.senderName, stored.timestamp, stored.text);
        }
        this.ui.printSystem('— Akhir history —');
      }
    } catch (err: any) {
      this.emitSystem(`Gagal memuat history lokal: ${err.message}`);
    }
  }

  private async triggerInitialSync(): Promise<void> {
    if (!this.chatId || !this.pod) return;

    try {
      const chatId = this.chatId;
      const res = await this.syncManager.sync(chatId);
      this.emit('sync', { chatId, ...res });
      if (res.status === 'synced') {
        this.podReachable = true;
        if (res.pulled > 0) {
          this.emitSystem(`[Sync] Menarik ${res.pulled} sesi riwayat baru dari Solid Pod.`);
          this.emit('historyLoaded', { chatId, messages: this.localStorage.loadChatHistory(chatId) });
        }
        if (res.pushed > 0) {
          this.emitSystem(`[Sync] ${res.pushed} sesi lokal tersinkronisasi ke Solid Pod.`);
        }
        if (res.pushed === 0 && res.pulled === 0) {
          this.emitSystem('[Sync] Riwayat lokal dan Solid Pod sudah sinkron.');
        }
      } else if (res.status === 'pod_unreachable') {
        this.podReachable = false;
        this.emitSystem('[Sync] Solid Pod offline — riwayat tetap aman di disk lokal.');
      }
      this.emitState();
    } catch (err: any) {
      this.emitSystem(`[Sync] Gagal sinkronisasi Pod: ${err.message}`);
    }
  }

  private handleChatMessage(msg: ChatMessage): void {
    if (!this.sessionReady || !this.chatId) {
      this.emitSystem('Menerima chat sebelum sesi siap. Diabaikan.');
      return;
    }

    try {
      const plaintext = this.crypto.decryptChat(msg);
      const from = this.remoteDisplayName ?? msg.from;
      this.recordHistory('received', from, plaintext, msg.timestamp, msg.seq);
      this.ui?.printChat(from, msg.timestamp, plaintext);

      const event: PeerChatEvent = {
        chatId: this.chatId,
        senderName: from,
        direction: 'received',
        text: plaintext,
        timestamp: msg.timestamp,
        seq: msg.seq,
      };
      this.emit('message', event);
      this.emitState();
    } catch (err: any) {
      this.emitSystem(`Gagal mendekripsi pesan: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Command loop CLI (hanya aktif pada mode 'cli')
  // ---------------------------------------------------------------------------

  private startCommandLoop(): void {
    this.ui?.startInputLoop((text) => {
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
      this.emitSystem(
        'Sesi belum aktif. Gunakan /connect <nama|PeerID> untuk menghubungi user, /list untuk daftar user, /help untuk bantuan.'
      );
      return;
    }

    try {
      this.sendChat(text);
    } catch (err: any) {
      this.emitSystem(`Gagal mengirim pesan: ${err.message}`);
    }
  }

  private printHelp(): void {
    this.emitSystem('Perintah yang tersedia:');
    console.log('  /connect <nama|PeerID>   Hubungi user (nama dari /list, atau Peer ID)');
    console.log('  /connect <host> <PeerID> Hubungi langsung tanpa Discovery (TCP langsung ke host/IP)');
    console.log('  /list                    Tampilkan user yang sedang online');
    console.log('  /sync                    Sinkronkan riwayat chat lokal dengan Solid Pod');
    console.log('  /history                 Tampilkan statistik riwayat percakapan lokal');
    console.log('  /help                    Tampilkan bantuan ini');
    console.log('  /quit                    Akhiri sesi & simpan history');
  }

  private async handleSyncCommand(): Promise<void> {
    if (!this.chatId) {
      this.emitSystem('Perintah /sync memerlukan sesi chat yang aktif.');
      return;
    }
    this.emitSystem('Memulai sinkronisasi manual ke Solid Pod...');
    const res = await this.syncChat(this.chatId);
    if (res.status === 'synced') {
      this.emitSystem(
        `Sinkronisasi sukses: ${res.pushed} sesi terkirim ke Pod, ${res.pulled} sesi baru ditarik dari Pod.`
      );
    } else if (res.status === 'pod_unreachable') {
      this.emitSystem('Solid Pod tidak terjangkau (offline). Riwayat tetap aman di disk lokal.');
    } else if (res.status === 'pod_disabled') {
      this.emitSystem('Solid Pod dinonaktifkan (--no-pod). Mode penyimpanan adalah murni Local-First.');
    } else {
      this.emitSystem(`Sinkronisasi gagal: ${res.error}`);
    }
  }

  private handleHistoryCommand(): void {
    if (!this.chatId) {
      this.emitSystem('Perintah /history memerlukan sesi chat yang aktif.');
      return;
    }
    const { totalMessages, unsyncedSessions } = this.getChatStats(this.chatId);
    this.emitSystem(
      `Riwayat Lokal: ${totalMessages} total pesan tersimpan. Sesi belum disinkronkan ke Pod: ${unsyncedSessions}.`
    );
  }

  private async handleConnectCommand(text: string): Promise<void> {
    if (this.sessionReady) {
      this.emitSystem('Sesi sudah aktif — /connect hanya bisa dipakai sebelum sesi terbentuk.');
      return;
    }
    if (this.connecting) {
      this.emitSystem('Sedang dalam proses menghubungi peer — tunggu sebentar. (/quit untuk membatalkan)');
      return;
    }
    if (this.conn) {
      this.emitSystem('Sedang ada koneksi masuk/aktif — tunggu sesi terbentuk.');
      return;
    }

    const parts = text.trim().split(/\s+/).slice(1);
    if (parts.length === 0) {
      this.emitSystem('Penggunaan: /connect <nama|PeerID>  |  /connect <host/IP> <PeerID>');
      return;
    }

    if (parts.length >= 2) {
      const [ip, peerId] = parts;
      if (!isValidHost(ip)) {
        this.emitSystem(`Host/IP tidak valid: ${ip}`);
        return;
      }
      if (!looksLikePeerId(peerId)) {
        this.emitSystem('Argumen kedua harus Peer ID (berawalan MCowBQYDK2Vw...).');
        return;
      }
      await this.connectTo({ peerId, ip });
      return;
    }

    const spec = parts[0];
    if (looksLikePeerId(spec)) {
      await this.connectTo({ peerId: spec });
      return;
    }

    try {
      const peers = await this.discovery.listPeers();
      const resolved = pickPeerBySpec(spec, peers);
      await this.connectTo({ peerId: resolved.peerId, label: resolved.displayName });
    } catch (err: any) {
      this.emitSystem(`Gagal menghubungi "${spec}": ${err.message}`);
    }
  }

  private async printOnlinePeers(): Promise<void> {
    try {
      const others = await this.getOnlinePeers();
      if (others.length === 0) {
        this.emitSystem('Belum ada user lain yang online di Discovery Platform.');
        return;
      }
      this.emitSystem(`User online (${others.length}):`);
      for (const peer of others) {
        const name = peer.displayName ?? '(tanpa nama)';
        const webIdSuffix = peer.webId ? `  (${peer.webId})` : '';
        console.log(`  • ${name}  [${fingerprintOf(peer.peerId)}]${webIdSuffix}`);
      }
      this.emitSystem('Hubungi dengan: /connect <nama|PeerID>');
    } catch (err: any) {
      this.emitSystem(`Gagal mengambil daftar user: ${err.message}`);
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

    if (this.chatId && this.currentSessionFile) {
      this.localStorage.appendMessage(this.chatId, this.currentSessionFile, entry);
    }
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.closing) return;
    await this.stopNode(reason);

    process.exitCode = this.exitCode;
    // Biarkan event loop kosong secara natural (menghindari assertion libuv undici di Windows)
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
