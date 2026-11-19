// packages/user-client/src/profiles.ts
// Manajemen user lokal: daftar profil di device ini, ubah informasi, dan hapus.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultHomeDir, fingerprintOf, Identity } from './identity/identity';
import { loadConfig, saveConfig, UserConfig } from './config';
import {
  generatePassword,
  localCssPortOf,
  pickAvailableCssPort,
  podNameFromDisplayName,
  setupLocalPod,
} from './modules/pod/provision';
import { SolidClient } from './modules/pod/solidClient';
import { createPrompter } from './prompt';
import { checkDiscovery, normalizeUrl } from './wizard';
import { setActiveProfile } from './activeProfile';

export interface IdentityInfo {
  peerId: string;
  displayName: string;
}

export interface LocalProfile {
  homeDir: string;
  identity: IdentityInfo | null;
  config: UserConfig | null;
  isDefault: boolean;
}

export function profileName(profile: LocalProfile): string {
  return profile.config?.displayName ?? profile.identity?.displayName ?? '(tanpa nama)';
}

function readIdentityInfo(homeDir: string): IdentityInfo | null {
  const file = path.join(homeDir, 'identity.json');
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { peerId?: string; displayName?: string };
    if (typeof data.peerId !== 'string' || data.peerId.length === 0) return null;
    return { peerId: data.peerId, displayName: data.displayName ?? '' };
  } catch {
    return null;
  }
}

/** Pindai lokasi user di device ini: home default, .p2pod/* project-local, dan path tambahan. */
export function scanProfiles(extraHomes: string[] = []): LocalProfile[] {
  const candidates = new Map<string, { isDefault: boolean }>();

  const add = (dir: string, isDefault = false): void => {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) return;
    const hasIdentity = fs.existsSync(path.join(resolved, 'identity.json'));
    const hasConfig = fs.existsSync(path.join(resolved, 'config.json'));
    if (!hasIdentity && !hasConfig) return;
    const existing = candidates.get(resolved);
    if (existing) {
      existing.isDefault = existing.isDefault || isDefault;
    } else {
      candidates.set(resolved, { isDefault });
    }
  };

  add(defaultHomeDir(), true);

  const projectBase = path.join(process.cwd(), '.p2pod');
  if (fs.existsSync(projectBase)) {
    for (const entry of fs.readdirSync(projectBase, { withFileTypes: true })) {
      if (entry.isDirectory()) add(path.join(projectBase, entry.name));
    }
  }

  for (const dir of extraHomes) add(dir);

  const profiles: LocalProfile[] = [];
  for (const [homeDir, meta] of candidates) {
    profiles.push({
      homeDir,
      identity: readIdentityInfo(homeDir),
      config: loadConfig(homeDir),
      isDefault: meta.isDefault,
    });
  }
  profiles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || profileName(a).localeCompare(profileName(b)));
  return profiles;
}

function readWebId(profile: LocalProfile): string | undefined {
  if (profile.config?.pod.webId) return profile.config.pod.webId;
  const podConfigFile = path.join(profile.homeDir, 'pod-config.json');
  if (!fs.existsSync(podConfigFile)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(podConfigFile, 'utf8')) as { webId?: string };
    return parsed.webId;
  } catch {
    return undefined;
  }
}

function podLabel(profile: LocalProfile): string {
  if (!profile.config) return '-';
  if (!profile.config.pod.enabled) return '(nonaktif)';
  const mode = profile.config.pod.authMode ? ` [${profile.config.pod.authMode}]` : '';
  return `${profile.config.pod.podUrl ?? '(aktif — url kosong)'}${mode}`;
}

export function formatProfileLines(profiles: LocalProfile[]): string[] {
  const lines: string[] = [];
  profiles.forEach((profile, index) => {
    const name = profileName(profile);
    const peerId = profile.identity?.peerId ?? '';
    const webId = profile.config?.pod.enabled ? readWebId(profile) : undefined;
    const marker = profile.isDefault ? ' (default)' : '';
    const incomplete = profile.config ? '' : ' (belum selesai setup)';
    lines.push(`${String(index + 1).padStart(2)}. ${name}${marker}${incomplete}`);
    lines.push(`    peer id    : ${peerId ? `${peerId.slice(0, 16)}...` : '(tidak ada identity)'}`);
    lines.push(`    fingerprint: ${peerId ? fingerprintOf(peerId) : '-'}`);
    lines.push(
      `    discovery  : ${profile.config?.discoveryUrl ?? '-'}   port TCP: ${profile.config?.listenPort ?? '-'}`
    );
    lines.push(`    pod        : ${podLabel(profile)}`);
    if (webId) {
      lines.push(`    webid      : ${webId}`);
    }
    lines.push(`    path       : ${profile.homeDir}`);
  });
  return lines;
}

