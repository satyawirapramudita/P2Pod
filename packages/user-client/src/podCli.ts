// packages/user-client/src/podCli.ts
// CLI untuk login ke Solid Community (solidcommunity.net / Solid-OIDC provider)
// dan menautkan (linking) WebID Solid Pod dengan identitas kriptografis P2Pod (Ed25519).

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, saveConfig, UserConfig } from './config';
import { Identity } from './identity/identity';
import {
  ensureLocalCssRunning,
  localCssPortOf,
  podNameFromUrl,
} from './modules/pod/provision';
import {
  DEFAULT_SOLID_ISSUER,
  loginWithSolidAccount,
  loginWithSolidBrowser,
  normalizeIssuerUrl,
  SolidLoginResult,
} from './modules/pod/solidAuth';
import { SolidClient } from './modules/pod/solidClient';
import { createPrompter } from './prompt';

export interface PodLoginCliOptions {
  homeDir: string;
  displayName?: string;
  issuerUrl?: string;
  email?: string;
  password?: string;
  podUrl?: string;
  useBrowser?: boolean;
}

export async function linkAndPersistPod(opts: {
  homeDir: string;
  identity: Identity;
  podUrl: string;
  webId?: string;
  oidcIssuer?: string;
  authMode?: 'clientCredentials' | 'oidc';
  cssPort?: number;
  email?: string;
  password?: string;
}): Promise<{ webId: string; linkUrl: string; linkedAt: string }> {
  const cssPort = opts.cssPort ?? localCssPortOf(opts.podUrl) ?? undefined;
  if (cssPort) {
    const name = podNameFromUrl(opts.podUrl, opts.identity.displayName);
    await ensureLocalCssRunning({ cssPort, name });
  }

  const client = new SolidClient(opts.homeDir, opts.podUrl);
  const linkDoc = await client.linkIdentity(opts.identity);
  const verified = await client.loadIdentityLink();
  if (!verified) {
    throw new Error('Dokumen identity-link.json berhasil ditulis tetapi gagal diverifikasi kembali.');
  }
  await client.logout().catch(() => undefined);

  const webId = linkDoc['@id'];
  const linkedAt = linkDoc.proof.created;

  const existing = loadConfig(opts.homeDir);
  const now = new Date().toISOString();
  const updatedConfig: UserConfig = {
    displayName: existing?.displayName ?? opts.identity.displayName,
    discoveryUrl: existing?.discoveryUrl ?? 'http://localhost:4000',
    listenPort: existing?.listenPort ?? 5000,
    pod: {
      enabled: true,
      podUrl: client.basePodUrl,
      webId,
      oidcIssuer: opts.oidcIssuer ?? client.oidcIssuer,
      authMode: opts.authMode ?? client.authMode,
      linkedAt,
      cssPort,
      email: opts.email ?? existing?.pod.email,
      password: opts.password ?? existing?.pod.password,
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  saveConfig(opts.homeDir, updatedConfig);

  return {
    webId,
    linkUrl: client.identityLinkUrl(),
    linkedAt,
  };
}

export async function runPodLogin(opts: PodLoginCliOptions): Promise<void> {
  const existingConfig = loadConfig(opts.homeDir);
  const displayName = opts.displayName ?? existingConfig?.displayName;
  const identity = Identity.loadOrCreate(opts.homeDir, displayName);
  const interactive = Boolean(process.stdin.isTTY);

  let issuerUrl = opts.issuerUrl;
  let email = opts.email;
  let password = opts.password;
  let useBrowser = opts.useBrowser;

  if (!useBrowser && (!email || !password)) {
    if (!interactive) {
      throw new Error(
        'Mode non-interaktif membutuhkan --browser (untuk OIDC redirect) atau --email <email> --password <password>.'
      );
    }

    const prompter = createPrompter();
    try {
      console.log('— Login & Linking Solid Pod (Solid Community / Solid-OIDC) —');
      console.log(`  Profil P2Pod : ${identity.displayName} (${opts.homeDir})`);
      console.log(`  Peer ID      : ${identity.peerId}`);
      console.log('');

      const defaultIssuer = issuerUrl ?? existingConfig?.pod.oidcIssuer ?? DEFAULT_SOLID_ISSUER;
      const issuerInput = (
        await prompter.ask(`  1/2 URL Solid Provider / Issuer [${defaultIssuer}]: `)
      ).trim();
      issuerUrl = normalizeIssuerUrl(issuerInput.length > 0 ? issuerInput : defaultIssuer);

      console.log('');
      console.log('  Pilih metode autentikasi:');
      console.log('    1. Login via Browser (Solid-OIDC Redirect / PKCE — standar WebID)');
      console.log('    2. Login via Terminal (Email & Password akun Solid Community / CSS)');
      const modeInput = (await prompter.ask('  2/2 Pilihan (1/2) [1]: ')).trim();

      if (modeInput === '2') {
        useBrowser = false;
        while (!email || email.trim().length === 0) {
          email = (await prompter.ask('  Email akun Solid: ')).trim();
        }
        while (!password || password.trim().length === 0) {
          password = (await prompter.ask('  Password akun Solid: ')).trim();
        }
      } else {
        useBrowser = true;
      }
    } finally {
      prompter.close();
    }
  } else {
    issuerUrl = normalizeIssuerUrl(issuerUrl ?? existingConfig?.pod.oidcIssuer ?? DEFAULT_SOLID_ISSUER);
  }

  let loginResult: SolidLoginResult;
  if (useBrowser) {
    console.log(`  Menghubungi Solid-OIDC Provider (${issuerUrl})...`);
    console.log('  Silakan selesaikan login di jendela browser yang terbuka.');
    loginResult = await loginWithSolidBrowser({
      oidcIssuer: issuerUrl,
      homeDir: opts.homeDir,
      podUrlOverride: opts.podUrl,
    });
  } else {
    if (!email || !password) {
      throw new Error('Email dan password akun Solid wajib diisi.');
    }
    console.log(`  Login ke akun Solid di ${issuerUrl}...`);
    loginResult = await loginWithSolidAccount({
      issuerUrl,
      email,
      password,
      podUrlOverride: opts.podUrl,
      homeDir: opts.homeDir,
    });
  }

  console.log(`  Autentikasi berhasil: WebID ${loginResult.webId}`);
  console.log('  Menautkan (linking) identitas Ed25519 P2Pod ke Solid Pod...');

  const linked = await linkAndPersistPod({
    homeDir: opts.homeDir,
    identity,
    podUrl: loginResult.podUrl,
    webId: loginResult.webId,
    oidcIssuer: loginResult.oidcIssuer,
    authMode: loginResult.authMode,
    email,
  });

  console.log('');
  console.log('— Login & Linking Solid Pod Selesai —');
  console.log(`  Nama P2Pod  : ${identity.displayName}`);
  console.log(`  Peer ID     : ${identity.peerId}`);
  console.log(`  Fingerprint : ${identity.fingerprint}`);
  console.log(`  Provider    : ${loginResult.oidcIssuer} (${loginResult.authMode})`);
  console.log(`  WebID Solid : ${linked.webId}`);
  console.log(`  Pod URL     : ${loginResult.podUrl}`);
  console.log(`  Bukti Link  : ${linked.linkUrl}`);
  console.log(`  Status      : Terverifikasi (Ed25519 signature cocok)`);
  console.log('');
}

export async function runPodLink(opts: { homeDir: string; podUrl?: string; displayName?: string }): Promise<void> {
  const existingConfig = loadConfig(opts.homeDir);
  const identity = Identity.loadOrCreate(opts.homeDir, opts.displayName ?? existingConfig?.displayName);
  const podConfigPath = path.join(opts.homeDir, 'pod-config.json');

  if (!fs.existsSync(podConfigPath)) {
    throw new Error(
      `Konfigurasi Pod belum ditemukan di ${podConfigPath}. Jalankan dulu: npm run pod:login atau buat profil di Web UI`
    );
  }

  const rawPodConfig = JSON.parse(fs.readFileSync(podConfigPath, 'utf8')) as {
    podUrl?: string;
    webId?: string;
    oidcIssuer?: string;
    authMode?: 'clientCredentials' | 'oidc';
  };

  const podUrl = opts.podUrl ?? existingConfig?.pod.podUrl ?? rawPodConfig.podUrl;
  if (!podUrl) {
    throw new Error('URL Pod tidak ditemukan. Sertakan --pod <url> atau jalankan npm run pod:login.');
  }

  console.log(`Menautkan identitas P2Pod (${identity.displayName}) ke Solid Pod (${podUrl})...`);
  const linked = await linkAndPersistPod({
    homeDir: opts.homeDir,
    identity,
    podUrl,
    webId: rawPodConfig.webId,
    oidcIssuer: rawPodConfig.oidcIssuer,
    authMode: rawPodConfig.authMode,
  });

  console.log('');
  console.log('— Linking Identitas P2Pod ke Solid Pod Berhasil —');
  console.log(`  Nama P2Pod  : ${identity.displayName}`);
  console.log(`  Peer ID     : ${identity.peerId}`);
  console.log(`  Fingerprint : ${identity.fingerprint}`);
  console.log(`  WebID Solid : ${linked.webId}`);
  console.log(`  Pod URL     : ${podUrl}`);
  console.log(`  Bukti Link  : ${linked.linkUrl}`);
  console.log(`  Linked At   : ${linked.linkedAt}`);
  console.log(`  Verifikasi  : OK (Ed25519 signature valid)`);
  console.log('');
}
