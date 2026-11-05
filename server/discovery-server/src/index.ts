// server/discovery-server/src/index.ts

import express from 'express';

interface PeerRecord {
  peerId: string;
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
app.use(express.json());

function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function short(peerId: string): string {
  return `${peerId.slice(0, 10)}...`;
}

app.post('/register', (req, res) => {
  const { peerId, port, targetPeerId } = (req.body ?? {}) as {
    peerId?: unknown;
    port?: unknown;
    targetPeerId?: unknown;
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

  const target = typeof targetPeerId === 'string' && targetPeerId.length > 0 ? targetPeerId : undefined;
  const record: PeerRecord = {
    peerId,
    ip: normalizeIp(req.socket.remoteAddress),
    port: portNum,
    lastSeen: Date.now(),
    targetPeerId: target,
  };
  peers.set(peerId, record);
  console.log(
    `[discovery] register ${short(peerId)} -> ${record.ip}:${record.port}` +
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
  res.json({ peerId: record.peerId, ip: record.ip, port: record.port, targetPeerId: record.targetPeerId });
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

const port = process.env.PORT ? Number(process.env.PORT) : Number(process.argv[2] ?? DEFAULT_PORT);
app.listen(port, '0.0.0.0', () => {
  console.log(`[discovery] listening on 0.0.0.0:${port} (TTL peer: ${PEER_TTL_MS / 1000}s)`);
});
