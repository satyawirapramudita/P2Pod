// scripts/test-web-bridge.ts
// Pengujian Fase 1: Multi-session PeerApp daemon + WebBridge (HTTP REST, WebSocket, Origin guard, reconnect).

import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { Identity } from '../packages/user-client/src/identity/identity';
import { saveConfig } from '../packages/user-client/src/config';
import { WebBridge } from '../packages/user-client/src/web/webBridge';

const DISCOVERY_PORT = 4199;
const DISCOVERY_URL = `http://127.0.0.1:${DISCOVERY_PORT}`;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT GAGAL: ${msg}`);
  console.log(`  OK  ${msg}`);
}

function killChild(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // sudah mati
    }
  } else {
    child.kill('SIGKILL');
  }
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Discovery tidak siap di ${url}`);
}

async function waitForWsEvent<T = any>(
  events: any[],
  predicate: (ev: any) => boolean,
  timeoutMs = 15_000
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timeout menunggu event WebSocket yang diharapkan');
}

function setupTempProfile(dir: string, displayName: string, listenPort: number): Identity {
  const identity = Identity.loadOrCreate(dir, displayName);
  const now = new Date().toISOString();
  saveConfig(dir, {
    displayName,
    discoveryUrl: DISCOVERY_URL,
    listenPort,
    pod: { enabled: false },
    createdAt: now,
    updatedAt: now,
  });
  return identity;
}

