// packages/discovery-platform/src/index.ts

import * as net from 'net';
import * as os from 'os';
import express from 'express';
import type { OnlinePeer, ProbeResponse, RegisterResponse } from '@p2pod/shared';

interface PeerRecord {
  peerId: string;
  displayName?: string;
  webId?: string;
  host: string;
  port: number;
  observedIp: string;
  advertised: boolean;
  lastSeen: number;
  targetPeerId?: string;
  reachable?: boolean;
  lastProbeAt?: number;
}

const PEER_TTL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_PORT = 4000;

const DISCOVERY_TOKEN = process.env.DISCOVERY_TOKEN?.trim() ?? '';
const ALLOW_ADVERTISE = process.env.ALLOW_ADVERTISE !== '0';
const PUBLIC_URL = process.env.PUBLIC_URL?.trim() ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST?.trim() ?? '';

const peers = new Map<string, PeerRecord>();

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? true : false);
app.use((req, _res, next) => {
  if (req.url.startsWith('//')) {
    req.url = req.url.replace(/^\/+/, '/');
  }
  next();
});
app.use(express.json());

function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const value = ip.split(',')[0].trim();
  if (value.startsWith('::ffff:')) return value.slice(7);
  if (value === '::1') return '127.0.0.1';
  if (value === '[::1]') return '127.0.0.1';
  return value;
}

function isValidHost(value: string): boolean {
  const host = value.trim().replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) return false;
  if (net.isIP(host)) return true;
  if (host === 'localhost') return true;
  return /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
    host
  );
}

function isPrivateHost(host: string): boolean {
  if (!host) return true;
  if (host === 'localhost') return true;
  const family = net.isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map((part) => Number(part));
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    );
  }
  if (family === 6) {
    const normalized = host.toLowerCase();
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

function short(peerId: string): string {
  return `${peerId.slice(0, 10)}...`;
}

function readToken(req: express.Request): string {
  const header = req.header('x-p2pod-token');
  if (header) return header.trim();
  const authorization = req.header('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return '';
}

function requireDiscoveryToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!DISCOVERY_TOKEN) {
    next();
    return;
  }
  if (readToken(req) !== DISCOVERY_TOKEN) {
    res.status(401).json({ error: 'Token Discovery Platform tidak valid.' });
    return;
  }
  next();
}

