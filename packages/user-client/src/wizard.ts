// packages/user-client/src/wizard.ts
// Wizard `init`: mengumpulkan info yang dibutuhkan user (nama, discovery, port, pod)
// lalu menyimpannya ke <home>/config.json. Nilai dari flag tidak ditanyakan lagi.

import { createPrompter } from './prompt';
import { Identity, ensureDir } from './identity/identity';
import { loadConfig, saveConfig, PodSettings, UserConfig } from './config';
import { generatePassword, localCssPortOf, podNameFromDisplayName, setupLocalPod } from './modules/pod/provision';

export interface WizardOptions {
  homeDir: string;
  displayName?: string;
  discoveryUrl?: string;
  listenPort?: number;
  podUrl?: string;
  podDisabled?: boolean;
  reconfigure?: boolean;
}

export interface WizardResult {
  identity: Identity;
  config: UserConfig;
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

async function checkDiscovery(url: string): Promise<string | null> {
  try {
    const healthUrl = new URL('health', url.endsWith('/') ? url : `${url}/`).toString();
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return `menjawab HTTP ${response.status}`;
    return null;
  } catch (err: any) {
    return err.message;
  }
}

export async function runWizard(opts: WizardOptions): Promise<WizardResult> {
  ensureDir(opts.homeDir);
  const existing = opts.reconfigure ? null : loadConfig(opts.homeDir);
  const interactive = Boolean(process.stdin.isTTY);
  const prompter = createPrompter();

  try {
    console.log('— Setup user P2Pod —');
    if (existing) {
      console.log(`(konfigurasi lama: nama="${existing.displayName}", discovery=${existing.discoveryUrl})`);
    }

    // 1/4 — Nama (wajib)
    let displayName = (opts.displayName ?? existing?.displayName ?? '').trim();
    while (displayName.length === 0) {
      if (!interactive) {
        throw new Error('Nama belum diisi — tambahkan --name <nama> (atau jalankan di terminal interaktif).');
      }
      displayName = (await prompter.ask('1/4 Nama kamu (wajib, tampil di daftar user): ')).trim();
      if (displayName.length === 0) console.log('  Nama tidak boleh kosong.');
    }

    const identity = Identity.loadOrCreate(opts.homeDir, displayName);

    // 2/4 — URL Discovery Platform (wajib + validasi /health)
    let discoveryUrl = (opts.discoveryUrl ?? existing?.discoveryUrl ?? '').trim();
    for (;;) {
      if (discoveryUrl.length === 0) {
        if (!interactive) {
          throw new Error('URL Discovery Platform belum diisi — tambahkan --discovery <url>.');
        }
        discoveryUrl = normalizeUrl(await prompter.ask('2/4 URL Discovery Platform (mis. http://192.168.1.10:4000): '));
      }
      const problem = await checkDiscovery(discoveryUrl);
      if (!problem) break;

      console.log(`  Discovery Platform tidak OK: ${problem}`);
      if (opts.discoveryUrl || !interactive) {
        throw new Error(`URL Discovery Platform (${discoveryUrl}) tidak bisa dipakai: ${problem}`);
      }
      const retry = (await prompter.ask('  URL baru (ketik "batal" untuk membatalkan): ')).trim();
      if (retry.toLowerCase() === 'batal') throw new Error('Setup dibatalkan.');
      discoveryUrl = normalizeUrl(retry);
    }
    console.log(`  Discovery Platform OK: ${discoveryUrl}`);

    // 3/4 — Port TCP
    let listenPort = opts.listenPort ?? existing?.listenPort;
    if (!listenPort) {
      if (!interactive) {
        throw new Error('Port TCP belum diisi — tambahkan --port <n> (default 5000).');
      }
      const raw = await prompter.askDefault('3/4 Port TCP untuk menerima koneksi', '5000');
      listenPort = Number(raw);
    }
    if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535) {
      throw new Error(`Port TCP tidak valid (1-65535): ${listenPort}`);
    }

    // 4/4 — Solid Pod (opsional; pod lokal otomatis disiapkan)
    let pod: PodSettings;
    if (opts.podDisabled) {
      pod = { enabled: false };
    } else if (opts.podUrl) {
      pod = { enabled: true, podUrl: opts.podUrl };
    } else if (existing?.pod && !opts.reconfigure) {
      pod = existing.pod;
    } else if (!interactive) {
      pod = { enabled: false };
      console.log('  (non-interaktif: Pod dinonaktifkan — gunakan --pod <url> untuk mengaktifkan)');
    } else {
      const wantsPod = await prompter.askYesNo('4/4 Aktifkan riwayat chat di Solid Pod?');
      if (wantsPod) {
        const defaultPod = `http://localhost:3000/${podNameFromDisplayName(displayName)}/`;
        const podUrlInput = normalizeUrl(await prompter.askDefault('  URL Pod', defaultPod));
        pod = { enabled: true, podUrl: podUrlInput };
      } else {
        pod = { enabled: false };
      }
    }

    // Pod lokal (localhost): siapkan CSS + provisioning akun otomatis.
    if (pod.enabled && !pod.podUrl) {
      pod = { enabled: false };
    }
    if (pod.enabled && pod.podUrl) {
      const cssPort = localCssPortOf(pod.podUrl);
      if (cssPort) {
        const email = pod.email ?? `${podNameFromDisplayName(displayName)}@example.com`;
        const password = pod.password ?? generatePassword();
        console.log(`  Menyiapkan Solid Pod lokal (CSS port ${cssPort})...`);
        try {
          const result = await setupLocalPod({
            homeDir: opts.homeDir,
            displayName,
            cssPort,
            email,
            password,
            podUrl: pod.podUrl,
          });
          pod = { enabled: true, podUrl: result.podUrl, cssPort, email, password };
          console.log(`  Pod siap: ${pod.podUrl}${result.provisioned ? ' (akun baru di-provision)' : ''}`);
        } catch (err: any) {
          console.log(`  ⚠ Setup Pod otomatis gagal: ${err.message}`);
          console.log('  Chat tetap bisa dijalankan tanpa Pod. Coba lagi dengan: npm run role:user -- --reconfigure');
          pod = { enabled: false };
        }
      } else {
        console.log('  (Pod non-lokal — pastikan pod-config.json sudah tersedia di home ini)');
      }
    }

    const now = new Date().toISOString();
    const config: UserConfig = {
      displayName: identity.displayName,
      discoveryUrl,
      listenPort,
      pod,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    saveConfig(opts.homeDir, config);

    console.log('');
    console.log('— Setup selesai —');
    console.log(`  Nama      : ${config.displayName}`);
    console.log(`  Peer ID   : ${identity.peerId}`);
    console.log(`  Discovery : ${config.discoveryUrl}`);
    console.log(`  Port TCP  : ${config.listenPort}`);
    console.log(`  Pod       : ${config.pod.enabled ? config.pod.podUrl : '(nonaktif)'}`);
    console.log('');

    return { identity, config };
  } finally {
    prompter.close();
  }
}
