// packages/user-client/src/wizard.ts
// Wizard `init`: mengumpulkan info yang dibutuhkan user (nama, discovery, port, pod)
// lalu menyimpannya ke <home>/config.json. Nilai dari flag tidak ditanyakan lagi.

import { createPrompter } from './prompt';
import { Identity, ensureDir } from './identity/identity';
import { loadConfig, saveConfig, PodSettings, UserConfig } from './config';
import {
  generatePassword,
  localCssPortOf,
  pickAvailableCssPort,
  podNameFromDisplayName,
  setupLocalPod,
} from './modules/pod/provision';
import { SolidClient } from './modules/pod/solidClient';

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

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export async function checkDiscovery(url: string): Promise<string | null> {
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
      displayName = (await prompter.ask('1/2 Nama kamu (wajib, tampil di daftar user): ')).trim();
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
        discoveryUrl = normalizeUrl(await prompter.ask('2/2 URL Discovery Platform (mis. http://192.168.1.10:4000): '));
      }
      const problem = await checkDiscovery(discoveryUrl);
      if (!problem) break;

      console.log(`  Discovery Platform tidak OK: ${problem}`);
      console.log('  Petunjuk:');
      console.log('   - Pastikan host menjalankan `npm run role:discovery` dan sudah mengizinkan port di firewall-nya.');
      console.log('   - Gunakan IP LAN host (bukan localhost) bila discovery berada di device lain — lihat banner host.');
      console.log('   - Pastikan satu jaringan: `ping <IP_HOST>` dan SSID yang sama.');
      if (opts.discoveryUrl || !interactive) {
        throw new Error(
          `URL Discovery Platform (${discoveryUrl}) tidak bisa dipakai: ${problem}. ` +
            'Pastikan host menjalankan `npm run role:discovery` dan firewall-nya mengizinkan port tersebut.'
        );
      }
      const retry = (await prompter.ask('  URL baru (ketik "batal" untuk membatalkan): ')).trim();
      if (retry.toLowerCase() === 'batal') throw new Error('Setup dibatalkan.');
      discoveryUrl = normalizeUrl(retry);
    }
    console.log(`  Discovery Platform OK: ${discoveryUrl}`);

    // Port TCP — otomatis (default 5000; override dengan --port)
    const listenPort = opts.listenPort ?? existing?.listenPort ?? 5000;
    if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535) {
      throw new Error(`Port TCP tidak valid (1-65535): ${listenPort}`);
    }
    console.log(`  Port TCP: ${listenPort} (otomatis — ubah dengan --port)`);

    // Solid Pod — otomatis aktif (default: Pod lokal di http://localhost:<port>/<nama>/)
    let pod: PodSettings;
    if (opts.podDisabled) {
      pod = { enabled: false };
      console.log('  Solid Pod: nonaktif (--no-pod) — history tidak disimpan.');
    } else if (opts.podUrl) {
      pod = { enabled: true, podUrl: opts.podUrl };
    } else if (existing?.pod && !opts.reconfigure) {
      if (existing.pod.enabled) {
        pod = existing.pod;
      } else if (interactive) {
        const enablePod = await prompter.askYesNo('  Solid Pod saat ini nonaktif. Aktifkan sekarang?');
        if (enablePod) {
          const freePort = await pickAvailableCssPort(3000);
          const defaultPod = `http://localhost:${freePort}/${podNameFromDisplayName(displayName)}/`;
          pod = { enabled: true, podUrl: defaultPod };
          console.log(`  Solid Pod: otomatis (${defaultPod}).`);
        } else {
          pod = existing.pod;
          console.log('  Solid Pod: tetap nonaktif — aktifkan kapan saja dengan: npm run pod:login');
        }
      } else {
        pod = existing.pod;
        console.log(
          '  Solid Pod: nonaktif (dari config tersimpan) — aktifkan dengan: npm run pod:login'
        );
      }
    } else {
      const freePort = await pickAvailableCssPort(3000);
      const defaultPod = `http://localhost:${freePort}/${podNameFromDisplayName(displayName)}/`;
      pod = { enabled: true, podUrl: defaultPod };
      console.log(`  Solid Pod: otomatis (${defaultPod}) — gunakan --no-pod untuk menonaktifkan.`);
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
          let linkedAt = pod.linkedAt;
          let webId = result.webId ?? pod.webId;
          try {
            const client = new SolidClient(opts.homeDir, result.podUrl);
            const linkDoc = await client.linkIdentity(identity);
            webId = linkDoc['@id'];
            linkedAt = linkDoc.proof.created;
            await client.logout().catch(() => undefined);
          } catch {
            // abaikan kegagalan tulis link saat init awal bila non-fatal
          }
          pod = {
            enabled: true,
            podUrl: result.podUrl,
            webId,
            oidcIssuer: `http://localhost:${cssPort}/`,
            authMode: 'clientCredentials',
            linkedAt,
            cssPort,
            email,
            password,
          };
          console.log(`  Pod siap: ${pod.podUrl}${result.provisioned ? ' (akun baru di-provision & di-link)' : ''}`);
        } catch (err: any) {
          console.log(`  ⚠ Setup Pod otomatis gagal: ${err.message}`);
          console.log('  Chat tetap bisa dijalankan tanpa Pod. Coba lagi dengan: npm run pod:login');
          pod = { enabled: false };
        }
      } else {
        console.log('  (Pod non-lokal — pastikan pod-config.json sudah tersedia atau gunakan npm run pod:login)');
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
    console.log(
      `  Pod       : ${
        config.pod.enabled ? config.pod.podUrl : '(nonaktif — aktifkan: npm run pod:login)'
      }`
    );
    if (config.pod.enabled && config.pod.webId) {
      console.log(`  WebID     : ${config.pod.webId}`);
    }
    console.log('');

    return { identity, config };
  } finally {
    prompter.close();
  }
}
