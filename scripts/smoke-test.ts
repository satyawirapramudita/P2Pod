// scripts/smoke-test.ts
// Smoke test end-to-end tanpa Pod:
//   Fase 1: flow dasar (listen dulu, lalu connect)
//   Fase 2: urutan dibalik — connector start lebih dulu, retry sampai listener online
//   Fase 3: kedua sisi saling --connect (tie-break: hanya satu sesi terbentuk)

import { ChildProcessWithoutNullStreams, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DISCOVERY_PORT = 4100;
const ALICE_PORT = 5600;
const BOB_PORT = 5601;
const ROOT = process.cwd();

interface Proc {
  name: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
}

const running: Proc[] = [];

function start(name: string, command: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Proc {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    shell: true,
  }) as ChildProcessWithoutNullStreams;

  const proc: Proc = { name, child, output: '' };
  running.push(proc);

  child.stdout.on('data', (chunk: Buffer) => {
    proc.output += chunk.toString();
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    proc.output += chunk.toString();
    process.stdout.write(`[${name}!] ${chunk}`);
  });

  return proc;
}

function killProc(proc: Proc): void {
  if (proc.child.exitCode !== null) return;
  if (process.platform === 'win32' && proc.child.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(proc.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // proses sudah berakhir
    }
  } else {
    proc.child.kill('SIGKILL');
  }
}

function waitFor(proc: Proc, pattern: RegExp, timeoutMs = 45_000): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const match = proc.output.match(pattern);
      if (match) {
        clearInterval(timer);
        resolve(match);
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timeout menunggu ${pattern} dari ${proc.name}`));
      }
    }, 200);
  });
}

function waitExit(proc: Proc, timeoutMs = 30_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (proc.child.exitCode !== null) {
      resolve(proc.child.exitCode);
      return;
    }
    const timer = setTimeout(() => reject(new Error(`Timeout menunggu ${proc.name} exit`)), timeoutMs);
    proc.child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT GAGAL: ${message}`);
  console.log(`  OK  ${message}`);
}

function readPeerId(home: string): string {
  const file = path.join(ROOT, home, 'identity.json');
  if (!fs.existsSync(file)) {
    throw new Error(`identity.json belum ada di ${home} — jalankan fase sebelumnya dulu`);
  }
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { peerId: string }).peerId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cliArgs(extra: string[]): string[] {
  return ['ts-node', 'src/main.ts', '--discovery', `http://localhost:${DISCOVERY_PORT}`, ...extra];
}

async function phase1(): Promise<string> {
  console.log('\n=== Fase 1: flow dasar (listen dulu, lalu connect) ===\n');

  const alice = start(
    'alice1',
    'npx',
    cliArgs(['--home', '.p2pod/test-alice', '--listen', '--port', String(ALICE_PORT), '--name', 'alice'])
  );
  const peerIdMatch = await waitFor(alice, /Peer ID\s*:\s*(\S+)/);
  await waitFor(alice, /Terdaftar di Discovery Platform/);

  const bob = start(
    'bob1',
    'npx',
    cliArgs(['--home', '.p2pod/test-bob', '--port', String(BOB_PORT), '--connect', peerIdMatch[1], '--name', 'bob'])
  );

  await waitFor(bob, /Sesi aman terbentuk dengan "alice"/);
  await waitFor(alice, /Sesi aman terbentuk dengan "bob"/);

  bob.child.stdin.write('Halo dari Bob\n');
  await waitFor(alice, /bob: Halo dari Bob/);
  await waitFor(bob, /bob: Halo dari Bob/);

  bob.child.stdin.write('Pesan kedua\n');
  await waitFor(alice, /bob: Pesan kedua/);

  bob.child.stdin.write('/quit\n');
  bob.child.stdin.end();

  const bobCode = await waitExit(bob);
  const aliceCode = await waitExit(alice);

  assert(bobCode === 0, `bob exit code = 0 (dapat ${bobCode})`);
  assert(aliceCode === 0, `alice exit code = 0 (dapat ${aliceCode})`);
  assert(!alice.output.includes('TIDAK VALID'), 'tidak ada kegagalan verifikasi identitas');
  assert(!alice.output.includes('Error:'), 'alice tanpa error');

  const aliceChatId = alice.output.match(/chat_id: ([0-9a-f]{64})/)?.[1];
  const bobChatId = bob.output.match(/chat_id: ([0-9a-f]{64})/)?.[1];
  assert(Boolean(aliceChatId) && aliceChatId === bobChatId, 'chat_id alice === chat_id bob (deterministik)');

  return peerIdMatch[1];
}

