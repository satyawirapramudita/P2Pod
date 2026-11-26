// packages/user-client/src/config.ts
// Konfigurasi user P2Pod yang tersimpan (dibuat oleh wizard `init`).

import * as fs from 'fs';
import * as path from 'path';

export interface PodSettings {
  enabled: boolean;
  podUrl?: string;
  webId?: string;
  oidcIssuer?: string;
  authMode?: 'clientCredentials' | 'oidc';
  linkedAt?: string;
  cssPort?: number;
  email?: string;
  password?: string;
}

export interface NetworkSettings {
  /** Public IPv4/IPv6/hostname other peers should dial. Empty = use discovery-observed IP. */
  publicHost?: string;
  /** Public TCP port when the router/Docker maps a different external port. */
  publicPort?: number;
  /** Optional shared secret required by a public discovery server. */
  discoveryToken?: string;
}

export interface UserConfig {
  displayName: string;
  discoveryUrl: string;
  listenPort: number;
  pod: PodSettings;
  network?: NetworkSettings;
  createdAt: string;
  updatedAt: string;
}

export function networkOf(config: UserConfig | null | undefined): NetworkSettings {
  return config?.network ?? {};
}

export function configPath(homeDir: string): string {
  return path.join(homeDir, 'config.json');
}

export function loadConfig(homeDir: string): UserConfig | null {
  const file = configPath(homeDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as UserConfig;
    if (!parsed.displayName || !parsed.discoveryUrl || !parsed.listenPort) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveConfig(homeDir: string, config: UserConfig): void {
  fs.writeFileSync(configPath(homeDir), JSON.stringify(config, null, 2), { mode: 0o600 });
}