export function runProfiles(homeDirArg?: string): void {
  const profiles = scanProfiles(homeDirArg ? [homeDirArg] : []);
  if (profiles.length === 0) {
    console.log('Tidak ada user di device ini. Buat dengan: npm run role:user');
    return;
  }
  console.log(`User di device ini (${profiles.length}):`);
  console.log('');
  for (const line of formatProfileLines(profiles)) console.log(line);
  console.log('');
  console.log('Ubah  : npm run user:edit [-- --home <path>]');
  console.log('Hapus : npm run user:remove [-- --home <path>]');
}

/** Cari profil berdasarkan nama (atau nomor urut dari daftar). */
export function findProfileByName(profiles: LocalProfile[], query: string): LocalProfile | undefined {
  const q = query.trim().toLowerCase();
  const index = parseInt(q, 10);
  if (Number.isInteger(index) && index >= 1 && index <= profiles.length) return profiles[index - 1];
  return (
    profiles.find((profile) => profileName(profile).toLowerCase() === q) ??
    profiles.find((profile) => profileName(profile).toLowerCase().startsWith(q))
  );
}

export interface SwitchOptions {
  homeDir?: string;
  target?: string;
}

/** Jadikan salah satu profil sebagai user AKTIF (dipakai `npm run user` berikutnya). */
export async function runSwitch(opts: SwitchOptions): Promise<void> {
  const profiles = scanProfiles(opts.homeDir ? [opts.homeDir] : []);
  if (profiles.length === 0) {
    throw new Error('Belum ada user di device ini. Buat dulu: npm run user:add');
  }

  let target: LocalProfile;
  if (opts.homeDir) {
    const resolved = path.resolve(opts.homeDir);
    const found = profiles.find((profile) => profile.homeDir === resolved);
    if (!found) throw new Error(`Tidak ada profil user di ${resolved}.`);
    target = found;
  } else if (opts.target) {
    const found = findProfileByName(profiles, opts.target);
    if (!found) {
      throw new Error(`User "${opts.target}" tidak ditemukan. Lihat daftar: npm run user:profiles`);
    }
    target = found;
  } else {
    target = await pickProfile(profiles, undefined, 'dijadikan aktif');
  }

  setActiveProfile(target.homeDir, profileName(target));
  console.log('');
  console.log(`User aktif sekarang: ${profileName(target)} (${target.homeDir})`);
  if (!target.config) {
    console.log('⚠ Profil ini belum selesai setup — selesaikan: npm run role:user -- --home ' + target.homeDir);
  } else {
    console.log('Mulai: npm run user');
  }
}

export async function pickProfile(
  profiles: LocalProfile[],
  homeDirArg: string | undefined,
  actionLabel: string
): Promise<LocalProfile> {
  if (homeDirArg) {
    const resolved = path.resolve(homeDirArg);
    const found = profiles.find((profile) => profile.homeDir === resolved);
    if (!found) {
      throw new Error(`Tidak ada profil user di ${resolved} (identity.json/config.json tidak ditemukan).`);
    }
    return found;
  }

  if (profiles.length === 0) throw new Error('Tidak ada user di device ini.');
  if (profiles.length === 1) return profiles[0];

  if (!process.stdin.isTTY) {
    const list = profiles
      .map((profile, index) => `  ${index + 1}. ${profileName(profile)} — ${profile.homeDir}`)
      .join('\n');
    throw new Error(`Ada ${profiles.length} user di device ini — pilih dengan --home <path>:\n${list}`);
  }

  console.log(`Ada ${profiles.length} user di device ini:`);
  profiles.forEach((profile, index) => console.log(`  ${index + 1}. ${profileName(profile)} — ${profile.homeDir}`));

  const prompter = createPrompter();
  try {
    const answer = (await prompter.ask(`Pilih nomor user yang mau ${actionLabel} (atau "batal"): `)).trim();
    if (answer.toLowerCase() === 'batal') throw new Error('Dibatalkan.');
    const index = parseInt(answer, 10);
    if (!Number.isInteger(index) || index < 1 || index > profiles.length) throw new Error('Pilihan tidak valid.');
    return profiles[index - 1];
  } finally {
    prompter.close();
  }
}

export interface EditOptions {
  homeDir?: string;
  name?: string;
  discoveryUrl?: string;
  listenPort?: number;
  podUrl?: string;
  podDisabled?: boolean;
}

