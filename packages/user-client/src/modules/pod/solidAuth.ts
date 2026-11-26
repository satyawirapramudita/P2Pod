// packages/user-client/src/modules/pod/solidAuth.ts
// Autentikasi ke Solid Community (solidcommunity.net) / Solid-OIDC provider
// mendukung:
//   1. Interactive Browser Login (Solid-OIDC Authorization Code Flow + PKCE via localhost callback)
//   2. Direct Account Login (CSS / Solid Community /.account/ API -> OIDC Client Credentials)

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { getPodUrlAll } from '@inrupt/solid-client';
import { EVENTS, getSessionFromStorage, IStorage, Session } from '@inrupt/solid-client-authn-node';
import { ensureDir } from '../../identity/identity';

// Gunakan require untuk modul internal authn-core & jose yang sudah menjadi dependency transitive
// eslint-disable-next-line @typescript-eslint/no-var-requires
const solidClientAuthnCore = require('@inrupt/solid-client-authn-core') as {
  buildAuthenticatedFetch: (
    accessToken: string,
    opts?: { dpopKey?: { publicKey: unknown; privateKey: unknown }; expiresIn?: number; eventEmitter?: unknown }
  ) => typeof fetch;
  PREFERRED_SIGNING_ALG: string[];
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jose = require('jose') as {
  exportJWK: (key: unknown) => Promise<Record<string, unknown>>;
  importJWK: (jwk: Record<string, unknown>, alg: string, opts?: { extractable?: boolean }) => Promise<unknown>;
};

export const DEFAULT_SOLID_ISSUER = 'https://solidcommunity.net';
export const OIDC_SESSION_ID = 'p2pod-oidc-session';

export interface SolidLoginResult {
  authMode: 'oidc' | 'clientCredentials';
  oidcIssuer: string;
  podUrl: string;
  webId: string;
  clientId?: string;
  sessionId?: string;
}

/**
 * Implementasi IStorage berbasis file JSON lokal (<homeDir>/solid-session.json)
 * untuk menyimpan refresh token, DPoP keypair, dan client registration Solid-OIDC.
 */
export class FileSessionStorage implements IStorage {
  private readonly filePath: string;
  private readonly persistDeletes: boolean;

  constructor(homeDir: string, opts: { persistDeletes?: boolean } = {}) {
    ensureDir(homeDir);
    this.filePath = path.join(homeDir, 'solid-session.json');
    this.persistDeletes = opts.persistDeletes ?? true;
  }

  private readAll(): Record<string, string> {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, string>): void {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async get(key: string): Promise<string | undefined> {
    const data = this.readAll();
    return data[key];
  }

  async set(key: string, value: string): Promise<void> {
    const data = this.readAll();
    data[key] = value;
    this.writeAll(data);
  }

  async delete(key: string): Promise<void> {
    if (!this.persistDeletes) return;
    const data = this.readAll();
    if (key in data) {
      delete data[key];
      this.writeAll(data);
    }
  }

  clearFile(): void {
    if (fs.existsSync(this.filePath)) {
      fs.rmSync(this.filePath, { force: true });
    }
  }
}

export function normalizeIssuerUrl(raw: string): string {
  const trimmed = raw.trim();
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProto.endsWith('/') ? withProto : `${withProto}/`;
}

/**
 * Turunkan root URL Solid Pod dari WebID bila discovery profile gagal/kosong.
 * Contoh:
 *   https://rina.solidcommunity.net/profile/card#me -> https://rina.solidcommunity.net/
 *   http://localhost:3005/rina/profile/card#me      -> http://localhost:3005/rina/
 */
export function derivePodUrlFromWebId(webId: string): string {
  try {
    const url = new URL(webId);
    url.hash = '';
    url.search = '';
    let pathname = url.pathname.replace(/\/profile\/card$/i, '/').replace(/\/profile$/i, '/');
    if (!pathname.endsWith('/')) pathname += '/';
    url.pathname = pathname;
    return url.toString();
  } catch {
    return webId.endsWith('/') ? webId : `${webId}/`;
  }
}

/**
 * Temukan URL Solid Pod dari dokumen profil WebID (pim:storage),
 * dengan fallback ke derivePodUrlFromWebId.
 */
export async function discoverPodUrl(webId: string, authFetch?: typeof fetch): Promise<string> {
  try {
    const pods = await getPodUrlAll(webId, authFetch ? { fetch: authFetch as any } : undefined);
    if (Array.isArray(pods) && pods.length > 0 && pods[0]) {
      return pods[0].endsWith('/') ? pods[0] : `${pods[0]}/`;
    }
  } catch {
    // fallback ke derivasi URL WebID di bawah
  }
  return derivePodUrlFromWebId(webId);
}

/** Buka URL di browser default OS (aman terhadap karakter '&' di query string OIDC). */
export function openBrowser(url: string): boolean {
  try {
    if (process.platform === 'win32') {
      const escaped = url.replace(/'/g, "''");
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${escaped}'`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => undefined);
      child.unref();
      return true;
    }
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function resolveCallbackBindHost(): string {
  const explicit = process.env.P2POD_OIDC_CALLBACK_HOST?.trim();
  if (explicit) return explicit;
  const uiHost = process.env.P2POD_UI_HOST?.trim();
  if (uiHost) return uiHost;
  return '127.0.0.1';
}

function resolveCallbackPreferredPort(override?: number): { port: number; allowFallback: boolean } {
  if (override !== undefined) {
    return { port: override, allowFallback: override !== 0 };
  }
  const raw = process.env.P2POD_OIDC_CALLBACK_PORT?.trim();
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      // Port eksplisit (mis. dipetakan Docker) tidak boleh fallback ke port acak yang tidak di-expose.
      return { port: parsed, allowFallback: false };
    }
  }
  return { port: 3888, allowFallback: true };
}

function listenCallbackServer(
  handler: http.RequestListener,
  preferredPort = 3888,
  bindHost = resolveCallbackBindHost(),
  allowFallback = preferredPort !== 0
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, canFallback: boolean): void => {
      const server = http.createServer(handler);
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (canFallback && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          tryListen(0, false);
        } else {
          reject(err);
        }
      });
      server.listen(port, bindHost, () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve({ server, port: actualPort });
      });
    };
    tryListen(preferredPort, allowFallback);
  });
}

