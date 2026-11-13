// packages/user-client/src/modules/pod/provision.ts
// Setup Pod lokal (Community Solid Server) + provisioning akun Pod.

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir } from '../../identity/identity';

export interface PodAccountResult {
  podUrl: string;
  webId: string;
  clientId: string;
}

export interface LocalPodResult {
  podUrl: string;
  webId?: string;
  provisioned: boolean;
}

// CATATAN: timer di sini TIDAK boleh unref — saat menunggu CSS boot tidak ada handle
// lain yang menahan event loop, sehingga proses bisa keluar prematur.
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function sanitizePodName(raw: string): string {
  const sanitized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : `user-${crypto.randomBytes(3).toString('hex')}`;
}

export function podNameFromDisplayName(displayName: string): string {
  return sanitizePodName(displayName);
}

/** Nama pod dari segmen terakhir URL pod (fallback: display name). */
export function podNameFromUrl(podUrl: string, fallback: string): string {
  try {
    const url = new URL(podUrl);
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    const last = segments[segments.length - 1];
    if (last) return sanitizePodName(decodeURIComponent(last));
  } catch {
    // fallback di bawah
  }
  return sanitizePodName(fallback);
}

export function generatePassword(): string {
  return `p2pod-${crypto.randomBytes(6).toString('hex')}`;
}