async function main(): Promise<void> {
  console.log('[test-web-bridge] Menjalankan Discovery Platform sementara...');
  const tsNodeBin = require.resolve('ts-node/dist/bin.js');
  const discoveryProc = spawn(
    process.execPath,
    [tsNodeBin, 'packages/discovery-platform/src/index.ts', String(DISCOVERY_PORT)],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(DISCOVERY_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let discoveryErr = '';
  discoveryProc.stderr?.on('data', (chunk: Buffer) => {
    discoveryErr += chunk.toString();
  });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p2pod-bridge-test-'));
  const aliceHome = path.join(tempRoot, 'alice');
  const bobHome = path.join(tempRoot, 'bob');
  let aliceBridge: WebBridge | null = null;
  let bobBridge: WebBridge | null = null;
  let aliceWs: WebSocket | null = null;
  let bobWs: WebSocket | null = null;

  try {
    try {
      await waitForHealth(DISCOVERY_URL);
    } catch (err) {
      if (discoveryErr) console.error('[discovery stderr]', discoveryErr);
      throw err;
    }
    console.log('[test-web-bridge] Discovery Platform siap.');

    const aliceId = setupTempProfile(aliceHome, 'alice-web', 5710);
    const bobId = setupTempProfile(bobHome, 'bob-web', 5711);

    aliceBridge = new WebBridge({ homeDir: aliceHome, uiPort: 3410 });
    bobBridge = new WebBridge({ homeDir: bobHome, uiPort: 3411 });

    const aliceInfo = await aliceBridge.start();
    const bobInfo = await bobBridge.start();
    assert(aliceInfo.url === `http://127.0.0.1:${aliceInfo.port}`, `Alice bridge aktif di ${aliceInfo.url}`);
    assert(bobInfo.url === `http://127.0.0.1:${bobInfo.port}`, `Bob bridge aktif di ${bobInfo.url}`);

    // 1. Uji keamanan Origin Guard (HTTP & WebSocket)
    const evilHttp = await fetch(`${aliceInfo.url}/api/state`, {
      headers: { origin: 'https://evil.example.com' },
    });
    assert(evilHttp.status === 403, 'HTTP Origin non-localhost ditolak (403)');

    const goodCors = await fetch(`${aliceInfo.url}/api/state`, {
      headers: { origin: 'http://localhost:5173' },
    });
    assert(
      goodCors.status === 200 && goodCors.headers.get('access-control-allow-origin') === 'http://localhost:5173',
      'HTTP Origin localhost:5173 diizinkan dengan CORS header'
    );

    const evilWsRejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${aliceInfo.port}/ws`, {
        headers: { origin: 'https://evil.example.com' },
      });
      ws.once('error', () => resolve(true));
      ws.once('open', () => {
        ws.close();
        resolve(false);
      });
    });
    assert(evilWsRejected, 'WebSocket upgrade dari Origin non-localhost ditolak');

    // 2. Koneksi WebSocket lokal & cek payload init
    const aliceEvents: any[] = [];
    const bobEvents: any[] = [];

    aliceWs = new WebSocket(`ws://127.0.0.1:${aliceInfo.port}/ws`, {
      headers: { origin: 'http://localhost:5173' },
    });
    bobWs = new WebSocket(`ws://127.0.0.1:${bobInfo.port}/ws`, {
      headers: { origin: 'http://localhost:5173' },
    });
    aliceWs.on('message', (data) => aliceEvents.push(JSON.parse(data.toString())));
    bobWs.on('message', (data) => bobEvents.push(JSON.parse(data.toString())));

    const aliceInit = await waitForWsEvent(aliceEvents, (e) => e.type === 'init');
    const bobInit = await waitForWsEvent(bobEvents, (e) => e.type === 'init');
    assert(aliceInit.state.local.peerId === aliceId.peerId, 'WS init Alice memuat state lokal');
    assert(bobInit.state.local.peerId === bobId.peerId, 'WS init Bob memuat state lokal');

    // 3. Cek GET /api/peers
    const peersRes = (await (await fetch(`${aliceInfo.url}/api/peers`)).json()) as { peers: any[] };
    assert(
      peersRes.peers.some((p) => p.peerId === bobId.peerId && p.displayName === 'bob-web'),
      'GET /api/peers Alice menemukan bob-web'
    );

    // 4. Sesi #1: Connect Alice -> Bob via REST API
    const connectRes = await fetch(`${aliceInfo.url}/api/session/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: bobId.peerId, label: 'bob-web' }),
    });
    assert(connectRes.ok, 'POST /api/session/connect diterima');

    const aliceStarted = await waitForWsEvent(aliceEvents, (e) => e.type === 'sessionStarted');
    const bobStarted = await waitForWsEvent(bobEvents, (e) => e.type === 'sessionStarted');
    const chatId = aliceStarted.session.chatId as string;
    assert(chatId === bobStarted.session.chatId, 'Sesi #1 terbentuk dengan chatId identik');

    // 5. Kirim pesan Alice -> Bob & cek real-time WS push
    const sendRes = await fetch(`${aliceInfo.url}/api/session/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Halo Bob dari WebBridge sesi 1' }),
    });
    assert(sendRes.ok, 'POST /api/session/message berhasil');

    const bobRecv = await waitForWsEvent(
      bobEvents,
      (e) => e.type === 'message' && e.message?.text === 'Halo Bob dari WebBridge sesi 1'
    );
    assert(bobRecv.message.direction === 'received', 'Bob menerima pesan real-time lewat WebSocket');

    // 6. Disconnect Sesi #1 — daemon HARUS tetap hidup (idle)
    const discRes = await fetch(`${aliceInfo.url}/api/session/disconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert(discRes.ok, 'POST /api/session/disconnect berhasil');

    await waitForWsEvent(aliceEvents, (e) => e.type === 'sessionClosed');
    await waitForWsEvent(bobEvents, (e) => e.type === 'sessionClosed');

    const aliceStateAfter = (await (await fetch(`${aliceInfo.url}/api/state`)).json()) as { state: any };
    const bobStateAfter = (await (await fetch(`${bobInfo.url}/api/state`)).json()) as { state: any };
    assert(
      aliceStateAfter.state.nodeStatus === 'running' && aliceStateAfter.state.sessionStatus === 'idle',
      'Alice tetap running (idle) setelah disconnect sesi'
    );
    assert(
      bobStateAfter.state.nodeStatus === 'running' && bobStateAfter.state.sessionStatus === 'idle',
      'Bob tetap running (idle) setelah remote memutus sesi'
    );

    // 7. Cek riwayat offline lewat GET /api/chats dan GET /api/chats/:chatId/messages
    const chatsRes = (await (await fetch(`${bobInfo.url}/api/chats`)).json()) as { chats: any[] };
    assert(
      chatsRes.chats.some((c) => c.chatId === chatId && c.messageCount === 1),
      'GET /api/chats memuat daftar chat offline beserta jumlah pesan'
    );
    const msgsRes = (await (await fetch(`${bobInfo.url}/api/chats/${chatId}/messages`)).json()) as {
      messages: any[];
    };
    assert(
      msgsRes.messages.length === 1 && msgsRes.messages[0].text === 'Halo Bob dari WebBridge sesi 1',
      'GET /api/chats/:chatId/messages memuat pesan lokal secara offline'
    );

    // 8. Sesi #2 (Multi-session reconnect tanpa restart daemon!)
    aliceEvents.length = 0;
    bobEvents.length = 0;

    const reconnectRes = await fetch(`${bobInfo.url}/api/session/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: aliceId.peerId, label: 'alice-web' }),
    });
    assert(reconnectRes.ok, 'Sesi #2 (Bob -> Alice) connect diterima tanpa restart daemon');

    await waitForWsEvent(aliceEvents, (e) => e.type === 'sessionStarted');
    await waitForWsEvent(bobEvents, (e) => e.type === 'sessionStarted');

    // Kirim pesan di Sesi #2 via WebSocket command
    bobWs.send(JSON.stringify({ type: 'sendMessage', text: 'Pesan sesi kedua lewat WS!' }));
    const aliceRecv2 = await waitForWsEvent(
      aliceEvents,
      (e) => e.type === 'message' && e.message?.text === 'Pesan sesi kedua lewat WS!'
    );
    assert(aliceRecv2.message.seq === 1, 'Sequence number ter-reset ke 1 di sesi kedua & pesan diterima Alice');

    console.log('\n[test-web-bridge] SEMUA PENGUJIAN WEB BRIDGE FASE 1: LULUS 100%');
  } finally {
    aliceWs?.terminate();
    bobWs?.terminate();
    await aliceBridge?.stop('test selesai').catch(() => undefined);
    await bobBridge?.stop('test selesai').catch(() => undefined);
    killChild(discoveryProc);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    process.exitCode = 0;
    const t = setTimeout(() => process.exit(0), 500);
    t.unref();
  })
  .catch((err) => {
    console.error('[test-web-bridge] GAGAL:', err);
    process.exit(1);
  });
