// packages/discovery-platform/src/index.ts

import * as os from 'os';
import express from 'express';
import type { OnlinePeer } from '@p2pod/shared';

interface PeerRecord {
  peerId: string;
  displayName?: string;
  webId?: string;
  ip: string;
  port: number;
  lastSeen: number;
  targetPeerId?: string;
}

const PEER_TTL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 15_000;
const DEFAULT_PORT = 4000;

const peers = new Map<string, PeerRecord>();

const app = express();
app.use((req, _res, next) => {
  if (req.url.startsWith('//')) {
    req.url = req.url.replace(/^\/+/, '/');
  }
  next();
});
app.use(express.json());

function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function isPlausibleIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function short(peerId: string): string {
  return `${peerId.slice(0, 10)}...`;
}

app.post('/register', (req, res) => {
  const {
    peerId,
    port,
    displayName: displayNameRaw,
    targetPeerId,
    ip: claimedIpRaw,
    webId: webIdRaw,
  } = (req.body ?? {}) as {
    peerId?: unknown;
    port?: unknown;
    displayName?: unknown;
    targetPeerId?: unknown;
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
  if (claimedIpRaw !== undefined && claimedIpRaw !== null && typeof claimedIpRaw !== 'string') {
    res.status(400).json({ error: 'ip harus string bila diisi' });
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

  const remoteIp = normalizeIp(req.socket.remoteAddress);
  const claimedIp = typeof claimedIpRaw === 'string' && isPlausibleIpv4(claimedIpRaw) ? claimedIpRaw : undefined;
  // Peer yang co-located dengan discovery server (mendaftar via localhost) hanya terlihat
  // sebagai loopback — khusus kasus itu, percayai IP LAN yang diklaim klien; jika tidak,
  // peer di mesin lain akan diarahkan ke 127.0.0.1 miliknya sendiri.
  // Koneksi remote selalu memakai remoteAddress sehingga IP tidak bisa dipalsukan.
  const useClaimed = (remoteIp === '127.0.0.1' || remoteIp === 'unknown') && claimedIp !== undefined;
  const effectiveIp = useClaimed && claimedIp ? claimedIp : remoteIp;

  const target = typeof targetPeerId === 'string' && targetPeerId.length > 0 ? targetPeerId : undefined;
  const record: PeerRecord = {
    peerId,
    displayName,
    webId,
    ip: effectiveIp,
    port: portNum,
    lastSeen: Date.now(),
    targetPeerId: target,
  };
  peers.set(peerId, record);
  console.log(
    `[discovery] register ${short(peerId)}${record.displayName ? ` (${record.displayName})` : ''} -> ${record.ip}:${record.port}` +
      `${useClaimed ? ' (loopback→klaim klien)' : ''}` +
      `${record.webId ? ` [webId: ${record.webId}]` : ''}` +
      `${target ? ` (target: ${short(target)})` : ''} (peer aktif: ${peers.size})`
  );
  res.json({ ok: true, ip: record.ip, port: record.port });
});

app.get('/lookup/:peerId', (req, res) => {
  const record = peers.get(req.params.peerId);
  if (!record) {
    res.status(404).json({ error: 'Peer tidak ditemukan (offline atau belum terdaftar)' });
    return;
  }
  res.json({
    peerId: record.peerId,
    ip: record.ip,
    port: record.port,
    targetPeerId: record.targetPeerId,
    webId: record.webId,
  });
});

app.get('/peers', (_req, res) => {
  const list: OnlinePeer[] = [...peers.values()]
    .map((record) => ({
      peerId: record.peerId,
      displayName: record.displayName,
      webId: record.webId,
      lastSeen: record.lastSeen,
    }))
    .sort(
      (a, b) =>
        (a.displayName ?? '').localeCompare(b.displayName ?? '') || a.peerId.localeCompare(b.peerId)
    );
  res.json({ peers: list });
});

app.post('/unregister', (req, res) => {
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
  res.json({ ok: true, peers: peers.size, uptime: process.uptime() });
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

const port = process.env.PORT ? Number(process.env.PORT) : Number(process.argv[2] ?? DEFAULT_PORT);
app.listen(port, '0.0.0.0', () => {
  console.log(`[discovery] listening on 0.0.0.0:${port} (TTL peer: ${PEER_TTL_MS / 1000}s)`);

  const lans = lanAddresses();
  console.log('');
  if (lans.length > 0) {
    console.log('[discovery] Bagikan URL ini ke user lain di jaringan yang sama:');
    for (const { name, ip } of lans) {
      console.log(`  http://${ip}:${port}/   (${name})`);
    }
  } else {
    console.log('[discovery] Tidak ada alamat LAN terdeteksi — cek koneksi jaringan.');
  }

  if (process.platform === 'win32') {
    console.log('');
    console.log('[discovery] Jika device lain tidak bisa connect, izinkan port di Windows Firewall');
    console.log('[discovery] (sekali saja, jalankan di PowerShell sebagai Administrator):');
    console.log(
      `  New-NetFirewallRule -DisplayName "P2Pod Discovery ${port}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow`
    );
  }
});
