// scripts/e2e-pod-test.ts
// E2E test penuh: chat 2 peer -> simpan history ke Solid Pod -> reconnect -> load history dari Pod.

import { ChildProcessWithoutNullStreams, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();
const DISCOVERY_PORT = 4200;
const ALICE_TCP_PORT = 5700;
const BOB_TCP_PORT = 5701;
const ALICE_HOME = '.p2pod/e2e-alice';
const BOB_HOME = '.p2pod/e2e-bob';
const ALICE_CSS = 'http://localhost:3000/';
const BOB_CSS = 'http://localhost:3001/';
const ALICE_POD = `${ALICE_CSS}alice/`;
const BOB_POD = `${BOB_CSS}bob/`;

interface Proc {
  name: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
}

const running: Proc[] = [];
const startedCss: Proc[] = [];

function start(name: string, command: string, args: string[], echo = true, env?: NodeJS.ProcessEnv): Proc {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    shell: true,
  }) as ChildProcessWithoutNullStreams;

  const proc: Proc = { name, child, output: '' };
  running.push(proc);

  child.stdout.on('data', (chunk: Buffer) => {
    proc.output += chunk.toString();
    if (echo) process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    proc.output += chunk.toString();
    if (echo) process.stdout.write(`[${name}!] ${chunk}`);
  });

  return proc;
}

function killProc(proc: Proc): void {
  if (proc.child.exitCode !== null) return;
  if (process.platform === 'win32' && proc.child.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(proc.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // sudah berakhir
    }
  } else {
    proc.child.kill('SIGKILL');
  }
}

function waitFor(proc: Proc, pattern: RegExp, timeoutMs = 60_000): Promise<RegExpMatchArray> {
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

function waitExit(proc: Proc, timeoutMs = 60_000): Promise<number | null> {
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

async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await response.text().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureCss(name: string, port: number, npmScript: string): Promise<void> {
  if (await isReachable(`http://localhost:${port}/.account/`)) {
    console.log(`[css-${name}] sudah berjalan di port ${port}`);
    return;
  }

  console.log(`[css-${name}] starting di port ${port}...`);
  const proc = start(`css-${name}`, 'npm', ['run', npmScript], false);
  startedCss.push(proc);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    if (await isReachable(`http://localhost:${port}/.account/`)) {
      console.log(`[css-${name}] siap setelah ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`CSS ${name} tidak siap dalam 120s`);
}

async function provision(name: string, cssUrl: string, email: string, home: string): Promise<void> {
  console.log(`[provision] ${name}...`);
  const proc = start(`provision-${name}`, 'npx', [
    'ts-node', 'scripts/setup-pod-account.ts',
    '--css', cssUrl,
    '--email', email,
    '--password', 'p2pod-demo-123',
    '--pod', name,
    '--home', home,
  ]);
  const code = await waitExit(proc);
  if (code !== 0) throw new Error(`Provisioning ${name} gagal (exit ${code})`);
}

async function runSession(round: number): Promise<void> {
  console.log(`\n=== Sesi #${round} ===`);

  const alice = start(`alice${round}`, 'npx', [
    'ts-node', 'src/main.ts',
    '--home', ALICE_HOME,
    '--listen', '--port', String(ALICE_TCP_PORT),
    '--pod', ALICE_POD,
    '--discovery', `http://localhost:${DISCOVERY_PORT}`,
    '--name', 'alice',
  ]);
  const peerIdMatch = await waitFor(alice, /Peer ID\s*:\s*(\S+)/);
  await waitFor(alice, /Terdaftar di Discovery Platform/);

  const bob = start(`bob${round}`, 'npx', [
    'ts-node', 'src/main.ts',
    '--home', BOB_HOME,
    '--port', String(BOB_TCP_PORT),
    '--connect', peerIdMatch[1],
    '--pod', BOB_POD,
    '--discovery', `http://localhost:${DISCOVERY_PORT}`,
    '--name', 'bob',
  ]);

  await waitFor(alice, /Sesi aman terbentuk dengan "bob"/);
  await waitFor(bob, /Sesi aman terbentuk dengan "alice"/);

  if (round === 2) {
    await waitFor(alice, /History sebelumnya dari Solid Pod \(2 pesan\)/);
    await waitFor(bob, /History sebelumnya dari Solid Pod \(2 pesan\)/);
    assert(alice.output.includes('bob: pesan pod satu'), 'alice memuat "pesan pod satu" dari Pod-nya');
    assert(bob.output.includes('bob: pesan pod satu'), 'bob memuat "pesan pod satu" dari Pod-nya');
    assert(alice.output.includes('bob: pesan pod dua'), 'alice memuat "pesan pod dua" dari Pod-nya');
  }

  const outgoing = round === 1 ? ['pesan pod satu', 'pesan pod dua'] : ['pesan pod tiga'];
  for (const text of outgoing) {
    bob.child.stdin.write(`${text}\n`);
    await waitFor(alice, new RegExp(`bob: ${text}`));
    await waitFor(bob, new RegExp(`bob: ${text}`));
  }

  bob.child.stdin.write('/quit\n');
  bob.child.stdin.end();

  const bobCode = await waitExit(bob);
  const aliceCode = await waitExit(alice);

  assert(bobCode === 0, `bob #${round} exit code = 0 (dapat ${bobCode})`);
  assert(aliceCode === 0, `alice #${round} exit code = 0 (dapat ${aliceCode})`);
  assert(bob.output.includes('History tersimpan di Pod'), `bob #${round} menyimpan history ke Pod`);
  assert(alice.output.includes('History tersimpan di Pod'), `alice #${round} menyimpan history ke Pod`);
}

async function main(): Promise<void> {
  console.log('--- E2E test P2Pod + Solid Pod ---\n');

  const t0 = Date.now();

  // Home terisolasi + selalu fresh: chat_id deterministik, jadi home lama membuat
  // history menumpuk dan jumlah pesan pada assert tidak lagi tepat.
  for (const dir of [ALICE_HOME, BOB_HOME]) {
    fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
  }

  await ensureCss('alice', 3000, 'css:alice');
  await ensureCss('bob', 3001, 'css:bob');
  await provision('alice', ALICE_CSS, 'alice@example.com', ALICE_HOME);
  await provision('bob', BOB_CSS, 'bob@example.com', BOB_HOME);

  const discovery = start('discovery', 'npm', ['--prefix', 'server/discovery-server', 'run', 'dev'], false, {
    PORT: String(DISCOVERY_PORT),
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    if (await isReachable(`http://localhost:${DISCOVERY_PORT}/health`)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await waitFor(discovery, new RegExp(`listening on 0\\.0\\.0\\.0:${DISCOVERY_PORT}`));
  console.log('');

  await runSession(1);
  await runSession(2);

  console.log('\n--- Hasil ---');
  const health = (await (await fetch(`http://localhost:${DISCOVERY_PORT}/health`)).json()) as { peers: number };
  assert(health.peers === 0, `discovery bersih setelah semua sesi (peers=${health.peers})`);

  console.log(`\nE2E TEST LULUS dalam ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .then(() => {
    for (const proc of running) killProc(proc);
    for (const css of startedCss) killProc(css);
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 3000).unref();
  })
  .catch((err) => {
    console.error(`\nE2E TEST GAGAL: ${err.message}`);
    for (const proc of running) killProc(proc);
    for (const css of startedCss) killProc(css);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 3000).unref();
  });
