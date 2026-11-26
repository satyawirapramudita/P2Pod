// packages/user-client/src/discovery/discoveryClient.ts

import * as dgram from 'dgram';
import * as net from 'net';
import * as os from 'os';
import type { OnlinePeer, PeerEndpoint, ProbeResponse, RegisterResponse } from '@p2pod/shared';

export interface RegisterOptions {
  targetPeerId?: string;
  displayName?: string;
  webId?: string;
  publicHost?: string;
  publicPort?: number;
}

export function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Accept IPv4, IPv6, and DNS hostnames (needed for public/Docker deployments). */
export function isValidHost(host: string): boolean {
  const value = host.trim().replace(/^\[|\]$/g, '');
  if (!value || value.length > 253) return false;
  if (net.isIP(value)) return true;
  if (value === 'localhost') return true;
  return /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
    value
  );
}

/**
 * Validate a public host value (from env/config/flag) and return it without
 * brackets, or `undefined` when it is empty or malformed (e.g. a full URL like
 * `http://host:4000` mistakenly placed in PUBLIC_HOST). Never advertise an
 * invalid host to the Discovery Platform.
 */
export function normalizePublicHost(value: string | undefined | null): string | undefined {
  const raw = value?.trim().replace(/^\[|\]$/g, '');
  if (!raw) return undefined;
  return isValidHost(raw) ? raw : undefined;
}

export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === 'localhost' || ip === '::1' || ip === '[::1]') return true;
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (family === 6) {
    const normalized = ip.toLowerCase();
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }
  return false;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** Trik UDP "connect": tidak mengirim paket — OS hanya menentukan alamat lokal untuk rute tersebut. */
function detectLocalIpFrom(targetHost: string, targetPort: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const done = (value: string): void => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // socket sudah tertutup
      }
      resolve(value);
    };

    socket.once('error', () => done(''));
    socket.connect(targetPort, targetHost, () => {
      const address = socket.address();
      done(address && typeof address === 'object' ? address.address : '');
    });
  });
}

function pickFromInterfaces(): string {
  const candidates: Array<{ name: string; ip: string }> = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      const isIpv4 = address.family === 'IPv4' || (address.family as unknown) === 4;
      if (isIpv4 && !address.internal) {
        candidates.push({ name, ip: address.address });
      }
    }
  }
  if (candidates.length === 0) return '';
  const preferred =
    candidates.find((candidate) => /wi-?fi|wlan|wireless|ethernet|en\d|eth\d/i.test(candidate.name)) ?? candidates[0];
  return preferred.ip;
}

/**
 * Deteksi IP LAN mesin ini untuk dilaporkan ke Discovery Platform.
 *
 * Dibutuhkan saat peer co-located dengan discovery server (mis. mendaftar via localhost):
 * server hanya melihat alamat loopback, sehingga tanpa ini peer lain akan diarahkan
 * ke 127.0.0.1 miliknya sendiri. Server hanya mempercayai klaim IP dari koneksi loopback.
 */
export async function detectLocalIp(discoveryUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(discoveryUrl);
  } catch {
    return '';
  }

  // 1) Rute menuju discovery server — paling akurat bila discovery berada di mesin lain
  if (!isLoopbackHost(url.hostname)) {
    const viaDiscovery = await detectLocalIpFrom(url.hostname, Number(url.port || 80));
    if (isValidIpv4(viaDiscovery)) return viaDiscovery;
  }

  // 2) Rute default internet — berguna saat discovery berjalan di mesin yang sama
  const viaInternet = await detectLocalIpFrom('1.1.1.1', 80);
  if (isValidIpv4(viaInternet)) return viaInternet;

  // 3) Fallback terakhir: enumerasi interface jaringan, prioritaskan Wi-Fi/Ethernet
  const viaNic = pickFromInterfaces();
  return isValidIpv4(viaNic) ? viaNic : '';
}

export class DiscoveryClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private heartbeat: NodeJS.Timeout | null = null;
  private localIpPromise: Promise<string> | null = null;
  private lastResult: RegisterResponse | null = null;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token?.trim() || undefined;
  }

  get observed(): RegisterResponse | null {
    return this.lastResult;
  }

  async register(peerId: string, port: number, opts: RegisterOptions = {}): Promise<RegisterResponse> {
    const ip = await this.detectIp();
    const response = (await this.request('POST', '/register', {
      peerId,
      port,
      targetPeerId: opts.targetPeerId,
      displayName: opts.displayName,
      webId: opts.webId,
      publicHost: opts.publicHost,
      publicPort: opts.publicPort,
      ip: ip || undefined,
    })) as RegisterResponse;
    this.lastResult = response;
    return response;
  }

  async lookup(peerId: string): Promise<PeerEndpoint> {
    const result = (await this.request('GET', `/lookup/${encodeURIComponent(peerId)}`)) as PeerEndpoint;
    return result;
  }

  /** Daftar user yang sedang online di Discovery Platform. */
  async listPeers(): Promise<OnlinePeer[]> {
    const result = (await this.request('GET', '/peers')) as { peers: OnlinePeer[] };
    return result.peers;
  }

  /** Minta Discovery Platform menguji apakah port inbound peer ini terjangkau. */
  async probe(peerId: string): Promise<ProbeResponse> {
    return (await this.request('GET', `/probe/${encodeURIComponent(peerId)}`)) as ProbeResponse;
  }

  async unregister(peerId: string): Promise<void> {
    await this.request('POST', '/unregister', { peerId });
  }

  startHeartbeat(peerId: string, port: number, opts: RegisterOptions = {}, intervalMs = 20_000): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.register(peerId, port, opts).catch(() => {
        // diamkan — heartbeat berikutnya akan mencoba lagi
      });
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private detectIp(): Promise<string> {
    if (!this.localIpPromise) {
      this.localIpPromise = detectLocalIp(this.baseUrl).then((ip) => {
        if (!ip) {
          this.localIpPromise = null; // jangan cache kegagalan — coba lagi saat heartbeat berikutnya
        }
        return ip;
      });
    }
    return this.localIpPromise;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${cleanPath}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(this.token ? { 'x-p2pod-token': this.token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5000),
      });
    } catch (err: any) {
      throw new Error(`Discovery Platform tidak terjangkau (${this.baseUrl}): ${err.message}`);
    }

    if (!response.ok) {
      let detail = '';
      try {
        const parsed = (await response.json()) as { error?: string };
        detail = parsed.error ?? '';
      } catch {
        // body bukan JSON — abaikan
      }
      throw new Error(`Discovery request ${method} ${path} gagal (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
    }

    return response.json();
  }
}