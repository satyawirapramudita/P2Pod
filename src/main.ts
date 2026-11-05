// src/main.ts

import * as path from 'path';
import { PeerApp } from './core/peerApp';
import { Identity, defaultHomeDir, ensureDir, fingerprintOf } from './identity/identity';

interface CliOptions {
  mode: 'listen' | 'connect' | 'none';
  port: number;
  targetPeerId?: string;
  podUrl?: string;
  discoveryUrl: string;
  homeDir: string;
  displayName?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    mode: 'none',
    port: 5000,
    discoveryUrl: 'http://localhost:4000',
    homeDir: defaultHomeDir(),
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (!v) throw new Error(`Nilai untuk ${arg} tidak boleh kosong`);
      return v;
    };

    switch (arg) {
      case '--listen':
        opts.mode = 'listen';
        break;
      case '--connect':
        opts.mode = 'connect';
        opts.targetPeerId = value();
        break;
      case '--port':
        opts.port = parseInt(value(), 10);
        break;
      case '--pod':
        opts.podUrl = value();
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
      default:
        throw new Error(`Argumen tidak dikenal: ${arg}`);
    }
  }

  return opts;
}

function printUsage(): void {
  console.log('Usage:');
  console.log(
    '  Tunggu koneksi : npm start -- --listen [--port 5000] [--pod <pod-url>] [--discovery http://localhost:4000] [--home <dir>] [--name <nama>]'
  );
  console.log(
    '  Hubungi peer   : npm start -- --connect <PeerID> [--port 5000] [--pod <pod-url>] [--discovery http://localhost:4000] [--home <dir>] [--name <nama>]'
  );
  console.log('  Kedua mode sama-sama online & terdaftar di Discovery Platform — urutan start bebas.');
  console.log('  Di satu mesin, berikan --port berbeda untuk tiap peer (mis. 5000 dan 5001).');
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    printUsage();
    process.exit(1);
  }

  if (opts.mode === 'none') {
    printUsage();
    process.exit(1);
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    console.error('Error: port tidak valid (1-65535)');
    process.exit(1);
  }
  if (opts.mode === 'connect' && !opts.targetPeerId) {
    console.error('Error: --connect membutuhkan Peer ID target');
    process.exit(1);
  }

  try {
    ensureDir(opts.homeDir);
    const identity = Identity.loadOrCreate(opts.homeDir, opts.displayName);

    console.log(`[P2Pod] home        : ${opts.homeDir}`);
    console.log(`[P2Pod] nama        : ${identity.displayName}`);
    console.log(`[P2Pod] Peer ID     : ${identity.peerId}`);
    console.log(`[P2Pod] fingerprint : ${identity.fingerprint}`);
    console.log(`[P2Pod] discovery   : ${opts.discoveryUrl}`);
    console.log(`[P2Pod] pod         : ${opts.podUrl ?? '(tidak diisi — history tidak disimpan)'}`);
    console.log(`[P2Pod] port TCP    : ${opts.port}`);
    console.log(
      `[P2Pod] mode        : ${
        opts.mode === 'connect' ? `connect → target fingerprint ${fingerprintOf(opts.targetPeerId!)}` : 'listen (tunggu koneksi masuk)'
      }`
    );
    console.log('');

    const app = new PeerApp({
      identity,
      homeDir: opts.homeDir,
      discoveryUrl: opts.discoveryUrl,
      podUrl: opts.podUrl,
      listenPort: opts.port,
      targetPeerId: opts.mode === 'connect' ? opts.targetPeerId : undefined,
    });

    await app.start();
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