app.post('/register', requireDiscoveryToken, (req, res) => {
  const {
    peerId,
    port,
    displayName: displayNameRaw,
    targetPeerId,
    publicHost: publicHostRaw,
    publicPort: publicPortRaw,
    ip: legacyClaimedIpRaw,
    webId: webIdRaw,
  } = (req.body ?? {}) as {
    peerId?: unknown;
    port?: unknown;
    displayName?: unknown;
    targetPeerId?: unknown;
    publicHost?: unknown;
    publicPort?: unknown;
    ip?: unknown;
    webId?: unknown;
  };
  const portNum = Number(port);

  if (typeof peerId !== 'string' || peerId.length === 0) {
    res.status(400).json({ error: 'peerId (string) wajib diisi' });
    return;
  }
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
    res.status(400).json({ error: 'port (1-65535) wajib diisi' });
    return;
  }
  if (targetPeerId !== undefined && targetPeerId !== null && typeof targetPeerId !== 'string') {
    res.status(400).json({ error: 'targetPeerId harus string bila diisi' });
    return;
  }
  if (displayNameRaw !== undefined && displayNameRaw !== null && typeof displayNameRaw !== 'string') {
    res.status(400).json({ error: 'displayName harus string bila diisi' });
    return;
  }
  if (webIdRaw !== undefined && webIdRaw !== null && typeof webIdRaw !== 'string') {
    res.status(400).json({ error: 'webId harus string bila diisi' });
    return;
  }

  const displayName =
    typeof displayNameRaw === 'string' && displayNameRaw.trim().length > 0
      ? displayNameRaw.trim().slice(0, 48)
      : undefined;
  const webId =
    typeof webIdRaw === 'string' && webIdRaw.trim().length > 0
      ? webIdRaw.trim().slice(0, 256)
      : undefined;

  const observedIp = normalizeIp(req.ip || req.socket.remoteAddress);

  // Backward compatibility: older clients send the LAN IP in `ip`.
  const claimedHostRaw =
    typeof publicHostRaw === 'string' && publicHostRaw.trim().length > 0
      ? publicHostRaw.trim()
      : typeof legacyClaimedIpRaw === 'string' && legacyClaimedIpRaw.trim().length > 0
        ? legacyClaimedIpRaw.trim()
        : '';
  const claimedHost =
    claimedHostRaw && isValidHost(claimedHostRaw)
      ? claimedHostRaw.replace(/^\[|\]$/g, '')
      : '';
  const claimedPortNum = Number(publicPortRaw);
  const claimedPort =
    Number.isInteger(claimedPortNum) && claimedPortNum > 0 && claimedPortNum <= 65535
      ? claimedPortNum
      : portNum;

  // The host is trusted when the connection comes from a loopback/private address
  // (same machine, LAN, or container network), or when the client advertises the
  // same address discovery already observed. The external port is always safe to
  // accept because it only affects this peer's own record (router port-forwarding).
  const canAdvertiseHost =
    ALLOW_ADVERTISE &&
    claimedHost.length > 0 &&
    (isPrivateHost(observedIp) || observedIp === 'unknown' || claimedHost === observedIp);
  const effectiveHost = canAdvertiseHost ? claimedHost : observedIp;
  const effectivePort = ALLOW_ADVERTISE && claimedPort > 0 ? claimedPort : portNum;
  const advertised = effectiveHost !== observedIp || effectivePort !== portNum;

  const target = typeof targetPeerId === 'string' && targetPeerId.length > 0 ? targetPeerId : undefined;
  const record: PeerRecord = {
    peerId,
    displayName,
    webId,
    host: effectiveHost,
    port: effectivePort,
    observedIp,
    advertised,
    lastSeen: Date.now(),
    targetPeerId: target,
  };
  peers.set(peerId, record);
  console.log(
    `[discovery] register ${short(peerId)}${record.displayName ? ` (${record.displayName})` : ''} -> ${record.host}:${record.port}` +
      `${advertised ? ` (advertised; observed ${observedIp})` : ''}` +
      `${record.webId ? ` [webId: ${record.webId}]` : ''}` +
      `${target ? ` (target: ${short(target)})` : ''} (peer aktif: ${peers.size})`
  );
  const response: RegisterResponse = {
    ok: true,
    ip: record.host,
    port: record.port,
    observedIp,
    advertised,
  };
  res.json(response);
});

app.get('/lookup/:peerId', (req, res) => {
  const record = peers.get(req.params.peerId);
  if (!record) {
    res.status(404).json({ error: 'Peer tidak ditemukan (offline atau belum terdaftar)' });
    return;
  }
  res.json({
    peerId: record.peerId,
    ip: record.host,
    port: record.port,
    targetPeerId: record.targetPeerId,
    webId: record.webId,
    reachable: record.reachable,
  });
});

app.get('/peers', (_req, res) => {
  const list: OnlinePeer[] = [...peers.values()]
    .map((record) => ({
      peerId: record.peerId,
      displayName: record.displayName,
      webId: record.webId,
      lastSeen: record.lastSeen,
      publicEndpoint: `${record.host}:${record.port}`,
      reachable: record.reachable,
    }))
    .sort(
      (a, b) =>
        (a.displayName ?? '').localeCompare(b.displayName ?? '') || a.peerId.localeCompare(b.peerId)
    );
  res.json({ peers: list });
});

app.get('/probe/:peerId', (req, res) => {
  const record = peers.get(req.params.peerId);
  if (!record) {
    res.status(404).json({ error: 'Peer tidak ditemukan (offline atau belum terdaftar)' });
    return;
  }

  const checkedAt = Date.now();
  const probeResponse: ProbeResponse = {
    reachable: false,
    host: record.host,
    port: record.port,
    checkedAt,
  };

  const socket = net.createConnection({ host: record.host, port: record.port, timeout: PROBE_TIMEOUT_MS });
  const finish = (reachable: boolean, error?: string): void => {
    probeResponse.reachable = reachable;
    if (error) probeResponse.error = error;
    record.reachable = reachable;
    record.lastProbeAt = checkedAt;
    if (!socket.destroyed) socket.destroy();
    res.json(probeResponse);
  };

  socket.once('connect', () => finish(true));
  socket.once('timeout', () => finish(false, `timeout ${PROBE_TIMEOUT_MS}ms`));
  socket.once('error', (err: Error) => finish(false, err.message));
});

