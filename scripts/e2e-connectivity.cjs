'use strict';

/**
 * End-to-end connectivity harness for the discovery/LAN/public issues.
 *
 * It drives real PeerApp instances (the same class the web UI and CLI use)
 * against real discovery-platform processes, so it exercises the actual
 * registration -> lookup -> TCP handshake -> ECDH/AES-GCM chat path.
 *
 * Scenario 1: both peers share ONE discovery server  (expected: they see each other and chat)
 * Scenario 2: each peer hosts its OWN discovery server (expected: they cannot see each other)
 *
 * Usage:
 *   node scripts/e2e-connectivity.cjs
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DISCOVERY_ENTRY = path.join(ROOT, 'packages', 'discovery-platform', 'dist', 'index.js');
const USER_ENTRY = path.join(ROOT, 'packages', 'user-client', 'dist', 'core', 'peerApp.js');

const { PeerApp } = require(USER_ENTRY);
const { Identity } = require(path.join(ROOT, 'packages', 'user-client', 'dist', 'identity', 'identity.js'));

const VERBOSE = process.env.E2E_VERBOSE === '1';

function log(...args) {
  console.log(...args);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const url = new URL('health', base.endsWith('/') ? base : `${base}/`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await delay(200);
  }
  throw new Error(`discovery did not become healthy: ${base}`);
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(child.pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

async function startDiscovery(port) {
  if (!fs.existsSync(DISCOVERY_ENTRY)) {
    throw new Error(`missing build output: ${DISCOVERY_ENTRY} (run npm run build)`);
  }
  const child = spawn(process.execPath, [DISCOVERY_ENTRY], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (VERBOSE) child.stdout.on('data', (d) => process.stdout.write(`[disc:${port}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[disc:${port} ERR] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base);
  return {
    base,
    child,
    stop: () => killTree(child),
  };
}

function makePeer({ name, home, port, discoveryUrl, publicHost }) {
  fs.mkdirSync(home, { recursive: true });
  const identity = Identity.loadOrCreate(home, name);
  const app = new PeerApp({
    identity,
    homeDir: home,
    discoveryUrl,
    listenPort: port,
    publicHost,
    mode: 'daemon',
  });
  return { identity, app, home };
}

async function lookup(base, peerId) {
  const res = await fetch(`${base}/lookup/${encodeURIComponent(peerId)}`);
  if (!res.ok) return { status: res.status };
  return { status: res.status, body: await res.json() };
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(150);
  }
  log(`  (timeout waiting for: ${label})`);
  return false;
}

// ---------------------------------------------------------------------------
// Scenario 1: single shared discovery (the intended setup)
// ---------------------------------------------------------------------------
async function scenarioShared(tmpRoot) {
  log('\n=== SCENARIO 1: one shared discovery server (expected: WORKS) ===');
  const disc = await startDiscovery(4001);
  const a = makePeer({ name: 'alice', home: path.join(tmpRoot, 'alice'), port: 5101, discoveryUrl: disc.base });
  const b = makePeer({ name: 'bob', home: path.join(tmpRoot, 'bob'), port: 5102, discoveryUrl: disc.base });

  const received = { alice: [], bob: [] };
  a.app.on('message', (e) => {
    if (e.direction === 'received') received.alice.push(e);
  });
  b.app.on('message', (e) => {
    if (e.direction === 'received') received.bob.push(e);
  });
  let aSession = false;
  let bSession = false;
  a.app.on('sessionStarted', () => (aSession = true));
  b.app.on('sessionStarted', () => (bSession = true));

  await a.app.startNode();
  await b.app.startNode();
  await delay(1200);

  const la = await lookup(disc.base, a.identity.peerId);
  const lb = await lookup(disc.base, b.identity.peerId);
  log(`  alice registered endpoint: ${la.body ? `${la.body.ip}:${la.body.port}` : `HTTP ${la.status}`}`);
  log(`  bob   registered endpoint: ${lb.body ? `${lb.body.ip}:${lb.body.port}` : `HTTP ${lb.status}`}`);

  const pa = await a.app.getOnlinePeers();
  const pb = await b.app.getOnlinePeers();
  log(`  alice sees: [${pa.map((p) => p.displayName).join(', ')}]`);
  log(`  bob   sees: [${pb.map((p) => p.displayName).join(', ')}]`);

  const probe = await a.app.probePublicEndpoint();
  log(`  alice inbound probe: reachable=${probe.reachable}${probe.error ? ` (${probe.error})` : ''}`);

  await a.app.connectTo({ peerId: b.identity.peerId, label: 'bob' });
  const bothSessions = await waitUntil(async () => aSession && bSession, 15000, 'both sessions established');
  log(`  session: alice=${aSession} bob=${bSession}`);

  if (aSession) a.app.sendChat('hello-from-alice');
  const gotAtBob = await waitUntil(async () => received.bob.length > 0, 8000, 'bob receives alice message');
  if (bSession) b.app.sendChat('hi-from-bob');
  const gotAtAlice = await waitUntil(async () => received.alice.length > 0, 8000, 'alice receives bob message');

  log(`  bob received:   ${JSON.stringify(received.bob.map((m) => m.text))}`);
  log(`  alice received: ${JSON.stringify(received.alice.map((m) => m.text))}`);

  const pass =
    pa.some((p) => p.displayName === 'bob') &&
    pb.some((p) => p.displayName === 'alice') &&
    bothSessions &&
    gotAtBob &&
    gotAtAlice;

  log(`  SCENARIO 1 RESULT: ${pass ? 'PASS' : 'FAIL'}`);

  await a.app.stopNode().catch(() => undefined);
  await b.app.stopNode().catch(() => undefined);
  disc.stop();
  return pass;
}

// ---------------------------------------------------------------------------
// Scenario 2: each peer hosts its own discovery (reproduce the reported bug)
// ---------------------------------------------------------------------------
async function scenarioTwoDiscoveries(tmpRoot) {
  log('\n=== SCENARIO 2: each peer hosts its OWN discovery (expected: peers INVISIBLE) ===');
  const d1 = await startDiscovery(4002);
  const d2 = await startDiscovery(4003);
  const a = makePeer({ name: 'alice', home: path.join(tmpRoot, 'alice2'), port: 5111, discoveryUrl: d1.base });
  const b = makePeer({ name: 'bob', home: path.join(tmpRoot, 'bob2'), port: 5112, discoveryUrl: d2.base });

  await a.app.startNode();
  await b.app.startNode();
  await delay(1200);

  const pa = await a.app.getOnlinePeers();
  const pb = await b.app.getOnlinePeers();
  log(`  alice (via discovery#1) sees: [${pa.map((p) => p.displayName).join(', ')}]`);
  log(`  bob   (via discovery#2) sees: [${pb.map((p) => p.displayName).join(', ')}]`);

  const cross = await lookup(d1.base, b.identity.peerId);
  log(`  discovery#1 lookup of bob -> HTTP ${cross.status}`);

  const bugReproduced = !pa.some((p) => p.displayName === 'bob') && !pb.some((p) => p.displayName === 'alice');
  log(`  SCENARIO 2 RESULT: ${bugReproduced ? 'BUG REPRODUCED (peers cannot see each other)' : 'UNEXPECTED (they saw each other)'}`);

  await a.app.stopNode().catch(() => undefined);
  await b.app.stopNode().catch(() => undefined);
  d1.stop();
  d2.stop();
  return bugReproduced;
}

// ---------------------------------------------------------------------------
// Scenario 3: container endpoint warning (simulated container env)
// ---------------------------------------------------------------------------
async function scenarioContainerWarning(tmpRoot) {
  log('\n=== SCENARIO 3: container endpoint warning (expected: WARNS) ===');
  const disc = await startDiscovery(4004);
  process.env.P2POD_IN_CONTAINER = '1';
  const a = makePeer({
    name: 'containerpeer',
    home: path.join(tmpRoot, 'container'),
    port: 5121,
    discoveryUrl: disc.base,
  });
  const systems = [];
  a.app.on('system', (e) => systems.push(e.text));

  await a.app.startNode();
  await delay(800);

  const warned = systems.some((t) => /container Docker/i.test(t));
  const observed = await lookup(disc.base, a.identity.peerId);
  log(`  registered endpoint: ${observed.body ? `${observed.body.ip}:${observed.body.port}` : `HTTP ${observed.status}`}`);
  log(`  warning emitted: ${warned}`);
  log(`  SCENARIO 3 RESULT: ${warned ? 'PASS (warning shown)' : 'FAIL (no warning)'}`);

  await a.app.stopNode().catch(() => undefined);
  delete process.env.P2POD_IN_CONTAINER;
  disc.stop();
  return warned;
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p2pod-e2e-'));
  log(`temp profiles: ${tmpRoot}`);
  const results = {};
  try {
    results.shared = await scenarioShared(tmpRoot);
  } catch (err) {
    log(`  SCENARIO 1 ERROR: ${err.stack || err.message}`);
    results.shared = false;
  }
  try {
    results.twoDiscoveries = await scenarioTwoDiscoveries(tmpRoot);
  } catch (err) {
    log(`  SCENARIO 2 ERROR: ${err.stack || err.message}`);
    results.twoDiscoveries = false;
  }
  try {
    results.containerWarning = await scenarioContainerWarning(tmpRoot);
  } catch (err) {
    log(`  SCENARIO 3 ERROR: ${err.stack || err.message}`);
    results.containerWarning = false;
  }

  log('\n=== SUMMARY ===');
  log(`  Scenario 1 (shared discovery works):        ${results.shared ? 'PASS' : 'FAIL'}`);
  log(`  Scenario 2 (two discoveries -> invisible):  ${results.twoDiscoveries ? 'BUG REPRODUCED' : 'not reproduced'}`);
  log(`  Scenario 3 (container endpoint warning):    ${results.containerWarning ? 'PASS' : 'FAIL'}`);

  // PeerApp keeps timers/handles alive; exit explicitly so the harness terminates.
  await delay(300);
  process.exit(results.shared && results.twoDiscoveries && results.containerWarning ? 0 : 1);
}

main();
