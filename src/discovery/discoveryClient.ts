// src/discovery/discoveryClient.ts

import * as dgram from 'dgram';
import * as os from 'os';

export interface PeerEndpoint {
  peerId: string;
  ip: string;
  port: number;
  targetPeerId?: string;
}

export function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
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
  private heartbeat: NodeJS.Timeout | null = null;
  private localIpPromise: Promise<string> | null = null;

  constructor(private readonly baseUrl: string) {}

  async register(peerId: string, port: number, targetPeerId?: string): Promise<void> {
    const ip = await this.detectIp();
    await this.request('POST', '/register', { peerId, port, targetPeerId, ip: ip || undefined });
  }

  async lookup(peerId: string): Promise<PeerEndpoint> {
    const result = (await this.request('GET', `/lookup/${encodeURIComponent(peerId)}`)) as PeerEndpoint;
    return result;
  }

  async unregister(peerId: string): Promise<void> {
    await this.request('POST', '/unregister', { peerId });
  }

  startHeartbeat(peerId: string, port: number, targetPeerId?: string, intervalMs = 20_000): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.register(peerId, port, targetPeerId).catch(() => {
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
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
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