export async function runEdit(opts: EditOptions): Promise<void> {
  const profiles = scanProfiles(opts.homeDir ? [opts.homeDir] : []);
  const target = await pickProfile(profiles, opts.homeDir, 'diubah');
  const config = target.config;
  const currentName = profileName(target);

  const hasFlagChanges =
    opts.name !== undefined ||
    opts.discoveryUrl !== undefined ||
    opts.listenPort !== undefined ||
    opts.podUrl !== undefined ||
    opts.podDisabled === true;

  let newName = opts.name;
  let newDiscovery = opts.discoveryUrl;
  let newPort = opts.listenPort;
  let podChange: 'none' | 'enable' | 'disable' = opts.podDisabled ? 'disable' : opts.podUrl ? 'enable' : 'none';

  if (!hasFlagChanges) {
    if (!process.stdin.isTTY) {
      throw new Error(
        'Tidak ada perubahan yang diminta. Gunakan flag: --name, --discovery, --port, --pod <url>, atau --no-pod.'
      );
    }
    console.log(`Mengubah user "${currentName}" (${target.homeDir})`);
    console.log('(Enter = biarkan nilai sekarang)');
    const prompter = createPrompter();
    try {
      const nameAnswer = (await prompter.ask(`  Nama [${currentName}]: `)).trim();
      if (nameAnswer.length > 0 && nameAnswer !== currentName) newName = nameAnswer;

      const discoveryAnswer = (await prompter.ask(`  URL Discovery [${config?.discoveryUrl ?? '-'}]: `)).trim();
      if (discoveryAnswer.length > 0) newDiscovery = discoveryAnswer;

      const portAnswer = (await prompter.ask(`  Port TCP [${config?.listenPort ?? '-'}]: `)).trim();
      if (portAnswer.length > 0) newPort = parseInt(portAnswer, 10);

      const currentPod = config?.pod.enabled ? 'aktif' : 'nonaktif';
      const podAnswer = (await prompter.ask(
        `  Solid Pod (y=aktifkan / n=nonaktifkan / Enter=biarkan) [${currentPod}]: `
      ))
        .trim()
        .toLowerCase();
      if (podAnswer === 'y' || podAnswer === 'ya' || podAnswer === 'yes') podChange = 'enable';
      else if (podAnswer === 'n' || podAnswer === 'tidak' || podAnswer === 'no') podChange = 'disable';
    } finally {
      prompter.close();
    }
  }

  if (newPort !== undefined && (!Number.isInteger(newPort) || newPort <= 0 || newPort > 65535)) {
    throw new Error(`Port TCP tidak valid (1-65535): ${newPort}`);
  }

  if (newDiscovery !== undefined) {
    newDiscovery = normalizeUrl(newDiscovery);
    if (newDiscovery !== config?.discoveryUrl) {
      const problem = await checkDiscovery(newDiscovery);
      if (problem) {
        throw new Error(`URL Discovery Platform (${newDiscovery}) tidak bisa dipakai: ${problem}`);
      }
    }
  }

  const changedFields: string[] = [];

  // Identity (displayName). Keypair/Peer ID tetap sama.
  const identityPath = path.join(target.homeDir, 'identity.json');
  if (newName !== undefined && newName !== currentName && fs.existsSync(identityPath)) {
    Identity.loadOrCreate(target.homeDir, newName);
    changedFields.push(`nama: ${currentName} → ${newName}`);
  } else if (newName !== undefined && !fs.existsSync(identityPath)) {
    Identity.loadOrCreate(target.homeDir, newName);
    changedFields.push(`nama: (baru) ${newName}`);
  }

  if (config) {
    const updated: UserConfig = {
      ...config,
      displayName: newName ?? config.displayName,
      discoveryUrl: newDiscovery ?? config.discoveryUrl,
      listenPort: newPort ?? config.listenPort,
      updatedAt: new Date().toISOString(),
    };

    if (newDiscovery !== undefined && newDiscovery !== config.discoveryUrl) {
      changedFields.push(`discovery: ${config.discoveryUrl} → ${updated.discoveryUrl}`);
    }
    if (newPort !== undefined && newPort !== config.listenPort) {
      changedFields.push(`port TCP: ${config.listenPort} → ${updated.listenPort}`);
    }

    if (podChange === 'disable') {
      updated.pod = { enabled: false };
      changedFields.push('pod: dinonaktifkan');
    } else if (podChange === 'enable') {
      const freePort = await pickAvailableCssPort(3000);
      const podUrlInput =
        opts.podUrl ?? `http://localhost:${freePort}/${podNameFromDisplayName(updated.displayName)}/`;
      updated.pod = { enabled: true, podUrl: podUrlInput };
      changedFields.push(`pod: diaktifkan (${podUrlInput})`);
    }

    // Pod lokal yang baru diaktifkan → siapkan CSS + provisioning otomatis.
    if (podChange === 'enable' && updated.pod.enabled && updated.pod.podUrl) {
      const cssPort = localCssPortOf(updated.pod.podUrl);
      if (cssPort) {
        const email = updated.pod.email ?? `${podNameFromDisplayName(updated.displayName)}@example.com`;
        const password = updated.pod.password ?? generatePassword();
        console.log(`  Menyiapkan Solid Pod lokal (CSS port ${cssPort})...`);
        try {
          const result = await setupLocalPod({
            homeDir: target.homeDir,
            displayName: updated.displayName,
            cssPort,
            email,
            password,
            podUrl: updated.pod.podUrl,
          });
          let webId = result.webId;
          let linkedAt: string | undefined;
          try {
            const identityObj = Identity.loadOrCreate(target.homeDir, updated.displayName);
            const client = new SolidClient(target.homeDir, result.podUrl);
            const linkDoc = await client.linkIdentity(identityObj);
            webId = linkDoc['@id'];
            linkedAt = linkDoc.proof.created;
            await client.logout().catch(() => undefined);
          } catch {
            // abaikan bila non-fatal
          }
          updated.pod = {
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
          console.log(`  Pod siap: ${updated.pod.podUrl}${result.provisioned ? ' (akun baru di-provision)' : ''}`);
        } catch (err: any) {
          console.log(`  ⚠ Setup Pod otomatis gagal: ${err.message}`);
          updated.pod = { enabled: false };
          changedFields.push('pod: dinonaktifkan kembali (setup gagal)');
        }
      }
    }

    saveConfig(target.homeDir, updated);
  } else if (podChange === 'enable') {
    throw new Error('Profil ini belum punya config — selesaikan dulu dengan: npm run role:user -- --home <path>');
  }

  if (changedFields.length === 0) {
    console.log('Tidak ada perubahan.');
    return;
  }

  console.log('');
  console.log('Perubahan disimpan:');
  for (const field of changedFields) console.log(`  • ${field}`);
  console.log('');

  const refreshed = scanProfiles([target.homeDir]).find((profile) => profile.homeDir === target.homeDir);
  if (refreshed) {
    for (const line of formatProfileLines([refreshed])) console.log(line);
  }
  if (changedFields.some((field) => field.startsWith('nama'))) {
    console.log('(Peer ID tidak berubah — keypair tetap sama.)');
  }
}

export interface RemoveOptions {
  homeDir?: string;
  yes?: boolean;
}

export async function runRemove(opts: RemoveOptions): Promise<void> {
  const profiles = scanProfiles(opts.homeDir ? [opts.homeDir] : []);
  const target = await pickProfile(profiles, opts.homeDir, 'dihapus');
  const name = profileName(target);
  const resolved = target.homeDir;

  ensureSafeToDelete(resolved);

  const files = ['identity.json', 'config.json', 'pod-config.json'].filter((file) =>
    fs.existsSync(path.join(resolved, file))
  );
  if (files.length === 0) {
    throw new Error('Tidak ada file profil (identity.json/config.json) di folder itu.');
  }

  console.log(`Akan dihapus: user "${name}"`);
  console.log(`  path : ${resolved}`);
  console.log(`  file : ${files.join(', ')}`);

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new Error('Konfirmasi diperlukan — tambahkan --yes untuk menghapus tanpa konfirmasi.');
    }
    const prompter = createPrompter();
    try {
      const answer = (await prompter.ask(`Ketik nama user ("${name}") untuk konfirmasi, atau "batal": `)).trim();
      if (answer !== name) throw new Error('Penghapusan dibatalkan.');
    } finally {
      prompter.close();
    }
  }

  fs.rmSync(resolved, { recursive: true, force: true });
  console.log(`User "${name}" dihapus dari device ini.`);

  const podName = podNameFromDisplayName(name);
  console.log('Catatan: data Pod di sisi CSS TIDAK ikut terhapus.');
  console.log(`  - Hentikan CSS lokal (bila berjalan): npm run pod:stop -- --name ${podName}`);
  console.log(`  - Data pod lokal (bila ada) tetap di  : .css/${podName}/`);
}

function ensureSafeToDelete(dir: string): void {
  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  if (resolved === root) throw new Error('Menolak menghapus root drive.');
  if (resolved === path.resolve(os.homedir())) throw new Error('Menolak menghapus home directory OS.');
  if (resolved === path.resolve(process.cwd())) throw new Error('Menolak menghapus direktori kerja saat ini.');
  if (fs.existsSync(path.join(resolved, 'package.json')) || fs.existsSync(path.join(resolved, 'node_modules'))) {
    throw new Error('Folder terlihat seperti root project (ada package.json/node_modules). Menolak menghapus.');
  }
  const markers = ['identity.json', 'config.json'].some((file) => fs.existsSync(path.join(resolved, file)));
  if (!markers) {
    throw new Error('Folder tidak berisi profil P2Pod (identity.json/config.json tidak ditemukan).');
  }
}