async function phase2(alicePeerId: string): Promise<void> {
  console.log('\n=== Fase 2: connector start lebih dulu (retry, urutan start bebas) ===\n');

  const bob = start(
    'bob2',
    'npx',
    cliArgs(['--home', '.p2pod/test-bob', '--port', String(BOB_PORT), '--connect', alicePeerId, '--name', 'bob'])
  );
  await waitFor(bob, /Menunggu peer online/);
  await sleep(4000); // biarkan beberapa percobaan retry berjalan

  const alice = start(
    'alice2',
    'npx',
    cliArgs(['--home', '.p2pod/test-alice', '--listen', '--port', String(ALICE_PORT), '--name', 'alice'])
  );

  await waitFor(bob, /Sesi aman terbentuk dengan "alice"/);
  await waitFor(alice, /Sesi aman terbentuk dengan "bob"/);

  bob.child.stdin.write('halo dari yang connect duluan\n');
  await waitFor(alice, /halo dari yang connect duluan/);

  bob.child.stdin.write('/quit\n');
  bob.child.stdin.end();

  const bobCode = await waitExit(bob);
  const aliceCode = await waitExit(alice);
  assert(bobCode === 0 && aliceCode === 0, `fase 2 exit code 0 (bob=${bobCode}, alice=${aliceCode})`);
}

async function phase3(alicePeerId: string, bobPeerId: string): Promise<void> {
  console.log('\n=== Fase 3: kedua sisi saling --connect (tie-break) ===\n');

  const alice = start(
    'alice3',
    'npx',
    cliArgs(['--home', '.p2pod/test-alice', '--port', String(ALICE_PORT), '--connect', bobPeerId, '--name', 'alice'])
  );
  const bob = start(
    'bob3',
    'npx',
    cliArgs(['--home', '.p2pod/test-bob', '--port', String(BOB_PORT), '--connect', alicePeerId, '--name', 'bob'])
  );

  await waitFor(alice, /Sesi aman terbentuk dengan "bob"/);
  await waitFor(bob, /Sesi aman terbentuk dengan "alice"/);
  await sleep(1500); // kesempatan koneksi duplikat muncul bila tie-break gagal

  const aliceSessions = (alice.output.match(/Sesi aman terbentuk/g) ?? []).length;
  const bobSessions = (bob.output.match(/Sesi aman terbentuk/g) ?? []).length;
  assert(aliceSessions === 1, `alice hanya 1 sesi (dapat ${aliceSessions})`);
  assert(bobSessions === 1, `bob hanya 1 sesi (dapat ${bobSessions})`);

  bob.child.stdin.write('pesan mutual\n');
  await waitFor(alice, /pesan mutual/);

  bob.child.stdin.write('/quit\n');
  bob.child.stdin.end();

  const bobCode = await waitExit(bob);
  const aliceCode = await waitExit(alice);
  assert(bobCode === 0 && aliceCode === 0, `fase 3 exit code 0 (bob=${bobCode}, alice=${aliceCode})`);
}

async function main(): Promise<void> {
  console.log('--- Smoke test P2Pod (tanpa Pod) ---');
  const t0 = Date.now();

  const discovery = start('discovery', 'npm', ['--prefix', 'server/discovery-server', 'run', 'dev'], {
    env: { PORT: String(DISCOVERY_PORT) },
  });
  await waitFor(discovery, new RegExp(`listening on 0\\.0\\.0\\.0:${DISCOVERY_PORT}`));

  const alicePeerId = await phase1();
  const bobPeerId = readPeerId('.p2pod/test-bob');

  await phase2(alicePeerId);
  await phase3(alicePeerId, bobPeerId);

  console.log('\n--- Hasil akhir ---');
  const health = (await (await fetch(`http://localhost:${DISCOVERY_PORT}/health`)).json()) as { peers: number };
  assert(health.peers === 0, `discovery bersih setelah semua sesi (peers=${health.peers})`);

  console.log(`\nSMOKE TEST LULUS dalam ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .then(() => {
    for (const proc of running) killProc(proc);
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 3000).unref();
  })
  .catch((err) => {
    console.error(`\nSMOKE TEST GAGAL: ${err.message}`);
    for (const proc of running) killProc(proc);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 3000).unref();
  });
