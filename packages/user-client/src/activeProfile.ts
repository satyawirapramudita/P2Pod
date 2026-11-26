// packages/user-client/src/activeProfile.ts
// Menentukan & menyimpan profil user yang AKTIF di device ini.
// Pointer disimpan di <cwd>/.p2pod/active.json (folder .p2pod/ sudah di-gitignore).

import * as fs from 'fs';
import * as path from 'path';
import { defaultHomeDir } from './identity/identity';

export interface ActiveProfileState {
  homeDir: string;
  name?: string;
  updatedAt: string;
}

export function activeStatePath(): string {
  const stateDir = process.env.P2POD_STATE_DIR
    ? path.resolve(process.env.P2POD_STATE_DIR)
    : path.join(process.cwd(), '.p2pod');
  return path.join(stateDir, 'active.json');
}

function hasProfileFiles(homeDir: string): boolean {
  return (
    fs.existsSync(path.join(homeDir, 'identity.json')) ||
    fs.existsSync(path.join(homeDir, 'config.json'))
  );
}

export function hasConfig(homeDir: string): boolean {
  return fs.existsSync(path.join(homeDir, 'config.json'));
}

/** Baca home profil aktif; undefined bila pointer tidak ada / profilnya sudah hilang. */
export function readActiveHomeDir(opts: { warn?: boolean } = {}): string | undefined {
  const file = activeStatePath();
  if (!fs.existsSync(file)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ActiveProfileState>;
    if (typeof data.homeDir !== 'string' || data.homeDir.length === 0) return undefined;
    const resolved = path.resolve(data.homeDir);
    if (!hasProfileFiles(resolved)) {
      if (opts.warn) {
        console.warn(`[P2Pod] Profil aktif tidak ditemukan lagi (${resolved}) — kembali ke default.`);
      }
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}

/** Jadikan `homeDir` sebagai profil aktif. */
export function setActiveProfile(homeDir: string, name?: string): void {
  const resolved = path.resolve(homeDir);
  fs.mkdirSync(path.dirname(activeStatePath()), { recursive: true });
  const state: ActiveProfileState = {
    homeDir: resolved,
    name,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(activeStatePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export interface ResolveHomeOptions {
  /** Nilai `--home` eksplisit (sudah di-resolve). Menang atas semua sumber lain. */
  explicitHome?: string;
  /** Wajib ada config.json (profil selesai setup) — untuk perintah pod & `run`. */
  requireConfig?: boolean;
}

/**
 * Urutan prioritas: `--home` eksplisit → P2POD_HOME → profil aktif → ~/.p2pod.
 * Bila `requireConfig` dan config.json tidak ada → lempar error dengan petunjuk.
 */
export function resolveProfileHome(opts: ResolveHomeOptions = {}): string {
  const home = resolveProfileHomeLenient(opts.explicitHome);
  if (opts.requireConfig && !hasConfig(home)) {
    if (!hasProfileFiles(home)) {
      throw new Error('Belum ada profil user aktif. Buat dulu: npm run user:add');
    }
    throw new Error(
      `Profil di ${home} belum selesai setup. Selesaikan: npm run user:add -- --home ${home}`
    );
  }
  return home;
}

function resolveProfileHomeLenient(explicitHome?: string): string {
  if (explicitHome) return path.resolve(explicitHome);
  if (process.env.P2POD_HOME) return path.resolve(process.env.P2POD_HOME);
  const active = readActiveHomeDir({ warn: true });
  if (active) return active;
  return defaultHomeDir();
}
