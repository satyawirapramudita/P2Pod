// packages/user-client/src/web/webBridge.ts
// Local-only HTTP + WebSocket bridge (127.0.0.1) antara browser Web UI dan PeerApp daemon.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { PeerApp, PeerAppState, PeerChatEvent } from '../core/peerApp';
import { Identity, fingerprintOf } from '../identity/identity';
import { loadConfig } from '../config';
import { setActiveProfile } from '../activeProfile';
import { profileName, scanProfiles } from '../profiles';
import { ensureLocalCssRunning, localCssPortOf, podNameFromDisplayName } from '../modules/pod/provision';
import {
  DEFAULT_SOLID_ISSUER,
  loginWithSolidAccount,
  loginWithSolidBrowser,
  normalizeIssuerUrl,
} from '../modules/pod/solidAuth';
import { linkAndPersistPod } from '../podCli';

export interface WebBridgeOptions {
  homeDir: string;
  displayName?: string;
  discoveryUrl?: string;
  listenPort?: number;
  podUrl?: string;
  podDisabled?: boolean;
  /** Port HTTP/WS lokal (default 3333, fallback otomatis hingga +9 bila terpakai). */
  uiPort?: number;
  /** Direktori hasil build statis frontend (opsional, mis. packages/web-ui/dist). */
  staticDir?: string;
}

export interface SystemLogEntry {
  text: string;
  timestamp: number;
}

const MAX_LOG_ENTRIES = 200;
const MAX_JSON_BODY_BYTES = 256 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function isAllowedLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        reject(new Error('Payload terlalu besar.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('Body JSON harus berupa object.'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('Format JSON tidak valid.'));
      }
    });

    req.on('error', reject);
  });
}

function listenLocalServer(
  server: http.Server,
  preferredPort: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const maxAttempts = preferredPort === 0 ? 1 : 10;
    let attempt = 0;

    const tryPort = (port: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempt + 1 < maxAttempts) {
          attempt++;
          tryPort(preferredPort + attempt);
        } else {
          reject(err);
        }
      };

      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address();
        const bound = typeof addr === 'object' && addr ? addr.port : port;
        resolve(bound);
      });
    };

    tryPort(preferredPort);
  });
}

export class WebBridge {
  private readonly preferredUiPort: number;
  private readonly staticDir?: string;
  private readonly initialOverrides: {
    displayName?: string;
    discoveryUrl?: string;
    listenPort?: number;
    podUrl?: string;
    podDisabled?: boolean;
  };

  private currentHomeDir: string;
  private currentIdentity!: Identity;
  private app!: PeerApp;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private boundUiPort: number | null = null;
  private logs: SystemLogEntry[] = [];
  private podLoginInProgress = false;
  private switchingProfile = false;

  constructor(options: WebBridgeOptions) {
    this.currentHomeDir = path.resolve(options.homeDir);
    this.preferredUiPort = options.uiPort ?? 3333;
    this.staticDir = options.staticDir ? path.resolve(options.staticDir) : undefined;
    this.initialOverrides = {
      displayName: options.displayName,
      discoveryUrl: options.discoveryUrl,
      listenPort: options.listenPort,
      podUrl: options.podUrl,
      podDisabled: options.podDisabled,
    };
  }

  get uiPort(): number | null {
    return this.boundUiPort;
  }

  get url(): string | null {
    return this.boundUiPort !== null ? `http://127.0.0.1:${this.boundUiPort}` : null;
  }

  get peerApp(): PeerApp {
    return this.app;
  }

