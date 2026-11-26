// packages/user-client/src/web/webBridge.ts
// Local-only HTTP + WebSocket bridge (127.0.0.1) antara browser Web UI dan PeerApp daemon.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { PeerApp, PeerAppState, PeerChatEvent } from '../core/peerApp';
import { Identity, fingerprintOf } from '../identity/identity';
import { loadConfig, saveConfig } from '../config';
import { setActiveProfile } from '../activeProfile';
import { profileName, runRemove, scanProfiles } from '../profiles';
import { ensureLocalCssRunning, localCssPortOf, podNameFromDisplayName } from '../modules/pod/provision';
import {
  DEFAULT_SOLID_ISSUER,
  loginWithSolidAccount,
  loginWithSolidBrowser,
  normalizeIssuerUrl,
} from '../modules/pod/solidAuth';
import { linkAndPersistPod } from '../podCli';
import { createProfile, resolveNewProfileHome, updateProfileSettings } from '../profileSetup';
import { checkDiscovery, normalizeUrl } from '../wizard';
import { isValidHost } from '../discovery/discoveryClient';

export interface WebBridgeOptions {
  homeDir: string;
  displayName?: string;
  discoveryUrl?: string;
  listenPort?: number;
  podUrl?: string;
  podDisabled?: boolean;
  publicHost?: string;
  publicPort?: number;
  discoveryToken?: string;
  /** Port HTTP/WS lokal (default 3333, fallback otomatis hingga +9 bila terpakai). */
  uiPort?: number;
  /** Alamat bind HTTP/WS. Default 127.0.0.1; Docker memakai 0.0.0.0 di dalam container. */
  uiHost?: string;
  /** Direktori hasil build statis frontend (opsional, mis. packages/web-ui/dist). */
  staticDir?: string;
}

export interface SystemLogEntry {
  text: string;
  timestamp: number;
}

export interface ProfileSummary {
  homeDir: string;
  name: string;
  peerId: string;
  fingerprint: string;
  discoveryUrl: string | null;
  listenPort: number | null;
  publicHost: string | null;
  publicPort: number | null;
  pod: { enabled: boolean; podUrl?: string; webId?: string; authMode?: string } | null;
  isDefault: boolean;
  isActive: boolean;
  complete: boolean;
}

export interface BridgeDefaults {
  discoveryUrl: string;
  listenPort: number;
  publicHost?: string;
  publicPort?: number;
  hasDiscoveryToken: boolean;
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

function listenLocalServer(server: http.Server, host: string, preferredPort: number): Promise<number> {
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
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const addr = server.address();
        const bound = typeof addr === 'object' && addr ? addr.port : port;
        resolve(bound);
      });
    };

    tryPort(preferredPort);
  });
}

async function detectPublicIp(): Promise<string | null> {
  const sources: Array<{ url: string; parse: (body: string) => string | null }> = [
    {
      url: 'https://api.ipify.org?format=json',
      parse: (body) => {
        try {
          const parsed = JSON.parse(body) as { ip?: string };
          return typeof parsed.ip === 'string' ? parsed.ip.trim() : null;
        } catch {
          return null;
        }
      },
    },
    {
      url: 'https://ifconfig.me/ip',
      parse: (body) => body.trim().split(/\s+/)[0] || null,
    },
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const ip = source.parse(await response.text());
      if (ip && isValidHost(ip)) return ip.replace(/^\[|\]$/g, '');
    } catch {
      // coba sumber berikutnya
    }
  }
  return null;
}

export class WebBridge {
  private readonly preferredUiPort: number;
  private readonly uiHost: string;
  private readonly staticDir?: string;
  private readonly initialOverrides: {
    displayName?: string;
    discoveryUrl?: string;
    listenPort?: number;
    podUrl?: string;
    podDisabled?: boolean;
    publicHost?: string;
    publicPort?: number;
    discoveryToken?: string;
  };

