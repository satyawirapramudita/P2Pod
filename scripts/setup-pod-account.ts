// scripts/setup-pod-account.ts
// Provisioning akun Pod: login ke CSS -> generate client credentials -> simpan ke <home>/pod-config.json
// (logika inti dipakai bersama oleh wizard user-client: packages/user-client/src/modules/pod/provision.ts)

import * as path from 'path';
import { defaultHomeDir } from '../packages/user-client/src/identity/identity';
import { provisionPodAccount } from '../packages/user-client/src/modules/pod/provision';

interface Options {
  css: string;
  email: string;
  password: string;
  podName: string;
  home: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Partial<Options> = { home: defaultHomeDir() };

  for (let i = 2; i < argv.length; i++) {
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
      case '--css':
        opts.css = value();
        break;
      case '--email':
        opts.email = value();
        break;
      case '--password':
        opts.password = value();
        break;
      case '--pod':
        opts.podName = value();
        break;
      case '--home':
        opts.home = path.resolve(value());
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        throw new Error(buildUnknownArgMessage(raw));
    }
  }

  if (!opts.css || !opts.email || !opts.password || !opts.podName) {
    printUsage();
    process.exit(1);
  }
  return opts as Options;
}

function buildUnknownArgMessage(raw: string): string {
  if (!raw.startsWith('--')) {
    return (
      `Argumen tidak dikenal: ${raw}\n` +
      'Hint: jika memakai "npm run", sertakan separator "--" sebelum argumen, contoh:\n' +
      '  npm run setup:pod -- --css http://localhost:3000/ --email <email> --password <pass> --pod <name>\n' +
      'Alternatif tanpa npm arg-forwarding: npx ts-node scripts/setup-pod-account.ts --css <url> ...'
    );
  }
  return `Argumen tidak dikenal: ${raw} (gunakan --help untuk daftar argumen)`;
}

function printUsage(): void {
  console.log('Usage: npm run setup:pod -- --css <url> --email <email> --password <password> --pod <pod-name> [--home <dir>]');
  console.log('       Flag juga menerima bentuk --flag=value, mis. --css=http://localhost:3000/');
  console.log('       Alternatif tanpa separator: npx ts-node scripts/setup-pod-account.ts --css <url> ...');
  console.log('Contoh: npm run setup:pod -- --css http://localhost:3000/ --email alice@example.com --password p2pod-demo-123 --pod alice --home .p2pod/alice');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const cssUrl = opts.css.endsWith('/') ? opts.css : `${opts.css}/`;

  console.log(`[setup] CSS       : ${cssUrl}`);
  console.log(`[setup] akun      : ${opts.email}`);
  console.log(`[setup] pod       : ${opts.podName}`);

  const result = await provisionPodAccount({
    cssUrl,
    email: opts.email,
    password: opts.password,
    podName: opts.podName,
    homeDir: opts.home,
  });

  console.log(`[setup] WebID             : ${result.webId}`);
  console.log(`[setup] clientId          : ${result.clientId}`);
  console.log(`[setup] kredensial        : ${path.join(opts.home, 'pod-config.json')}`);
  console.log('[setup] Selesai.');
}

main()
  .catch((err: Error) => {
    console.error(`[setup] Error: ${err.message}`);
    // jangan process.exit() langsung — memicu assertion libuv pada Windows bila fetch masih menutup
    process.exitCode = 1;
  })
  .finally(() => {
    // fallback bila masih ada handle yang menahan event loop
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  });
