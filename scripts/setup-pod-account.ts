// scripts/setup-pod-account.ts
// Provisioning akun Pod: login ke CSS -> generate client credentials -> simpan ke <home>/pod-config.json

import * as fs from 'fs';
import * as path from 'path';
import { defaultHomeDir, ensureDir } from '../src/identity/identity';

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
      if (!v) throw new Error(`Nilai untuk ${arg} tidak boleh kosong`);
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

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`GET ${url} gagal (HTTP ${response.status})`);
  }
  return response.json();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const cssUrl = opts.css.endsWith('/') ? opts.css : `${opts.css}/`;

  console.log(`[setup] CSS       : ${cssUrl}`);
  console.log(`[setup] akun      : ${opts.email}`);
  console.log(`[setup] pod       : ${opts.podName}`);

  const index = await fetchJson(`${cssUrl}.account/`);
  const loginUrl: string | undefined = index?.controls?.password?.login;
  if (!loginUrl) {
    throw new Error('CSS tidak menyediakan login email/password di /.account/ (fitur account management mungkin dinonaktifkan)');
  }

  const loginResponse = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: opts.email, password: opts.password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!loginResponse.ok) {
    throw new Error(`Login ke CSS gagal (HTTP ${loginResponse.status}) — cek email/password`);
  }
  const { authorization } = (await loginResponse.json()) as { authorization?: string };
  if (!authorization) {
    throw new Error('CSS tidak mengembalikan authorization token');
  }

  const account = await fetchJson(`${cssUrl}.account/`, {
    authorization: `CSS-Account-Token ${authorization}`,
  });
  const createTokenUrl: string | undefined = account?.controls?.account?.clientCredentials;
  if (!createTokenUrl) {
    throw new Error('Endpoint client credentials tidak tersedia pada kontrol akun');
  }

  const podUrl = `${cssUrl}${opts.podName}/`;
  const webId = `${podUrl}profile/card#me`;

  const createResponse = await fetch(createTokenUrl, {
    method: 'POST',
    headers: {
      authorization: `CSS-Account-Token ${authorization}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: `p2pod-${opts.podName}`, webId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!createResponse.ok) {
    const body = await createResponse.text().catch(() => '');
    throw new Error(`Gagal membuat client credentials (HTTP ${createResponse.status}) ${body}`);
  }
  const { id, secret } = (await createResponse.json()) as { id?: string; secret?: string };
  if (!id || !secret) {
    throw new Error('CSS tidak mengembalikan id/secret client credentials');
  }

  const config = {
    oidcIssuer: cssUrl,
    podUrl,
    webId,
    clientId: id,
    clientSecret: secret,
    createdAt: new Date().toISOString(),
  };

  ensureDir(opts.home);
  const configPath = path.join(opts.home, 'pod-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  console.log(`[setup] WebID             : ${webId}`);
  console.log(`[setup] clientId          : ${id}`);
  console.log(`[setup] kredensial        : ${configPath}`);
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