  private currentHomeDir: string;
  private currentIdentity: Identity | null = null;
  private app: PeerApp | null = null;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private boundUiPort: number | null = null;
  private logs: SystemLogEntry[] = [];
  private podLoginInProgress = false;
  private switchingProfile = false;
  private needsSetup = false;

  constructor(options: WebBridgeOptions) {
    this.currentHomeDir = path.resolve(options.homeDir);
    this.preferredUiPort = options.uiPort ?? Number(process.env.P2POD_UI_PORT ?? 3333);
    this.uiHost = options.uiHost?.trim() || process.env.P2POD_UI_HOST?.trim() || '127.0.0.1';
    this.staticDir = path.resolve(
      options.staticDir ?? process.env.P2POD_WEB_DIST ?? path.join(process.cwd(), 'packages', 'web-ui', 'dist')
    );
    this.initialOverrides = {
      displayName: options.displayName,
      discoveryUrl: options.discoveryUrl,
      listenPort: options.listenPort,
      podUrl: options.podUrl,
      podDisabled: options.podDisabled,
      publicHost: options.publicHost,
      publicPort: options.publicPort,
      discoveryToken: options.discoveryToken,
    };
  }

  get uiPort(): number | null {
    return this.boundUiPort;
  }

  get url(): string | null {
    return this.boundUiPort !== null ? `http://127.0.0.1:${this.boundUiPort}` : null;
  }

  get peerApp(): PeerApp | null {
    return this.app;
  }