interface CapturedTokenSet {
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  dpopKey?: {
    publicKey: Record<string, unknown>;
    privateKey: unknown;
  };
}

/**
 * Login interaktif ke Solid Community / Solid-OIDC Provider via browser (Authorization Code + PKCE).
 */
export async function loginWithSolidBrowser(opts: {
  oidcIssuer?: string;
  homeDir: string;
  podUrlOverride?: string;
  callbackPort?: number;
  timeoutMs?: number;
  openBrowserAuto?: boolean;
  onAuthUrl?: (url: string) => void;
}): Promise<SolidLoginResult> {
  const oidcIssuer = normalizeIssuerUrl(opts.oidcIssuer ?? DEFAULT_SOLID_ISSUER);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const storage = new FileSessionStorage(opts.homeDir, { persistDeletes: true });
  storage.clearFile();

  const session = new Session({ storage, keepAlive: false }, OIDC_SESSION_ID);

  let capturedTokens: CapturedTokenSet | undefined;
  session.events.on(EVENTS.NEW_TOKENS, (tokens: CapturedTokenSet) => {
    capturedTokens = tokens;
  });

  let resolveRedirect!: (fullUrl: string) => void;
  let rejectRedirect!: (err: Error) => void;
  const redirectPromise = new Promise<string>((resolve, reject) => {
    resolveRedirect = resolve;
    rejectRedirect = reject;
  });

  const callbackConfig = resolveCallbackPreferredPort(opts.callbackPort);
  const { server, port } = await listenCallbackServer(
    (req, res) => {
      const reqUrl = req.url ?? '/';
      if (!reqUrl.startsWith('/callback')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      const fullUrl = `http://localhost:${port}${reqUrl}`;
      const parsed = new URL(fullUrl);
      const errorParam = parsed.searchParams.get('error');
      const errorDesc = parsed.searchParams.get('error_description');

      if (errorParam) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>P2Pod Solid Login Gagal</title></head>` +
            `<body style="font-family:system-ui,sans-serif;max-width:540px;margin:48px auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">` +
            `<h2 style="color:#b91c1c;margin-top:0;">Autentikasi Solid Ditolak</h2>` +
            `<p>${errorDesc ?? errorParam}</p><p>Silakan kembali ke Web UI atau terminal P2Pod.</p></body></html>`
        );
        rejectRedirect(new Error(`Autentikasi OIDC ditolak oleh provider: ${errorDesc ?? errorParam}`));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>P2Pod Solid Login Berhasil</title></head>` +
          `<body style="font-family:system-ui,sans-serif;max-width:540px;margin:48px auto;padding:24px;border:1px solid #d1fae5;background:#f0fdf4;border-radius:8px;">` +
          `<h2 style="color:#065f46;margin-top:0;">Login Solid Pod Berhasil</h2>` +
          `<p>Akun Solid Anda sedang ditautkan ke identitas P2Pod.</p>` +
          `<p>Anda dapat menutup tab browser ini dan kembali ke Web UI atau terminal P2Pod.</p></body></html>`
      );
      resolveRedirect(fullUrl);
    },
    callbackConfig.port,
    resolveCallbackBindHost(),
    callbackConfig.allowFallback
  );

  const callbackUrl = `http://localhost:${port}/callback`;
  const timer = setTimeout(() => {
    rejectRedirect(new Error(`Waktu tunggu login browser habis (${Math.round(timeoutMs / 1000)} detik).`));
  }, timeoutMs);

  try {
    await session.login({
      oidcIssuer,
      redirectUrl: callbackUrl,
      clientName: 'P2Pod Decentralized Chat',
      handleRedirect: (authUrl: string) => {
        if (opts.onAuthUrl) {
          opts.onAuthUrl(authUrl);
        } else {
          console.log('');
          console.log('  Buka URL berikut di browser untuk login ke Solid Pod:');
          console.log(`  ${authUrl}`);
          console.log('');
        }
        if (opts.openBrowserAuto !== false) {
          openBrowser(authUrl);
        }
      },
    });

    const incomingUrl = await redirectPromise;
    const info = await session.handleIncomingRedirect(incomingUrl);

    if (!info?.isLoggedIn || !info.webId) {
      throw new Error('Login OIDC selesai tetapi sesi tidak terautentikasi atau WebID tidak ditemukan.');
    }

    const webId = info.webId;
    const discoveredPod = opts.podUrlOverride ?? (await discoverPodUrl(webId, session.fetch.bind(session) as any));
    const podUrl = discoveredPod.endsWith('/') ? discoveredPod : `${discoveredPod}/`;

    let dpopPublicKey: Record<string, unknown> | undefined;
    let dpopPrivateKey: Record<string, unknown> | undefined;
    if (capturedTokens?.dpopKey) {
      dpopPublicKey = capturedTokens.dpopKey.publicKey;
      dpopPrivateKey = await jose.exportJWK(capturedTokens.dpopKey.privateKey);
    }

    const podConfig = {
      authMode: 'oidc' as const,
      oidcIssuer,
      podUrl,
      webId,
      sessionId: OIDC_SESSION_ID,
      clientId: info.clientAppId,
      accessToken: capturedTokens?.accessToken,
      idToken: capturedTokens?.idToken,
      refreshToken: capturedTokens?.refreshToken,
      expiresAt: capturedTokens?.expiresAt,
      dpopPublicKey,
      dpopPrivateKey,
      createdAt: new Date().toISOString(),
    };

    ensureDir(opts.homeDir);
    fs.writeFileSync(path.join(opts.homeDir, 'pod-config.json'), JSON.stringify(podConfig, null, 2), {
      mode: 0o600,
    });

    return {
      authMode: 'oidc',
      oidcIssuer,
      podUrl,
      webId,
      clientId: info.clientAppId,
      sessionId: OIDC_SESSION_ID,
    };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

interface StoredOidcPodConfig {
  authMode?: 'oidc' | 'clientCredentials';
  oidcIssuer?: string;
  podUrl?: string;
  webId?: string;
  sessionId?: string;
  clientId?: string;
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  dpopPublicKey?: Record<string, unknown>;
  dpopPrivateKey?: Record<string, unknown>;
}

/**
 * Pulihkan sesi Solid-OIDC yang tersimpan:
 * 1) Gunakan accessToken + DPoP keypair di pod-config.json bila masih berlaku (mendukung login browser
 *    tanpa maupun dengan refresh_token).
 * 2) Bila accessToken sudah kedaluwarsa, lakukan refresh lewat refresh_token di solid-session.json.
 */
export async function restoreOidcSession(homeDir: string, sessionId = OIDC_SESSION_ID): Promise<Session> {
  const podConfigPath = path.join(homeDir, 'pod-config.json');
  let podConfig: StoredOidcPodConfig | null = null;
  if (fs.existsSync(podConfigPath)) {
    try {
      podConfig = JSON.parse(fs.readFileSync(podConfigPath, 'utf8')) as StoredOidcPodConfig;
    } catch {
      podConfig = null;
    }
  }

  // 1) Jika accessToken masih valid, bangun authenticated fetch DPoP secara langsung
  if (podConfig?.accessToken && podConfig.webId) {
    const notExpired =
      podConfig.expiresAt === undefined || podConfig.expiresAt * 1000 > Date.now() + 15_000;
    if (notExpired) {
      let dpopKey: { publicKey: Record<string, unknown>; privateKey: unknown } | undefined;
      const alg =
        (typeof podConfig.dpopPublicKey?.alg === 'string'
          ? podConfig.dpopPublicKey.alg
          : solidClientAuthnCore.PREFERRED_SIGNING_ALG?.[0]) ?? 'ES256';

      if (podConfig.dpopPublicKey && podConfig.dpopPrivateKey) {
        const publicKey = { ...podConfig.dpopPublicKey, alg };
        const privateKey = await jose.importJWK(podConfig.dpopPrivateKey, alg, { extractable: true });
        dpopKey = { publicKey, privateKey };
      } else {
        // Fallback: ambil publicKey/privateKey dari solid-session.json
        const storage = new FileSessionStorage(homeDir, { persistDeletes: false });
        const rawUser = await storage.get(`solidClientAuthenticationUser:${sessionId}`);
        if (rawUser) {
          try {
            const parsedUser = JSON.parse(rawUser) as { publicKey?: string; privateKey?: string };
            if (parsedUser.publicKey && parsedUser.privateKey) {
              const pubJwk = { ...(JSON.parse(parsedUser.publicKey) as Record<string, unknown>), alg };
              const privJwk = JSON.parse(parsedUser.privateKey) as Record<string, unknown>;
              const privateKey = await jose.importJWK(privJwk, alg, { extractable: true });
              dpopKey = { publicKey: pubJwk, privateKey };
            }
          } catch {
            // abaikan
          }
        }
      }

      const session = new Session({ keepAlive: false }, sessionId);
      const authFetch = solidClientAuthnCore.buildAuthenticatedFetch(podConfig.accessToken, {
        dpopKey,
        eventEmitter: session.events,
      });
      (session as any).fetch = authFetch;
      (session.info as any).isLoggedIn = true;
      (session.info as any).webId = podConfig.webId;
      (session.info as any).clientAppId = podConfig.clientId;
      return session;
    }
  }

  // 2) Jika accessToken sudah kedaluwarsa (atau tidak ada), coba refresh token dari FileSessionStorage
  const storage = new FileSessionStorage(homeDir, { persistDeletes: false });
  const session = await getSessionFromStorage(sessionId, {
    storage,
    refreshSession: true,
  });

  if (session && session.info.isLoggedIn) {
    return session;
  }

  throw new Error(
    'Sesi Solid-OIDC sudah kedaluwarsa atau belum memiliki refresh token. ' +
      'Jalankan ulang `npm run pod:login` (centang "Remember this client" di browser, atau pilih metode 2: Email & Password).'
  );
}

async function fetchJsonWithTimeout(url: string, headers?: Record<string, string>): Promise<any> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} gagal (HTTP ${response.status})`);
  }
  return response.json();
}

/**
 * Login langsung via terminal menggunakan email & password akun Solid Community (solidcommunity.net)
 * atau server Community Solid Server (CSS v7) mana pun yang menyediakan API /.account/.
 * Otomatis menemukan WebID + Pod URL milik akun tersebut dan membuat OIDC Client Credentials.
 */
export async function loginWithSolidAccount(opts: {
  issuerUrl?: string;
  email: string;
  password: string;
  podName?: string;
  podUrlOverride?: string;
  homeDir: string;
}): Promise<SolidLoginResult> {
  const oidcIssuer = normalizeIssuerUrl(opts.issuerUrl ?? DEFAULT_SOLID_ISSUER);

  const index = await fetchJsonWithTimeout(`${oidcIssuer}.account/`);
  const loginUrl: string | undefined = index?.controls?.password?.login;
  if (!loginUrl) {
    throw new Error(
      `Provider ${oidcIssuer} tidak menyediakan endpoint login password di /.account/. ` +
        'Gunakan mode login browser: npm run pod:login -- --browser'
    );
  }

  const loginResponse = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email: opts.email, password: opts.password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!loginResponse.ok) {
    throw new Error(`Login ke ${oidcIssuer} gagal (HTTP ${loginResponse.status}) — periksa email dan password.`);
  }
  const { authorization } = (await loginResponse.json()) as { authorization?: string };
  if (!authorization) {
    throw new Error('Server Solid tidak mengembalikan authorization token.');
  }

  const authHeaders = { authorization: `CSS-Account-Token ${authorization}` };
  const account = await fetchJsonWithTimeout(`${oidcIssuer}.account/`, authHeaders);

  const createTokenUrl: string | undefined = account?.controls?.account?.clientCredentials;
  if (!createTokenUrl) {
    throw new Error('Endpoint pembuatan client credentials tidak tersedia pada akun Solid ini.');
  }

  // 1) Temukan daftar Pod dari respons akun atau endpoint controls.account.pod
  let podMap: Record<string, string> =
    account?.pods && typeof account.pods === 'object' ? (account.pods as Record<string, string>) : {};
  if (Object.keys(podMap).length === 0 && typeof account?.controls?.account?.pod === 'string') {
    try {
      const podView = await fetchJsonWithTimeout(account.controls.account.pod, authHeaders);
      if (podView?.pods && typeof podView.pods === 'object') {
        podMap = podView.pods as Record<string, string>;
      }
    } catch {
      // abaikan bila gagal
    }
  }

  // 2) Temukan daftar WebID dari respons akun atau endpoint controls.account.webId
  let webIdMap: Record<string, string> =
    account?.webIds && typeof account.webIds === 'object' ? (account.webIds as Record<string, string>) : {};
  if (Object.keys(webIdMap).length === 0 && typeof account?.controls?.account?.webId === 'string') {
    try {
      const webIdView = await fetchJsonWithTimeout(account.controls.account.webId, authHeaders);
      if (webIdView?.webIdLinks && typeof webIdView.webIdLinks === 'object') {
        webIdMap = webIdView.webIdLinks as Record<string, string>;
      }
    } catch {
      // abaikan bila gagal
    }
  }

  const discoveredWebIds = Object.keys(webIdMap);
  const discoveredPods = Object.keys(podMap);

  const fallbackPodName = opts.podName ?? opts.email.split('@')[0];
  let podUrl =
    opts.podUrlOverride ??
    discoveredPods[0] ??
    (discoveredWebIds[0] ? await discoverPodUrl(discoveredWebIds[0]) : `${oidcIssuer}${fallbackPodName}/`);
  if (!podUrl.endsWith('/')) podUrl = `${podUrl}/`;

  const webId = discoveredWebIds[0] ?? `${podUrl}profile/card#me`;

  const label = `p2pod-${fallbackPodName.replace(/[^a-z0-9._-]+/gi, '-')}-${Date.now().toString(36)}`;
  const createResponse = await fetch(createTokenUrl, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ name: label, webId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!createResponse.ok) {
    const body = await createResponse.text().catch(() => '');
    throw new Error(`Gagal membuat client credentials (HTTP ${createResponse.status}) ${body}`);
  }
  const { id, secret } = (await createResponse.json()) as { id?: string; secret?: string };
  if (!id || !secret) {
    throw new Error('Server Solid tidak mengembalikan id/secret client credentials.');
  }

  const podConfig = {
    authMode: 'clientCredentials' as const,
    oidcIssuer,
    podUrl,
    webId,
    clientId: id,
    clientSecret: secret,
    createdAt: new Date().toISOString(),
  };

  ensureDir(opts.homeDir);
  fs.writeFileSync(path.join(opts.homeDir, 'pod-config.json'), JSON.stringify(podConfig, null, 2), {
    mode: 0o600,
  });

  return {
    authMode: 'clientCredentials',
    oidcIssuer,
    podUrl,
    webId,
    clientId: id,
  };
}