app.post('/unregister', requireDiscoveryToken, (req, res) => {
  const { peerId } = (req.body ?? {}) as { peerId?: unknown };
  if (typeof peerId !== 'string' || peerId.length === 0) {
    res.status(400).json({ error: 'peerId (string) wajib diisi' });
    return;
  }
  peers.delete(peerId);
  console.log(`[discovery] unregister ${short(peerId)} (peer aktif: ${peers.size})`);
  res.json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    peers: peers.size,
    uptime: process.uptime(),
    publicUrl: publicBaseUrl(port) || undefined,
    allowAdvertise: ALLOW_ADVERTISE,
    tokenRequired: Boolean(DISCOVERY_TOKEN),
  });
});

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, record] of peers) {
    if (now - record.lastSeen > PEER_TTL_MS) {
      peers.delete(id);
      console.log(`[discovery] expire ${short(id)} (tanpa heartbeat > ${PEER_TTL_MS / 1000}s)`);
    }
  }
}, CLEANUP_INTERVAL_MS);
reaper.unref();

function lanAddresses(): Array<{ name: string; ip: string }> {
  const candidates: Array<{ name: string; ip: string }> = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      const isIpv4 = address.family === 'IPv4' || (address.family as unknown) === 4;
      if (isIpv4 && !address.internal) {
        candidates.push({ name, ip: address.address });
      }
    }
  }
  // Prioritaskan Wi-Fi/Ethernet agar URL yang paling relevan tampil lebih dulu.
  const rank = (name: string): number => (/wi-?fi|wlan|wireless|ethernet|en\d|eth\d/i.test(name) ? 0 : 1);
  candidates.sort((a, b) => rank(a.name) - rank(b.name));
  return candidates;
}

function publicBaseUrl(port: number): string | null {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/+$/, '');
  if (PUBLIC_HOST) {
    const host = isValidHost(PUBLIC_HOST) ? PUBLIC_HOST : '';
    if (host) return `http://${host}:${port}`;
  }
  return null;
}

const port = process.env.PORT ? Number(process.env.PORT) : Number(process.argv[2] ?? DEFAULT_PORT);
app.listen(port, '0.0.0.0', () => {
  console.log(`[discovery] listening on 0.0.0.0:${port} (TTL peer: ${PEER_TTL_MS / 1000}s)`);
  if (DISCOVERY_TOKEN) {
    console.log('[discovery] Token registrasi aktif (klien wajib mengirim token yang sama).');
  }
  if (!ALLOW_ADVERTISE) {
    console.log('[discovery] ALLOW_ADVERTISE=0 — endpoint publik yang diklaim klien diabaikan.');
  }

  const publicUrl = publicBaseUrl(port);
  console.log('');
  if (publicUrl) {
    console.log('[discovery] URL publik untuk dibagikan:');
    console.log(`  ${publicUrl}/`);
  }
  const lans = lanAddresses();
  if (lans.length > 0) {
    console.log('[discovery] URL LAN untuk jaringan lokal:');
    for (const { name, ip } of lans) {
      console.log(`  http://${ip}:${port}/   (${name})`);
    }
  } else {
    console.log('[discovery] Tidak ada alamat LAN terdeteksi — cek koneksi jaringan.');
  }
  console.log('[discovery] Untuk akses internet: buka/port-forward TCP port ini di firewall/router.');
  console.log('[discovery] Opsional: set PUBLIC_URL=https://discovery.example.com agar banner menampilkan URL publik.');

  if (process.platform === 'win32') {
    console.log('');
    console.log('[discovery] Jika device lain tidak bisa connect, izinkan port di Windows Firewall');
    console.log('[discovery] (sekali saja, jalankan di PowerShell sebagai Administrator):');
    console.log(
      `  New-NetFirewallRule -DisplayName "P2Pod Discovery ${port}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow`
    );
  }
});