// packages/user-client/src/profileSetup.ts
// Non-interactive profile creation shared by the Web UI and automation.

import * as fs from 'fs';
import * as path from 'path';
import { Identity, ensureDir } from './identity/identity';
import { loadConfig, NetworkSettings, PodSettings, saveConfig, UserConfig } from './config';
import {
  generatePassword,
  localCssPortOf,
  podNameFromDisplayName,
  setupLocalPod,
} from './modules/pod/provision';
import { buildNetworkSettings, checkDiscovery, normalizeUrl } from './wizard';
import { isValidHost } from './discovery/discoveryClient';

export interface CreateProfileOptions {
  homeDir: string;
  displayName: string;
  discoveryUrl: string;
  listenPort?: number;
  podUrl?: string;
  podDisabled?: boolean;
  publicHost?: string;
  publicPort?: number;
  discoveryToken?: string;
}

export interface CreateProfileResult {
  identity: Identity;
  config: UserConfig;
  warning?: string;
}

export async function createProfile(opts: CreateProfileOptions): Promise<CreateProfileResult> {
  const homeDir = path.resolve(opts.homeDir);
  const displayName = opts.displayName.trim();
  if (!displayName) {
    throw new Error('Nama user wajib diisi.');
  }

  const discoveryUrl = normalizeUrl(opts.discoveryUrl);
  const discoveryProblem = await checkDiscovery(discoveryUrl);
  if (discoveryProblem) {
    throw new Error(
      `Discovery Platform tidak bisa dipakai (${discoveryUrl}): ${discoveryProblem}. ` +
        'Pastikan server discovery berjalan dan URL/port-nya benar.'
    );
  }

  const listenPort = opts.listenPort ?? 5000;
  if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535) {
    throw new Error(`Port TCP tidak valid (1-65535): ${listenPort}`);
  }

  const network: NetworkSettings | undefined = buildNetworkSettings(opts);
  ensureDir(homeDir);

  const existingConfig = loadConfig(homeDir);
  if (existingConfig) {
    throw new Error(`Profil sudah ada di ${homeDir}. Pilih folder lain atau gunakan profil tersebut.`);
  }

  const identity = Identity.loadOrCreate(homeDir, displayName);
  let pod: PodSettings = { enabled: false };
  let warning: string | undefined;

  if (!opts.podDisabled && opts.podUrl?.trim()) {
    const podUrl = opts.podUrl.trim();
    const cssPort = localCssPortOf(podUrl);
    if (cssPort) {
      const podName = podNameFromDisplayName(displayName);
      const email = `${podName}@example.com`;
      const password = generatePassword();
      try {
        const result = await setupLocalPod({
          homeDir,
          displayName,
          cssPort,
          email,
          password,
          podUrl,
        });
        pod = {
          enabled: true,
          podUrl: result.podUrl,
          webId: result.webId,
          oidcIssuer: `http://localhost:${cssPort}/`,
          authMode: 'clientCredentials',
          cssPort,
          email,
          password,
        };
      } catch (err: any) {
        warning = `Solid Pod lokal gagal disiapkan: ${err.message}. Chat tetap berjalan tanpa Pod.`;
        pod = { enabled: false };
      }
    } else {
      pod = { enabled: true, podUrl };
    }
  }

  const now = new Date().toISOString();
  const config: UserConfig = {
    displayName: identity.displayName,
    discoveryUrl,
    listenPort,
    pod,
    network,
    createdAt: now,
    updatedAt: now,
  };
  saveConfig(homeDir, config);

  return { identity, config, warning };
}

export interface UpdateProfileInput {
  discoveryUrl?: string;
  listenPort?: number;
  publicHost?: string | null;
  publicPort?: number | null;
  discoveryToken?: string | null;
}

export async function updateProfileSettings(
  homeDir: string,
  patch: UpdateProfileInput
): Promise<UserConfig> {
  const resolved = path.resolve(homeDir);
  const config = loadConfig(resolved);
  if (!config) {
    throw new Error(`Profil di ${resolved} belum lengkap (config.json tidak ditemukan).`);
  }

  let discoveryUrl = config.discoveryUrl;
  if (patch.discoveryUrl !== undefined) {
    discoveryUrl = normalizeUrl(patch.discoveryUrl);
    if (discoveryUrl !== config.discoveryUrl) {
      const problem = await checkDiscovery(discoveryUrl);
      if (problem) {
        throw new Error(`Discovery Platform tidak bisa dipakai (${discoveryUrl}): ${problem}`);
      }
    }
  }

  const listenPort = patch.listenPort ?? config.listenPort;
  if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535) {
    throw new Error(`Port TCP tidak valid (1-65535): ${listenPort}`);
  }

  const network: NetworkSettings = { ...(config.network ?? {}) };
  if (patch.publicHost !== undefined) {
    const host = patch.publicHost?.trim() ?? '';
    if (host && !isValidHost(host)) {
      throw new Error(`Public host tidak valid: ${host}`);
    }
    if (host) network.publicHost = host;
    else delete network.publicHost;
  }
  if (patch.publicPort !== undefined) {
    const port = patch.publicPort;
    if (port === null) {
      delete network.publicPort;
    } else if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Public port tidak valid (1-65535): ${port}`);
    } else {
      network.publicPort = port;
    }
  }
  if (patch.discoveryToken !== undefined) {
    const token = patch.discoveryToken?.trim() ?? '';
    if (token) network.discoveryToken = token;
    else delete network.discoveryToken;
  }

  const updated: UserConfig = {
    ...config,
    discoveryUrl,
    listenPort,
    network: Object.keys(network).length > 0 ? network : undefined,
    updatedAt: new Date().toISOString(),
  };
  saveConfig(resolved, updated);
  return updated;
}

export function profileRoot(): string {
  return process.env.P2POD_DATA_DIR
    ? path.resolve(process.env.P2POD_DATA_DIR)
    : path.join(process.cwd(), '.p2pod');
}

export function resolveNewProfileHome(displayName: string, preferredHome?: string): string {
  const explicit = process.env.P2POD_HOME ? path.resolve(process.env.P2POD_HOME) : '';
  if (preferredHome) {
    const resolved = path.resolve(preferredHome);
    if (!fs.existsSync(resolved) || (!fs.existsSync(path.join(resolved, 'config.json')) && !fs.existsSync(path.join(resolved, 'identity.json')))) {
      return resolved;
    }
  }
  if (explicit && !fs.existsSync(path.join(explicit, 'config.json'))) {
    return explicit;
  }

  const base = profileRoot();
  const slug = podNameFromDisplayName(displayName);
  let candidate = path.join(base, slug);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(base, `${slug}-${suffix}`);
    suffix++;
  }
  return candidate;
}