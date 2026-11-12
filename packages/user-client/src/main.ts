// packages/user-client/src/main.ts

import * as path from 'path';
import { PeerApp } from './core/peerApp';
import { Identity, defaultHomeDir, ensureDir, fingerprintOf } from './identity/identity';
import { DiscoveryClient, detectLocalIp, isValidIpv4 } from './discovery/discoveryClient';
import { loadConfig, UserConfig } from './config';
import { runWizard } from './wizard';
import { resolveTarget } from './targetResolver';

interface CliOptions {
  command: 'init' | 'listen' | 'connect' | 'list' | 'none';
  connectTarget?: string;
  peerIp?: string;
  peerPort?: number;
  port?: number;
  podUrl?: string;
  podDisabled: boolean;
  discoveryUrl?: string;
  homeDir: string;
  displayName?: string;
  reconfigure: boolean;
}

const COMMANDS = new Set(['init', 'listen', 'connect', 'list']);

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: 'none',
    podDisabled: false,
    reconfigure: false,
    homeDir: defaultHomeDir(),
  };

  // Perintah positional harus menjadi argumen pertama (argv[2]).
  let i = 2;
  if (argv[2] && COMMANDS.has(argv[2])) {
    opts.command = argv[2] as CliOptions['command'];
    i = 3;
    if (opts.command === 'connect' && argv[3] && !argv[3].startsWith('--')) {
      opts.connectTarget = argv[3];
      i = 4;
    }
  }

  for (; i < argv.length; i++) {
    const raw = argv[i];
    const eqIndex = raw.indexOf('=');
    const arg = eqIndex >= 0 ? raw.slice(0, eqIndex) : raw;
    const inlineValue = eqIndex >= 0 ? raw.slice(eqIndex + 1) : undefined;

    const value = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`Nilai untuk ${arg} tidak boleh kosong`);
      return v;
    };

    switch (arg) {
      case '--listen':
        if (inlineValue !== undefined) throw new Error('--listen tidak menerima nilai');
        opts.command = 'listen';
        break;
      case '--connect':
        opts.command = 'connect';
        opts.connectTarget = value();
        break;
      case '--port':
        opts.port = parseInt(value(), 10);
        break;
      case '--peer-ip':
        opts.peerIp = value();
        break;
      case '--peer-port':
        opts.peerPort = parseInt(value(), 10);
        break;
      case '--pod':
        opts.podUrl = value();
        break;
      case '--no-pod':
        opts.podDisabled = true;
        break;
      case '--discovery':
        opts.discoveryUrl = value();
        break;
      case '--home':
        opts.homeDir = path.resolve(value());
        break;
      case '--name':
        opts.displayName = value();
        break;
      case '--reconfigure':
        opts.reconfigure = true;
        break;
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        if (!raw.startsWith('--')) {
          throw new Error(
            `Argumen tidak dikenal: ${raw}\n` +
              'Hint: perintah tersedia → init | listen | connect <nama|PeerID> | list'
          );
        }
        throw new Error(`Argumen tidak dikenal: ${raw} (gunakan --help untuk daftar argumen)`);
    }
  }

  return opts;
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  Setup user     : npm run role:user [-- --name <nama> --discovery <url> [--pod <url> | --no-pod]]');
  console.log('  Tunggu koneksi : npm start -- --listen [--port 5000] [--pod <pod-url>] [--discovery <url>] [--home <dir>] [--name <nama>]');
  console.log('  Hubungi user   : npm run user:connect -- <nama|PeerID> [--peer-ip <ip> --peer-port <n>]');
  console.log('  Daftar user    : npm run user:list [--discovery <url>]');
  console.log('  Di sesi chat   : /connect <nama|PeerID> · /connect <IP> <PeerID> · /list · /help · /quit');
}

function validatePort(port: number, label: string): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} tidak valid (1-65535): ${port}`);
  }
}

function resolvePodUrl(opts: CliOptions, config: UserConfig | null, displayName: string): string | undefined {
  if (opts.podDisabled) return undefined;
  if (opts.podUrl) return opts.podUrl;
  if (config?.pod?.enabled) {
    return config.pod.podUrl ?? `http://localhost:${config.pod.cssPort ?? 3000}/${displayName}/`;
  }
  return undefined;
}

async function runList(discoveryUrl: string): Promise<void> {
  const discovery = new DiscoveryClient(discoveryUrl);
  let peers;
  try {
    peers = await discovery.listPeers();
  } catch (err: any) {
    throw new Error(`tidak bisa menjangkau Discovery Platform (${discoveryUrl}): ${err.message}`);
  }

  if (peers.length === 0) {
    console.log(`Tidak ada user online di ${discoveryUrl}.`);
    return;
  }

  console.log(`User online di ${discoveryUrl} (${peers.length}):`);
  for (const peer of peers) {
    const name = (peer.displayName ?? '(tanpa nama)').padEnd(16);
    console.log(`  ${name} ${fingerprintOf(peer.peerId)}  ${peer.peerId}`);
  }
  console.log('');
  console.log('Hubungi salah satu dengan: npm run user:connect -- <nama|PeerID>');
}