/** Respons HTTP apa pun (termasuk 401) dianggap "hidup". */
export async function isHttpReachable(url: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.text().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Deteksi pod lokal: http://localhost:<port>/... → kembalikan port CSS-nya; selain itu null. */
export function localCssPortOf(podUrl: string): number | null {
  try {
    const url = new URL(podUrl);
    const host = url.hostname.toLowerCase();
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') return null;
    const port = Number(url.port || 80);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function cssSeedPath(name: string): string {
  // Disimpan di .css/seeds/ (gitignored) — seed alice/bob demo tetap di css/.
  return path.join(process.cwd(), '.css', 'seeds', `seed-${name}.json`);
}

/** Pastikan file seed CSS ada. Bila sudah ada, kembalikan password yang tersimpan di file itu. */
export function ensureSeedFile(name: string, email: string, password: string): string {
  const seedPath = cssSeedPath(name);
  if (fs.existsSync(seedPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as Array<{ password?: string }>;
      const existingPassword = parsed[0]?.password;
      if (typeof existingPassword === 'string' && existingPassword.length > 0) return existingPassword;
    } catch {
      // file rusak — tulis ulang di bawah
    }
  }
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  fs.writeFileSync(seedPath, JSON.stringify([{ email, password, pods: [{ name }] }], null, 2));
  return password;
}

function resolveCssServerJs(): string {
  const packageJsonPath = require.resolve('@solid/community-server/package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    bin?: Record<string, string> | string;
  };
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['community-solid-server'];
  if (!binRel) {
    throw new Error('bin community-solid-server tidak ditemukan di package @solid/community-server');
  }
  return path.join(path.dirname(packageJsonPath), binRel);
}

/**
 * Pastikan Community Solid Server berjalan di port tsb (spawn detached bila belum ada).
 * Data: .css/<name>/ · Log: .css/<name>-css.log · PID: .css/<name>-css.pid
 */
export async function ensureLocalCssRunning(opts: { cssPort: number; name: string }): Promise<void> {
  const baseUrl = `http://localhost:${opts.cssPort}/`;
  if (await isHttpReachable(baseUrl)) return;

  const cssRoot = path.join(process.cwd(), '.css');
  const dataDir = path.join(cssRoot, opts.name);
  ensureDir(dataDir);

  const seedPath = cssSeedPath(opts.name);
  const serverJs = resolveCssServerJs();
  const logPath = path.join(cssRoot, `${opts.name}-css.log`);
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(
    process.execPath,
    [
      serverJs,
      '-c',
      '@css:config/file.json',
      '-f',
      dataDir,
      '-p',
      String(opts.cssPort),
      '-b',
      baseUrl,
      '--seedConfig',
      seedPath,
    ],
    { detached: true, stdio: ['ignore', logFd, logFd], cwd: process.cwd(), windowsHide: true }
  );
  child.unref();
  fs.closeSync(logFd);

  if (child.pid) {
    fs.writeFileSync(path.join(cssRoot, `${opts.name}-css.pid`), String(child.pid));
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 90_000) {
    if (await isHttpReachable(baseUrl)) return;
    await delay(1500);
  }
  throw new Error(`CSS tidak siap dalam 90 dtk — lihat log: ${logPath}`);
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any> {
  // Timeout longgar: request pertama ke CSS yang baru boot bisa lambat (account index).
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`GET ${url} gagal (HTTP ${response.status})`);
  }
  return response.json();
}

/**
 * Provisioning akun Pod: login ke CSS → buat client credentials → simpan ke <home>/pod-config.json.
 * (Logika sama dengan scripts/setup-pod-account.ts yang kini memakai fungsi ini.)
 */
export async function provisionPodAccount(opts: {
  cssUrl: string;
  email: string;
  password: string;
  podName: string;
  homeDir: string;
}): Promise<PodAccountResult> {
  const cssUrl = opts.cssUrl.endsWith('/') ? opts.cssUrl : `${opts.cssUrl}/`;

  const index = await fetchJson(`${cssUrl}.account/`);
  const loginUrl: string | undefined = index?.controls?.password?.login;
  if (!loginUrl) {
    throw new Error(
      'CSS tidak menyediakan login email/password di /.account/ (fitur account management mungkin dinonaktifkan)'
    );
  }

  const loginResponse = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: opts.email, password: opts.password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!loginResponse.ok) {
    throw new Error(`Login ke CSS gagal (HTTP ${loginResponse.status}) — cek email/password`);
  }
  const { authorization } = (await loginResponse.json()) as { authorization?: string };
  if (!authorization) {
    throw new Error('CSS tidak mengembalikan authorization token');
  }

  const account = await fetchJson(`${cssUrl}.account/`, {
    authorization: `CSS-Account-Token ${authorization}`,
  });
  const createTokenUrl: string | undefined = account?.controls?.account?.clientCredentials;
  if (!createTokenUrl) {
    throw new Error('Endpoint client credentials tidak tersedia pada kontrol akun');
  }

  const podUrl = `${cssUrl}${opts.podName}/`;
  const webId = `${podUrl}profile/card#me`;

  const createResponse = await fetch(createTokenUrl, {
    method: 'POST',
    headers: {
      authorization: `CSS-Account-Token ${authorization}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: `p2pod-${opts.podName}`, webId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!createResponse.ok) {
    const body = await createResponse.text().catch(() => '');
    throw new Error(`Gagal membuat client credentials (HTTP ${createResponse.status}) ${body}`);
  }
  const { id, secret } = (await createResponse.json()) as { id?: string; secret?: string };
  if (!id || !secret) {
    throw new Error('CSS tidak mengembalikan id/secret client credentials');
  }

  const config = {
    oidcIssuer: cssUrl,
    podUrl,
    webId,
    clientId: id,
    clientSecret: secret,
    createdAt: new Date().toISOString(),
  };

  ensureDir(opts.homeDir);
  fs.writeFileSync(path.join(opts.homeDir, 'pod-config.json'), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });

  return { podUrl, webId, clientId: id };
}

/**
 * Provisioning dengan satu percobaan ulang: CSS yang baru cold-start kadang lambat
 * merespons request pertama, sehingga percobaan pertama bisa timeout.
 */
async function provisionWithRetry(
  opts: Parameters<typeof provisionPodAccount>[0],
  attempts = 2
): Promise<PodAccountResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await provisionPodAccount(opts);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await delay(2000);
    }
  }
  throw lastError;
}

/**
 * Setup Pod lokal lengkap: seed → pastikan CSS jalan → provisioning akun (lewati bila
 * pod-config.json sudah ada).
 */
export async function setupLocalPod(opts: {
  homeDir: string;
  displayName: string;
  cssPort: number;
  email: string;
  password: string;
  podUrl: string;
}): Promise<LocalPodResult> {
  const name = podNameFromUrl(opts.podUrl, opts.displayName);
  const cssUrl = `http://localhost:${opts.cssPort}/`;
  const normalizedPodUrl = `${cssUrl}${name}/`;

  const effectivePassword = ensureSeedFile(name, opts.email, opts.password);
  await ensureLocalCssRunning({ cssPort: opts.cssPort, name });

  const configPath = path.join(opts.homeDir, 'pod-config.json');
  if (fs.existsSync(configPath)) {
    return { podUrl: normalizedPodUrl, provisioned: false };
  }

  const result = await provisionWithRetry({
    cssUrl,
    email: opts.email,
    password: effectivePassword,
    podName: name,
    homeDir: opts.homeDir,
  });
  return { podUrl: result.podUrl, webId: result.webId, provisioned: true };
}
