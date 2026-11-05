// src/discovery/discoveryClient.ts

export interface PeerEndpoint {
  peerId: string;
  ip: string;
  port: number;
  targetPeerId?: string;
}

export class DiscoveryClient {
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly baseUrl: string) {}

  async register(peerId: string, port: number, targetPeerId?: string): Promise<void> {
    await this.request('POST', '/register', { peerId, port, targetPeerId });
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