interface StartParams {
  identity: Identity;
  homeDir: string;
  discoveryUrl: string;
  listenPort: number;
  podUrl?: string;
  targetPeerId?: string;
  targetIp?: string;
  targetPort?: number;
}

async function startApp(params: StartParams): Promise<void> {
  const localIp = await detectLocalIp(params.discoveryUrl);

  console.log('');
  console.log(`[P2Pod] nama        : ${params.identity.displayName}`);
  console.log(`[P2Pod] Peer ID     : ${params.identity.peerId}`);
  console.log(`[P2Pod] fingerprint : ${params.identity.fingerprint}`);
  console.log(`[P2Pod] IP LAN      : ${localIp || '(tidak terdeteksi)'}`);
  console.log(`[P2Pod] home        : ${params.homeDir}`);
  console.log(`[P2Pod] discovery   : ${params.discoveryUrl}`);
  console.log(`[P2Pod] port TCP    : ${params.listenPort}`);
  console.log(`[P2Pod] pod         : ${params.podUrl ?? '(nonaktif — history tidak disimpan)'}`);
  console.log(
    `[P2Pod] mode        : ${
      params.targetPeerId
        ? `menghubungi ${fingerprintOf(params.targetPeerId)}${
            params.targetIp ? ` (direct ${params.targetIp}:${params.targetPort ?? 5000})` : ''
          }`
        : 'listen (tunggu koneksi masuk)'
    }`
  );
  console.log('');
  console.log(
    `[P2Pod] Bagikan ke user lain → nama: ${params.identity.displayName} · IP: ${localIp || '(?)'} · Peer ID: ${params.identity.peerId}`
  );
  console.log('[P2Pod] Hubungi user lain → /connect <nama|PeerID>  atau  npm run user:connect -- <nama|PeerID>');
  console.log('');

  const app = new PeerApp({
    identity: params.identity,
    homeDir: params.homeDir,
    discoveryUrl: params.discoveryUrl,
    podUrl: params.podUrl,
    listenPort: params.listenPort,
    targetPeerId: params.targetPeerId,
    targetIp: params.targetIp,
    targetPort: params.targetPort,
  });

  await app.start();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  if (opts.command === 'list') {
    const discoveryUrl = opts.discoveryUrl ?? loadConfig(opts.homeDir)?.discoveryUrl ?? 'http://localhost:4000';
    await runList(discoveryUrl);
    return;
  }

  if (opts.command === 'init') {
    const { identity, config } = await runWizard({
      homeDir: opts.homeDir,
      displayName: opts.displayName,
      discoveryUrl: opts.discoveryUrl,
      listenPort: opts.port,
      podUrl: opts.podUrl,
      podDisabled: opts.podDisabled,
      reconfigure: opts.reconfigure,
    });
    await startApp({
      identity,
      homeDir: opts.homeDir,
      discoveryUrl: config.discoveryUrl,
      listenPort: config.listenPort,
      podUrl: config.pod.enabled ? config.pod.podUrl : undefined,
    });
    return;
  }

  if (opts.command === 'none') {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(opts.homeDir);
  ensureDir(opts.homeDir);
  const displayName = opts.displayName ?? config?.displayName;
  const identity = Identity.loadOrCreate(opts.homeDir, displayName);
  const discoveryUrl = opts.discoveryUrl ?? config?.discoveryUrl ?? 'http://localhost:4000';
  const listenPort = opts.port ?? config?.listenPort ?? 5000;
  validatePort(listenPort, 'Port TCP');
  const podUrl = resolvePodUrl(opts, config, identity.displayName);

  if (opts.command === 'connect') {
    if (!opts.connectTarget) {
      throw new Error('Perintah connect membutuhkan target: connect <nama|PeerID> (atau --connect <target>).');
    }
    if (opts.peerIp && !isValidIpv4(opts.peerIp)) {
      throw new Error(`--peer-ip tidak valid: ${opts.peerIp}`);
    }
    const resolved = await resolveTarget(opts.connectTarget, discoveryUrl);
    if (resolved.via === 'name') {
      console.log(`[P2Pod] target      : "${resolved.displayName}" (fingerprint ${fingerprintOf(resolved.peerId)})`);
    }
    await startApp({
      identity,
      homeDir: opts.homeDir,
      discoveryUrl,
      listenPort,
      podUrl,
      targetPeerId: resolved.peerId,
      targetIp: opts.peerIp,
      targetPort: opts.peerPort,
    });
    return;
  }

  // listen
  await startApp({ identity, homeDir: opts.homeDir, discoveryUrl, listenPort, podUrl });
}

main()
  .catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Fallback exit bila ada handle (undici/readline) yang menahan event loop.
    const t = setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
    t.unref();
  });