  async start(): Promise<{ port: number; url: string; state: PeerAppState }> {
    await this.bootPeerApp(this.currentHomeDir, this.initialOverrides);

    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin;
      if (!isAllowedLocalOrigin(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const reqPath = (req.url ?? '/').split('?')[0];
      if (reqPath !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws) => {
      this.handleWsConnection(ws);
    });

    const port = await listenLocalServer(server, this.preferredUiPort);
    this.server = server;
    this.wss = wss;
    this.boundUiPort = port;

    return {
      port,
      url: `http://127.0.0.1:${port}`,
      state: this.app.getState(),
    };
  }

  async stop(reason = 'WebBridge dihentikan.'): Promise<void> {
    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch {
          // abaikan
        }
      }
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      });
    }

    this.boundUiPort = null;

    if (this.app) {
      await this.app.stopNode(reason);
    }
  }

  // ---------------------------------------------------------------------------
  // Manajemen PeerApp & Profil
  // ---------------------------------------------------------------------------

  private async bootPeerApp(
    homeDir: string,
    overrides: {
      displayName?: string;
      discoveryUrl?: string;
      listenPort?: number;
      podUrl?: string;
      podDisabled?: boolean;
    } = {}
  ): Promise<void> {
    const resolvedHome = path.resolve(homeDir);
    const config = loadConfig(resolvedHome);
    if (!config) {
      throw new Error(`Profil di ${resolvedHome} belum memiliki config.json.`);
    }

    const identity = Identity.loadOrCreate(resolvedHome, overrides.displayName ?? config.displayName);
    const discoveryUrl = overrides.discoveryUrl ?? config.discoveryUrl;
    const listenPort = overrides.listenPort ?? config.listenPort;
    const podUrl = overrides.podDisabled
      ? undefined
      : (overrides.podUrl ?? (config.pod.enabled ? config.pod.podUrl : undefined));

    if (podUrl) {
      const cssPort = localCssPortOf(podUrl);
      if (cssPort) {
        const name = podNameFromDisplayName(identity.displayName);
        await ensureLocalCssRunning({ cssPort, name }).catch(() => undefined);
      }
    }

    const app = new PeerApp({
      identity,
      homeDir: resolvedHome,
      discoveryUrl,
      listenPort,
      podUrl,
      mode: 'daemon',
    });

    this.currentHomeDir = resolvedHome;
    this.currentIdentity = identity;
    this.app = app;
    this.logs = [];
    this.attachAppListeners(app);

    await app.startNode();
  }

  private attachAppListeners(app: PeerApp): void {
    app.on('system', (entry: SystemLogEntry) => {
      if (this.app !== app) return;
      this.logs.push(entry);
      if (this.logs.length > MAX_LOG_ENTRIES) {
        this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
      }
      this.broadcast({ type: 'system', ...entry });
    });

    app.on('state', (state: PeerAppState) => {
      if (this.app !== app) return;
      this.broadcast({ type: 'state', state });
    });

    app.on('message', (message: PeerChatEvent) => {
      if (this.app !== app) return;
      this.broadcast({ type: 'message', message });
      this.broadcast({ type: 'chatsUpdated', chats: app.listChats() });
    });

    app.on('historyLoaded', (payload: { chatId: string; messages: unknown[] }) => {
      if (this.app !== app) return;
      this.broadcast({ type: 'historyLoaded', ...payload });
    });

    app.on('sessionStarted', (session: unknown) => {
      if (this.app !== app) return;
      this.broadcast({ type: 'sessionStarted', session });
      this.broadcast({ type: 'chatsUpdated', chats: app.listChats() });
    });

    app.on('sessionClosed', (payload: { reason: string; chatId: string | null }) => {
      if (this.app !== app) return;
      this.broadcast({ type: 'sessionClosed', ...payload });
      this.broadcast({ type: 'chatsUpdated', chats: app.listChats() });
    });

    app.on('sync', (payload: Record<string, unknown>) => {
      if (this.app !== app) return;
      this.broadcast({ type: 'sync', ...payload });
      this.broadcast({ type: 'chatsUpdated', chats: app.listChats() });
    });
  }

  private async switchProfile(targetHomeDir: string): Promise<PeerAppState> {
    if (this.switchingProfile) {
      throw new Error('Sedang dalam proses mengganti profil.');
    }
    const resolved = path.resolve(targetHomeDir);
    if (resolved === this.currentHomeDir) {
      return this.app.getState();
    }

    const config = loadConfig(resolved);
    if (!config) {
      throw new Error(`Profil di ${resolved} belum selesai setup (config.json tidak ditemukan).`);
    }

    this.switchingProfile = true;
    const prevHome = this.currentHomeDir;
    try {
      await this.app.stopNode('Berpindah profil dari Web UI...');
      await this.bootPeerApp(resolved);
      setActiveProfile(resolved, this.currentIdentity.displayName);
      const state = this.app.getState();
      this.broadcast({
        type: 'init',
        state,
        chats: this.app.listChats(),
        logs: this.logs,
      });
      return state;
    } catch (err) {
      // Coba pulihkan profil sebelumnya bila gagal start di profil baru
      if (this.app.getState().nodeStatus === 'stopped') {
        await this.bootPeerApp(prevHome).catch(() => undefined);
      }
      throw err;
    } finally {
      this.switchingProfile = false;
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  private handleWsConnection(ws: WebSocket): void {
    this.sendWs(ws, {
      type: 'init',
      state: this.app.getState(),
      chats: this.app.listChats(),
      logs: this.logs,
    });

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as { type?: string; text?: unknown };
        if (parsed.type === 'ping') {
          this.sendWs(ws, { type: 'pong', timestamp: Date.now() });
          return;
        }
        if (parsed.type === 'sendMessage' && typeof parsed.text === 'string') {
          this.app.sendChat(parsed.text);
        }
      } catch (err: any) {
        this.sendWs(ws, { type: 'error', error: err?.message ?? 'Pesan WS tidak valid.' });
      }
    });
  }

  private sendWs(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private broadcast(payload: unknown): void {
    if (!this.wss) return;
    const serialized = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP Router
  // ---------------------------------------------------------------------------

  private applyCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const origin = req.headers.origin;
    if (!isAllowedLocalOrigin(origin)) {
      this.sendJson(res, 403, { error: 'Origin tidak diizinkan (hanya localhost).' });
      return false;
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
    }
    return true;
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.applyCors(req, res)) return;

    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    try {
      if (pathname.startsWith('/api/')) {
        await this.handleApi(method, pathname, req, res);
        return;
      }

      if (method === 'GET') {
        this.handleStaticOrRoot(pathname, res);
        return;
      }

      this.sendJson(res, 404, { error: 'Not Found' });
    } catch (err: any) {
      this.sendJson(res, 400, { error: err?.message ?? 'Permintaan gagal diproses.' });
    }
  }

  private async handleApi(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (method === 'GET' && pathname === '/api/health') {
      this.sendJson(res, 200, { ok: true, nodeStatus: this.app.getState().nodeStatus });
      return;
    }

    if (method === 'GET' && pathname === '/api/state') {
      this.sendJson(res, 200, {
        state: this.app.getState(),
        logs: this.logs,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/profiles') {
      const profiles = scanProfiles([this.currentHomeDir]).map((p) => ({
        homeDir: p.homeDir,
        name: profileName(p),
        peerId: p.identity?.peerId ?? '',
        fingerprint: p.identity?.peerId ? fingerprintOf(p.identity.peerId) : '',
        discoveryUrl: p.config?.discoveryUrl ?? null,
        listenPort: p.config?.listenPort ?? null,
        pod: p.config?.pod ?? null,
        isDefault: p.isDefault,
        isActive: path.resolve(p.homeDir) === this.currentHomeDir,
        complete: Boolean(p.config),
      }));
      this.sendJson(res, 200, { activeHomeDir: this.currentHomeDir, profiles });
      return;
    }

    if (method === 'POST' && pathname === '/api/profiles/switch') {
      const body = await readJsonBody(req);
      if (typeof body.homeDir !== 'string' || !body.homeDir.trim()) {
        this.sendJson(res, 400, { error: 'Field homeDir wajib diisi.' });
        return;
      }
      const state = await this.switchProfile(body.homeDir);
      this.sendJson(res, 200, { ok: true, state });
      return;
    }

    if (method === 'GET' && pathname === '/api/peers') {
      const peers = await this.app.getOnlinePeers();
      const enriched = peers.map((peer) => ({
        ...peer,
        fingerprint: fingerprintOf(peer.peerId),
      }));
      this.sendJson(res, 200, { peers: enriched });
      return;
    }

    if (method === 'GET' && pathname === '/api/chats') {
      this.sendJson(res, 200, { chats: this.app.listChats() });
      return;
    }

    const chatMsgMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (method === 'GET' && chatMsgMatch) {
      const chatId = decodeURIComponent(chatMsgMatch[1]);
      const messages = this.app.getChatMessages(chatId);
      const stats = this.app.getChatStats(chatId);
      this.sendJson(res, 200, { chatId, messages, stats });
      return;
    }

    if (method === 'POST' && pathname === '/api/session/connect') {
      const body = await readJsonBody(req);
      if (typeof body.peerId !== 'string' || !body.peerId.trim()) {
        this.sendJson(res, 400, { error: 'Field peerId wajib diisi.' });
        return;
      }
      await this.app.connectTo({
        peerId: body.peerId.trim(),
        label: typeof body.label === 'string' ? body.label : undefined,
        ip: typeof body.ip === 'string' && body.ip.trim() ? body.ip.trim() : undefined,
        port: typeof body.port === 'number' ? body.port : undefined,
      });
      this.sendJson(res, 200, { ok: true, state: this.app.getState() });
      return;
    }

    if (method === 'POST' && pathname === '/api/session/cancel') {
      this.app.cancelConnect();
      this.sendJson(res, 200, { ok: true, state: this.app.getState() });
      return;
    }

    if (method === 'POST' && pathname === '/api/session/disconnect') {
      const body = await readJsonBody(req);
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'Sesi diputus dari Web UI.';
      await this.app.disconnectSession(reason);
      this.sendJson(res, 200, { ok: true, state: this.app.getState() });
      return;
    }

    if (method === 'POST' && pathname === '/api/session/message') {
      const body = await readJsonBody(req);
      if (typeof body.text !== 'string' || !body.text.trim()) {
        this.sendJson(res, 400, { error: 'Pesan tidak boleh kosong.' });
        return;
      }
      const message = this.app.sendChat(body.text);
      this.sendJson(res, 200, { ok: true, message });
      return;
    }

    if (method === 'POST' && pathname === '/api/sync') {
      const body = await readJsonBody(req);
      if (body.all === true || typeof body.chatId !== 'string' || !body.chatId.trim()) {
        const result = await this.app.syncAllChats();
        this.sendJson(res, 200, { ok: true, result, chats: this.app.listChats() });
      } else {
        const result = await this.app.syncChat(body.chatId.trim());
        this.sendJson(res, 200, { ok: true, result, chats: this.app.listChats() });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/pod/login') {
      const body = await readJsonBody(req);
      await this.handlePodLoginApi(body, res);
      return;
    }

    if (method === 'POST' && pathname === '/api/pod/link') {
      const state = this.app.getState();
      if (!state.pod.podUrl) {
        this.sendJson(res, 400, { error: 'Profil belum memiliki URL Solid Pod. Login terlebih dahulu.' });
        return;
      }
      const linked = await linkAndPersistPod({
        homeDir: this.currentHomeDir,
        identity: this.currentIdentity,
        podUrl: state.pod.podUrl,
        webId: state.pod.webId,
        authMode: state.pod.authMode,
      });
      await this.app.reloadPod(state.pod.podUrl);
      this.sendJson(res, 200, { ok: true, linked, state: this.app.getState() });
      return;
    }

    this.sendJson(res, 404, { error: `Endpoint tidak ditemukan: ${method} ${pathname}` });
  }

  private async handlePodLoginApi(body: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    if (this.podLoginInProgress) {
      this.sendJson(res, 409, { error: 'Proses login Solid Pod sedang berjalan.' });
      return;
    }

    const mode = body.mode === 'account' ? 'account' : 'browser';
    const issuerUrl = normalizeIssuerUrl(
      typeof body.issuerUrl === 'string' && body.issuerUrl.trim() ? body.issuerUrl : DEFAULT_SOLID_ISSUER
    );
    const podUrlOverride = typeof body.podUrl === 'string' && body.podUrl.trim() ? body.podUrl.trim() : undefined;

    if (mode === 'account') {
      if (typeof body.email !== 'string' || typeof body.password !== 'string' || !body.email || !body.password) {
        this.sendJson(res, 400, { error: 'Mode account membutuhkan email dan password.' });
        return;
      }
      this.podLoginInProgress = true;
      try {
        const result = await loginWithSolidAccount({
          issuerUrl,
          email: body.email,
          password: body.password,
          homeDir: this.currentHomeDir,
          podUrlOverride,
        });
        const linked = await linkAndPersistPod({
          homeDir: this.currentHomeDir,
          identity: this.currentIdentity,
          podUrl: result.podUrl,
          webId: result.webId,
          oidcIssuer: result.oidcIssuer,
          authMode: result.authMode,
          email: body.email,
          password: body.password,
        });
        await this.app.reloadPod(result.podUrl);
        this.broadcast({ type: 'podLoginStatus', status: 'completed', webId: linked.webId, podUrl: result.podUrl });
        this.sendJson(res, 200, { ok: true, linked, state: this.app.getState() });
      } finally {
        this.podLoginInProgress = false;
      }
      return;
    }

    // Mode browser (OIDC PKCE): kembalikan authUrl ke client segera, lalu lanjutkan linking di background
    this.podLoginInProgress = true;
    const openBrowserAuto = body.openBrowser !== false;
    let authUrlResolved = false;

    const authUrlPromise = new Promise<string>((resolve, reject) => {
      const loginTask = loginWithSolidBrowser({
        oidcIssuer: issuerUrl,
        homeDir: this.currentHomeDir,
        podUrlOverride,
        openBrowserAuto,
        onAuthUrl: (authUrl) => {
          authUrlResolved = true;
          this.broadcast({ type: 'podLoginStatus', status: 'awaiting_browser', authUrl });
          resolve(authUrl);
        },
      });

      loginTask
        .then(async (result) => {
          this.broadcast({ type: 'podLoginStatus', status: 'linking', webId: result.webId, podUrl: result.podUrl });
          const linked = await linkAndPersistPod({
            homeDir: this.currentHomeDir,
            identity: this.currentIdentity,
            podUrl: result.podUrl,
            webId: result.webId,
            oidcIssuer: result.oidcIssuer,
            authMode: result.authMode,
          });
          await this.app.reloadPod(result.podUrl);
          this.broadcast({
            type: 'podLoginStatus',
            status: 'completed',
            webId: linked.webId,
            podUrl: result.podUrl,
          });
        })
        .catch((err: any) => {
          const message = err?.message ?? 'Login browser Solid Pod gagal.';
          this.broadcast({ type: 'podLoginStatus', status: 'error', error: message });
          if (!authUrlResolved) reject(err);
        })
        .finally(() => {
          this.podLoginInProgress = false;
        });
    });

    const authUrl = await authUrlPromise;
    this.sendJson(res, 202, { ok: true, status: 'awaiting_browser', authUrl });
  }

  private handleStaticOrRoot(pathname: string, res: http.ServerResponse): void {
    if (!this.staticDir || !fs.existsSync(this.staticDir)) {
      if (pathname === '/') {
        this.sendJson(res, 200, {
          name: 'P2Pod WebBridge',
          status: 'running',
          api: '/api/state',
          ws: '/ws',
          hint: 'Frontend Web UI belum di-build; jalankan dev server Web UI atau build ke packages/web-ui/dist.',
        });
        return;
      }
      this.sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = path.resolve(this.staticDir, relPath);
    const rootWithSep = this.staticDir.endsWith(path.sep) ? this.staticDir : `${this.staticDir}${path.sep}`;

    if (candidate !== this.staticDir && !candidate.startsWith(rootWithSep)) {
      this.sendJson(res, 403, { error: 'Forbidden' });
      return;
    }

    let fileToServe = candidate;
    if (!fs.existsSync(fileToServe) || fs.statSync(fileToServe).isDirectory()) {
      fileToServe = path.join(this.staticDir, 'index.html');
    }
    if (!fs.existsSync(fileToServe)) {
      this.sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    const ext = path.extname(fileToServe).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const data = fs.readFileSync(fileToServe);
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': data.length,
    });
    res.end(data);
  }
}