  async start(): Promise<{
    port: number;
    url: string;
    state: PeerAppState | null;
    needsSetup: boolean;
  }> {
    let bootHome = this.currentHomeDir;
    if (!loadConfig(bootHome)) {
      const profiles = scanProfiles([bootHome]);
      const candidate =
        profiles.find((profile) => Boolean(profile.config) && profile.homeDir === bootHome) ??
        profiles.find((profile) => Boolean(profile.config));
      if (candidate) bootHome = candidate.homeDir;
    }
    await this.bootPeerApp(bootHome, this.initialOverrides);

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

    const port = await listenLocalServer(server, this.uiHost, this.preferredUiPort);
    this.server = server;
    this.wss = wss;
    this.boundUiPort = port;

    return {
      port,
      url: `http://127.0.0.1:${port}`,
      state: this.app?.getState() ?? null,
      needsSetup: this.needsSetup,
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

  private profileSummaries(): ProfileSummary[] {
    return scanProfiles([this.currentHomeDir]).map((p) => ({
      homeDir: p.homeDir,
      name: profileName(p),
      peerId: p.identity?.peerId ?? '',
      fingerprint: p.identity?.peerId ? fingerprintOf(p.identity.peerId) : '',
      discoveryUrl: p.config?.discoveryUrl ?? null,
      listenPort: p.config?.listenPort ?? null,
      publicHost: p.config?.network?.publicHost ?? null,
      publicPort: p.config?.network?.publicPort ?? null,
      pod: p.config?.pod
        ? {
            enabled: p.config.pod.enabled,
            podUrl: p.config.pod.podUrl,
            webId: p.config.pod.webId,
            authMode: p.config.pod.authMode,
          }
        : null,
      isDefault: p.isDefault,
      isActive: path.resolve(p.homeDir) === this.currentHomeDir,
      complete: Boolean(p.config),
    }));
  }

  private defaults(): BridgeDefaults {
    const port = Number(process.env.P2P_LISTEN_PORT ?? 5000);
    const publicPort = Number(process.env.P2P_PUBLIC_PORT ?? '');
    return {
      discoveryUrl: process.env.P2P_DISCOVERY_URL?.trim() || 'http://localhost:4000',
      listenPort: Number.isInteger(port) && port > 0 ? port : 5000,
      publicHost: process.env.P2P_PUBLIC_HOST?.trim() || undefined,
      publicPort: Number.isInteger(publicPort) && publicPort > 0 ? publicPort : undefined,
      hasDiscoveryToken: Boolean(process.env.P2P_DISCOVERY_TOKEN?.trim()),
    };
  }

  private initPayload(): Record<string, unknown> {
    return {
      type: 'init',
      state: this.app?.getState() ?? null,
      chats: this.app?.listChats() ?? [],
      logs: this.logs,
      profiles: this.profileSummaries(),
      needsSetup: this.needsSetup,
      defaults: this.defaults(),
    };
  }

  private async bootPeerApp(
    homeDir: string,
    overrides: {
      displayName?: string;
      discoveryUrl?: string;
      listenPort?: number;
      podUrl?: string;
      podDisabled?: boolean;
      publicHost?: string;
      publicPort?: number;
      discoveryToken?: string;
    } = {}
  ): Promise<boolean> {
    const resolvedHome = path.resolve(homeDir);
    const config = loadConfig(resolvedHome);
    this.currentHomeDir = resolvedHome;
    this.logs = [];

    if (!config) {
      this.app = null;
      this.currentIdentity = null;
      this.needsSetup = true;
      return false;
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

    const envPublicHost = process.env.P2P_PUBLIC_HOST?.trim() || undefined;
    const envPublicPort = Number(process.env.P2P_PUBLIC_PORT ?? '');
    const envDiscoveryToken = process.env.P2P_DISCOVERY_TOKEN?.trim() || undefined;

    const app = new PeerApp({
      identity,
      homeDir: resolvedHome,
      discoveryUrl,
      listenPort,
      podUrl,
      publicHost: overrides.publicHost ?? config.network?.publicHost ?? envPublicHost,
      publicPort:
        overrides.publicPort ??
        config.network?.publicPort ??
        (Number.isInteger(envPublicPort) && envPublicPort > 0 ? envPublicPort : undefined),
      discoveryToken:
        overrides.discoveryToken ?? config.network?.discoveryToken ?? envDiscoveryToken,
      mode: 'daemon',
    });

    this.currentIdentity = identity;
    this.app = app;
    this.needsSetup = false;
    this.attachAppListeners(app);

    await app.startNode();
    return true;
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

  private broadcastInit(): void {
    this.broadcast(this.initPayload());
  }

  private async switchProfile(targetHomeDir: string): Promise<PeerAppState> {
    if (this.switchingProfile) {
      throw new Error('Sedang dalam proses mengganti profil.');
    }
    const resolved = path.resolve(targetHomeDir);
    if (resolved === this.currentHomeDir && this.app) {
      return this.app.getState();
    }

    const config = loadConfig(resolved);
    if (!config) {
      throw new Error(`Profil di ${resolved} belum selesai setup (config.json tidak ditemukan).`);
    }

    this.switchingProfile = true;
    const prevHome = this.currentHomeDir;
    try {
      if (this.app) {
        await this.app.stopNode('Berpindah profil dari Web UI...');
      }
      await this.bootPeerApp(resolved);
      setActiveProfile(resolved, this.currentIdentity?.displayName ?? config.displayName);
      const state = this.app!.getState();
      this.broadcastInit();
      return state;
    } catch (err) {
      // Coba pulihkan profil sebelumnya bila gagal start di profil baru
      if (!this.app && loadConfig(prevHome)) {
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
    this.sendWs(ws, this.initPayload());

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as { type?: string; text?: unknown };
        if (parsed.type === 'ping') {
          this.sendWs(ws, { type: 'pong', timestamp: Date.now() });
          return;
        }
        if (parsed.type === 'sendMessage' && typeof parsed.text === 'string') {
          if (!this.app) {
            this.sendWs(ws, { type: 'error', error: 'Profil belum aktif. Selesaikan setup terlebih dahulu.' });
            return;
          }
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
      this.sendJson(res, 403, { error: 'Origin tidak diizinkan (UI lokal).' });
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

  private requireApp(res: http.ServerResponse): PeerApp | null {
    if (!this.app) {
      this.sendJson(res, 409, { error: 'Belum ada profil aktif. Selesaikan setup melalui Web UI.' });
      return null;
    }
    return this.app;
  }

  private async handleApi(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (method === 'GET' && pathname === '/api/health') {
      this.sendJson(res, 200, {
        ok: true,
        nodeStatus: this.app?.getState().nodeStatus ?? 'stopped',
        needsSetup: this.needsSetup,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/state') {
      this.sendJson(res, 200, {
        state: this.app?.getState() ?? null,
        logs: this.logs,
        profiles: this.profileSummaries(),
        needsSetup: this.needsSetup,
        defaults: this.defaults(),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/profiles') {
      this.sendJson(res, 200, {
        activeHomeDir: this.currentHomeDir,
        needsSetup: this.needsSetup,
        profiles: this.profileSummaries(),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/profiles/create') {
      const body = await readJsonBody(req);
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      const discoveryUrl = typeof body.discoveryUrl === 'string' ? body.discoveryUrl.trim() : '';
      if (!displayName) {
        this.sendJson(res, 400, { error: 'Nama user wajib diisi.' });
        return;
      }
      if (!discoveryUrl) {
        this.sendJson(res, 400, { error: 'URL Discovery Platform wajib diisi.' });
        return;
      }

      const preferredHome = typeof body.homeDir === 'string' ? body.homeDir : undefined;
      const envListenPort = Number(process.env.P2P_LISTEN_PORT ?? '');
      const envPublicPort = Number(process.env.P2P_PUBLIC_PORT ?? '');
      const homeDir = resolveNewProfileHome(displayName, preferredHome);
      const result = await createProfile({
        homeDir,
        displayName,
        discoveryUrl,
        listenPort:
          typeof body.listenPort === 'number'
            ? body.listenPort
            : Number.isInteger(envListenPort) && envListenPort > 0
              ? envListenPort
              : undefined,
        podUrl: typeof body.podUrl === 'string' && body.podUrl.trim() ? body.podUrl.trim() : undefined,
        podDisabled: body.podDisabled === true,
        publicHost:
          typeof body.publicHost === 'string' && body.publicHost.trim()
            ? body.publicHost.trim()
            : process.env.P2P_PUBLIC_HOST?.trim() || undefined,
        publicPort:
          typeof body.publicPort === 'number'
            ? body.publicPort
            : Number.isInteger(envPublicPort) && envPublicPort > 0
              ? envPublicPort
              : undefined,
        discoveryToken:
          typeof body.discoveryToken === 'string' && body.discoveryToken.trim()
            ? body.discoveryToken.trim()
            : process.env.P2P_DISCOVERY_TOKEN?.trim() || undefined,
      });
      const previousHome = this.currentHomeDir;
      if (this.app) {
        await this.app.stopNode('Berpindah ke profil baru...');
      }
      try {
        await this.bootPeerApp(homeDir);
      } catch (err) {
        if (loadConfig(previousHome)) {
          await this.bootPeerApp(previousHome).catch(() => undefined);
        }
        throw err;
      }
      setActiveProfile(homeDir, result.identity.displayName);
      if (result.warning) {
        this.logs.push({ text: `⚠ ${result.warning}`, timestamp: Date.now() });
        this.broadcast({ type: 'system', text: `⚠ ${result.warning}`, timestamp: Date.now() });
      }
      this.broadcastInit();
      this.sendJson(res, 200, {
        ok: true,
        state: this.app?.getState() ?? null,
        warning: result.warning,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/profiles/delete') {
      const body = await readJsonBody(req);
      if (typeof body.homeDir !== 'string' || !body.homeDir.trim()) {
        this.sendJson(res, 400, { error: 'Field homeDir wajib diisi.' });
        return;
      }
      const target = path.resolve(body.homeDir);
      if (target === this.currentHomeDir) {
        this.sendJson(res, 400, {
          error: 'Tidak bisa menghapus profil yang sedang aktif. Pindah profil terlebih dahulu.',
        });
        return;
      }
      await runRemove({ homeDir: target, yes: true });
      this.sendJson(res, 200, { ok: true, profiles: this.profileSummaries() });
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

    if (method === 'POST' && pathname === '/api/profile/update') {
      if (!this.app) {
        this.sendJson(res, 409, { error: 'Belum ada profil aktif.' });
        return;
      }
      const body = await readJsonBody(req);
      const previousConfig = loadConfig(this.currentHomeDir);
      const updated = await updateProfileSettings(this.currentHomeDir, {
        discoveryUrl: typeof body.discoveryUrl === 'string' ? body.discoveryUrl : undefined,
        listenPort: typeof body.listenPort === 'number' ? body.listenPort : undefined,
        publicHost:
          body.publicHost === null
            ? null
            : typeof body.publicHost === 'string'
              ? body.publicHost
              : undefined,
        publicPort:
          body.publicPort === null
            ? null
            : typeof body.publicPort === 'number'
              ? body.publicPort
              : undefined,
        discoveryToken:
          body.discoveryToken === null
            ? null
            : typeof body.discoveryToken === 'string' && body.discoveryToken.trim()
              ? body.discoveryToken.trim()
              : undefined,
      });
      await this.app.stopNode('Menerapkan pengaturan jaringan...');
      try {
        await this.bootPeerApp(this.currentHomeDir);
      } catch (err) {
        if (previousConfig) {
          saveConfig(this.currentHomeDir, previousConfig);
          await this.bootPeerApp(this.currentHomeDir).catch(() => undefined);
        }
        throw err;
      }
      this.broadcastInit();
      this.sendJson(res, 200, { ok: true, config: updated, state: this.app?.getState() ?? null });
      return;
    }

    if (method === 'POST' && pathname === '/api/discovery/check') {
      const body = await readJsonBody(req);
      if (typeof body.url !== 'string' || !body.url.trim()) {
        this.sendJson(res, 400, { error: 'URL discovery wajib diisi.' });
        return;
      }
      const url = normalizeUrl(body.url);
      const problem = await checkDiscovery(url);
      this.sendJson(res, 200, { url, ok: !problem, error: problem ?? undefined });
      return;
    }

    if (method === 'GET' && pathname === '/api/network/public-ip') {
      const ip = await detectPublicIp();
      if (!ip) {
        this.sendJson(res, 200, {
          ok: false,
          error: 'Tidak bisa mendeteksi IP publik. Isi public host secara manual.',
        });
        return;
      }
      this.sendJson(res, 200, { ok: true, ip });
      return;
    }

    if (method === 'POST' && pathname === '/api/network/probe') {
      const app = this.requireApp(res);
      if (!app) return;
      const result = await app.probePublicEndpoint();
      this.sendJson(res, 200, { ok: true, result });
      return;
    }

    if (method === 'GET' && pathname === '/api/peers') {
      if (!this.app) {
        this.sendJson(res, 200, { peers: [] });
        return;
      }
      const peers = await this.app.getOnlinePeers();
      const enriched = peers.map((peer) => ({
        ...peer,
        fingerprint: fingerprintOf(peer.peerId),
      }));
      this.sendJson(res, 200, { peers: enriched });
      return;
    }

    if (method === 'GET' && pathname === '/api/chats') {
      this.sendJson(res, 200, { chats: this.app?.listChats() ?? [] });
      return;
    }

    const chatMsgMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (method === 'GET' && chatMsgMatch) {
      if (!this.app) {
        this.sendJson(res, 200, { chatId: decodeURIComponent(chatMsgMatch[1]), messages: [], stats: { totalMessages: 0, unsyncedSessions: 0 } });
        return;
      }
      const chatId = decodeURIComponent(chatMsgMatch[1]);
      const messages = this.app.getChatMessages(chatId);
      const stats = this.app.getChatStats(chatId);
      this.sendJson(res, 200, { chatId, messages, stats });
      return;
    }

    if (method === 'POST' && pathname === '/api/session/connect') {
      const app = this.requireApp(res);
      if (!app) return;
      const body = await readJsonBody(req);
      if (typeof body.peerId !== 'string' || !body.peerId.trim()) {
        this.sendJson(res, 400, { error: 'Field peerId wajib diisi.' });
        return;
      }
      await app.connectTo({
        peerId: body.peerId.trim(),
        label: typeof body.label === 'string' ? body.label : undefined,
        ip:
          typeof body.ip === 'string' && body.ip.trim()
            ? body.ip.trim()
            : typeof body.host === 'string' && body.host.trim()
              ? body.host.trim()
              : undefined,
        port: typeof body.port === 'number' ? body.port : undefined,
      });
      this.sendJson(res, 200, { ok: true, state: app.getState() });
      return;
    }

    if (method === 'POST' && pathname === '/api/session/cancel') {
      const app = this.requireApp(res);
      if (!app) return;
      app.cancelConnect();
      this.sendJson(res, 200, { ok: true, state: app.getState() });
      return;
    }

    if (method === 'POST' && pathname === '/api/session/disconnect') {
      const app = this.requireApp(res);
      if (!app) return;
      const body = await readJsonBody(req);
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'Sesi diputus dari Web UI.';
      await app.disconnectSession(reason);
      this.sendJson(res, 200, { ok: true, state: app.getState() });
      return;
    }

    if (method === 'POST' && pathname === '/api/session/message') {
      const app = this.requireApp(res);
      if (!app) return;
      const body = await readJsonBody(req);
      if (typeof body.text !== 'string' || !body.text.trim()) {
        this.sendJson(res, 400, { error: 'Pesan tidak boleh kosong.' });
        return;
      }
      const message = app.sendChat(body.text);
      this.sendJson(res, 200, { ok: true, message });
      return;
    }

    if (method === 'POST' && pathname === '/api/sync') {
      const app = this.requireApp(res);
      if (!app) return;
      const body = await readJsonBody(req);
      if (body.all === true || typeof body.chatId !== 'string' || !body.chatId.trim()) {
        const result = await app.syncAllChats();
        this.sendJson(res, 200, { ok: true, result, chats: app.listChats() });
      } else {
        const result = await app.syncChat(body.chatId.trim());
        this.sendJson(res, 200, { ok: true, result, chats: app.listChats() });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/pod/login') {
      if (!this.app || !this.currentIdentity) {
        this.sendJson(res, 409, { error: 'Belum ada profil aktif.' });
        return;
      }
      const body = await readJsonBody(req);
      await this.handlePodLoginApi(body, res);
      return;
    }

    if (method === 'POST' && pathname === '/api/pod/link') {
      const app = this.requireApp(res);
      if (!app || !this.currentIdentity) return;
      const state = app.getState();
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
      await app.reloadPod(state.pod.podUrl);
      this.sendJson(res, 200, { ok: true, linked, state: app.getState() });
      return;
    }

    this.sendJson(res, 404, { error: `Endpoint tidak ditemukan: ${method} ${pathname}` });
  }

  private async handlePodLoginApi(body: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    if (this.podLoginInProgress) {
      this.sendJson(res, 409, { error: 'Proses login Solid Pod sedang berjalan.' });
      return;
    }
    if (!this.currentIdentity) {
      this.sendJson(res, 409, { error: 'Belum ada profil aktif.' });
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
        await this.app!.reloadPod(result.podUrl);
        this.broadcast({ type: 'podLoginStatus', status: 'completed', webId: linked.webId, podUrl: result.podUrl });
        this.sendJson(res, 200, { ok: true, linked, state: this.app!.getState() });
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
            identity: this.currentIdentity!,
            podUrl: result.podUrl,
            webId: result.webId,
            oidcIssuer: result.oidcIssuer,
            authMode: result.authMode,
          });
          await this.app!.reloadPod(result.podUrl);
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