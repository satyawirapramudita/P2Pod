// scripts/test-pod.ts
// Spike test: verifikasi auth + tulis/baca session JSON-LD ke Solid Pod (CSS lokal).

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { defaultHomeDir } from '../src/identity/identity';
import { SolidClient } from '../src/pod/solidClient';

interface Options {
  home: string;
  podUrl?: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Partial<Options> = { home: defaultHomeDir() };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (!v) throw new Error(`Nilai untuk ${arg} tidak boleh kosong`);
      return v;
    };

    switch (arg) {
      case '--home':
        opts.home = path.resolve(value());
        break;
      case '--pod':
        opts.podUrl = value();
        break;
      default:
        throw new Error(`Argumen tidak dikenal: ${arg}`);
    }
  }

  return opts as Options;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const configPath = path.join(opts.home, 'pod-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`pod-config.json tidak ada di ${opts.home} — jalankan dulu: npm run setup:pod`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { podUrl: string };
  const podUrl = opts.podUrl ?? config.podUrl;

  console.log(`[test-pod] pod : ${podUrl}`);

  const client = new SolidClient(opts.home, podUrl);
  await client.login();
  console.log('[test-pod] login ke Pod: OK');

  const chatId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const meta = {
    chatId,
    localDisplayName: 'tester',
    localPeerId: 'LOCAL-PEER-ID',
    remoteDisplayName: 'peer',
    remotePeerId: 'REMOTE-PEER-ID',
    startedAt: new Date(now - 60_000).toISOString(),
    endedAt: new Date(now).toISOString(),
  };
  const history = [
    { direction: 'sent' as const, displayName: 'tester', text: 'Halo dari spike test', timestamp: now - 30_000, seq: 1 },
    { direction: 'received' as const, displayName: 'peer', text: 'Diterima!', timestamp: now - 10_000, seq: 2 },
  ];

  const savedFile = await client.saveChatSession(chatId, meta, history);
  console.log(`[test-pod] save session : OK (${savedFile})`);

  const loaded = await client.loadChatSession(chatId);
  console.log(`[test-pod] load session : OK (${loaded.length} pesan)`);

  if (loaded.length !== history.length) {
    throw new Error(`Jumlah pesan tidak cocok: tersimpan ${history.length}, terbaca ${loaded.length}`);
  }
  for (let i = 0; i < history.length; i++) {
    if (loaded[i].text !== history[i].text || loaded[i].senderName !== history[i].displayName) {
      throw new Error(`Pesan ke-${i + 1} tidak cocok: "${loaded[i].text}" vs "${history[i].text}"`);
    }
  }

  console.log('[test-pod] Round-trip JSON-LD di Solid Pod: LULUS');

  await client.logout();
}

main()
  .catch((err: Error) => {
    console.error(`[test-pod] GAGAL: ${err.message}`);
    // jangan process.exit() langsung — memicu assertion libuv pada Windows bila fetch masih menutup
    process.exitCode = 1;
  })
  .finally(() => {
    // fallback bila masih ada handle yang menahan event loop
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  });
