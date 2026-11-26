// packages/user-client/src/main.ts

import * as fs from 'fs';
import * as path from 'path';
import { PeerApp } from './core/peerApp';
import { Identity, defaultHomeDir, ensureDir, fingerprintOf } from './identity/identity';
import { DiscoveryClient, detectLocalIp, isValidHost, normalizePublicHost } from './discovery/discoveryClient';
import { loadConfig, UserConfig } from './config';
import { runWizard } from './wizard';
import { resolveTarget } from './targetResolver';
import { runEdit, runProfiles, runRemove, runSwitch } from './profiles';
import { resolveProfileHome, setActiveProfile } from './activeProfile';
import { createPrompter } from './prompt';
import { ensureLocalCssRunning, localCssPortOf, podNameFromDisplayName } from './modules/pod/provision';
import { profileRoot } from './profileSetup';
import { runPodLink, runPodLogin } from './podCli';
import { WebBridge } from './web/webBridge';
import { openBrowser } from './modules/pod/solidAuth';

interface CliOptions {
  command:
    | 'run'
    | 'web'
    | 'add'
    | 'switch'
    | 'init'
    | 'listen'
    | 'connect'
    | 'list'
    | 'profiles'
    | 'edit'
    | 'remove'
    | 'pod-login'
    | 'pod-link'
    | 'none';
  connectTarget?: string;
  switchTarget?: string;
  peerIp?: string;
  peerPort?: number;
  port?: number;
  uiPort?: number;
  noOpen?: boolean;
  podUrl?: string;
  podDisabled: boolean;
  discoveryUrl?: string;
  publicHost?: string;
  publicPort?: number;
  discoveryToken?: string;
  uiHost?: string;
  homeDir: string;
  homeExplicit: boolean;
  displayName?: string;
  reconfigure: boolean;
  yes: boolean;
  issuerUrl?: string;
  email?: string;
  password?: string;
  useBrowser?: boolean;
}

const COMMANDS = new Set([
  'run',
  'web',
  'add',
  'switch',
  'init',
  'listen',
  'connect',
  'list',
  'profiles',
  'edit',
  'remove',
  'pod-login',
  'pod-link',
]);

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: 'none',
    podDisabled: false,
    reconfigure: false,
    yes: false,
    homeExplicit: false,
    homeDir: defaultHomeDir(),
  };

  // Perintah positional harus menjadi argumen pertama (argv[2]).
  let i = 2;
  if (argv[2] && COMMANDS.has(argv[2])) {
    opts.command = argv[2] as CliOptions['command'];
    i = 3;
    if (opts.command === 'connect' && argv[3] && !argv[3].startsWith('--')) {
      opts.connectTarget = argv[3];
      i = 4;
    }
    if (opts.command === 'switch' && argv[3] && !argv[3].startsWith('--')) {
      opts.switchTarget = argv[3];
      i = 4;
    }
  }

  for (; i < argv.length; i++) {
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
      case '--listen':
        if (inlineValue !== undefined) throw new Error('--listen tidak menerima nilai');
        opts.command = 'listen';
        break;
      case '--connect':
        opts.command = 'connect';
        opts.connectTarget = value();
        break;
      case '--port':
        opts.port = parseInt(value(), 10);
        break;
      case '--ui-port':
        opts.uiPort = parseInt(value(), 10);
        break;
      case '--ui-host':
        opts.uiHost = value();
        break;
      case '--no-open':
        opts.noOpen = true;
        break;
      case '--public-host':
        opts.publicHost = value();
        break;
      case '--public-port':
        opts.publicPort = parseInt(value(), 10);
        break;
      case '--discovery-token':
        opts.discoveryToken = value();
        break;
      case '--peer-ip':
        opts.peerIp = value();
        break;
      case '--peer-port':
        opts.peerPort = parseInt(value(), 10);
        break;
      case '--pod':
        opts.podUrl = value();
        break;
      case '--no-pod':
        opts.podDisabled = true;
        break;
      case '--discovery':
        opts.discoveryUrl = value();
        break;
      case '--home':
        opts.homeDir = path.resolve(value());
        opts.homeExplicit = true;
        break;
      case '--name':
        opts.displayName = value();
        break;
      case '--reconfigure':
        opts.reconfigure = true;
        break;
      case '--yes':
        opts.yes = true;
        break;
      case '--issuer':
      case '--css':
        opts.issuerUrl = value();
        break;
      case '--email':
        opts.email = value();
        break;
      case '--password':
        opts.password = value();
        break;
      case '--browser':
        opts.useBrowser = true;
        break;
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        if (!raw.startsWith('--')) {
          throw new Error(
            `Argumen tidak dikenal: ${raw}\n` +
              'Hint: perintah tersedia → init | listen | connect <nama|PeerID> | list | pod-login | pod-link'
          );
        }
        throw new Error(`Argumen tidak dikenal: ${raw} (gunakan --help untuk daftar argumen)`);
    }
  }

  return opts;
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  Mulai sebagai user : npm run user [-- --connect <nama|PeerID> | --port <n> | --home <dir>]');
  console.log('                       (masuk memakai profil AKTIF; lihat: npm run user:switch)');
  console.log('  Tambah user        : npm run user:add [-- --name <nama> --discovery <url> [--pod <url> | --no-pod]]');
  console.log('  Ganti user aktif   : npm run user:switch [-- <nama|nomor> | --home <dir>]');
  console.log('  Solid Login        : npm run pod:login [-- --issuer https://solidcommunity.net [--browser | --email <e> --password <p>]]');
  console.log('                       (login & kredensial ditautkan ke profil AKTIF)');
  console.log('  Solid Link         : npm run pod:link [-- --home <dir> --pod <url>]');
  console.log('  Web UI (utama)     : npm run user:web [-- --home <dir> --port 5000 --ui-port 3333 --ui-host 127.0.0.1 --public-host <ip/domain>]');
  console.log('  Tunggu koneksi     : npm run user -- [--listen] [--port 5000] [--pod <pod-url>] [--discovery <url>] [--home <dir>] [--name <nama>]');
  console.log('  Jaringan publik    : tambahkan --public-host <ip/domain> --public-port <port> [--discovery-token <token>]');
  console.log('  Hubungi user       : npm run user:connect -- <nama|PeerID> [--peer-ip <ip> --peer-port <n>]');
  console.log('  User online        : npm run user:list [--discovery <url>]');
  console.log('  User di device     : npm run user:profiles | user:edit | user:remove');
  console.log('                   contoh: user:edit -- --home <path> --name <baru> --pod <url> | --no-pod');
  console.log('                           user:remove -- --home <path> [--yes]');
  console.log('  Di sesi chat   : /connect <nama|PeerID> · /connect <IP> <PeerID> · /list · /help · /quit');
}

function validatePort(port: number, label: string): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} tidak valid (1-65535): ${port}`);
  }
}

/** Resolve home profil: --home eksplisit → P2POD_HOME → profil aktif → ~/.p2pod. */
function resolvedHome(opts: CliOptions, requireConfig = false): string {
  return resolveProfileHome({
    explicitHome: opts.homeExplicit ? opts.homeDir : undefined,
    requireConfig,
  });
}

/** Tentukan home untuk user BARU (perintah `add`): --home, atau .p2pod/<nama> unik. */
async function resolveAddTarget(opts: CliOptions): Promise<{ homeDir: string; displayName?: string }> {
  if (opts.homeExplicit) {
    return { homeDir: opts.homeDir, displayName: opts.displayName };
  }

  let name = (opts.displayName ?? '').trim();
  if (name.length === 0) {
    if (!process.stdin.isTTY) {
      throw new Error('Nama user wajib: tambahkan --name <nama> (atau --home <dir>).');
    }
    const prompter = createPrompter();
    try {
      while (name.length === 0) {
        name = (await prompter.ask('Nama user baru (wajib, tampil di daftar user): ')).trim();
        if (name.length === 0) console.log('  Nama tidak boleh kosong.');
      }
    } finally {
      prompter.close();
    }
  }

  const base = profileRoot();
  const slug = podNameFromDisplayName(name);
  let candidate = path.join(base, slug);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(base, `${slug}-${suffix}`);
    suffix++;
  }
  return { homeDir: candidate, displayName: name };
}

function resolvePodUrl(opts: CliOptions, config: UserConfig | null, displayName: string): string | undefined {
  if (opts.podDisabled) return undefined;
  if (opts.podUrl) return opts.podUrl;
  if (config?.pod?.enabled) {
    return config.pod.podUrl ?? `http://localhost:${config.pod.cssPort ?? 3000}/${displayName}/`;
  }
  return undefined;
}

async function runList(discoveryUrl: string): Promise<void> {
  const discovery = new DiscoveryClient(discoveryUrl);
  let peers;
  try {
    peers = await discovery.listPeers();
  } catch (err: any) {
    throw new Error(`tidak bisa menjangkau Discovery Platform (${discoveryUrl}): ${err.message}`);
  }

  if (peers.length === 0) {
    console.log(`Tidak ada user online di ${discoveryUrl}.`);
    return;
  }

  console.log(`User online di ${discoveryUrl} (${peers.length}):`);
  for (const peer of peers) {
    const name = (peer.displayName ?? '(tanpa nama)').padEnd(16);
    const webIdInfo = peer.webId ? `  [${peer.webId}]` : '';
    const endpointInfo = peer.publicEndpoint ? `  @${peer.publicEndpoint}` : '';
    console.log(`  ${name} ${fingerprintOf(peer.peerId)}  ${peer.peerId}${endpointInfo}${webIdInfo}`);
  }
  console.log('');
  console.log('Hubungi salah satu dengan: npm run user:connect -- <nama|PeerID>');
}

interface StartParams {
  identity: Identity;
  homeDir: string;
  discoveryUrl: string;
  listenPort: number;
  podUrl?: string;
  publicHost?: string;
  publicPort?: number;
  discoveryToken?: string;
  targetPeerId?: string;
  targetIp?: string;
  targetPort?: number;
}

async function startApp(params: StartParams): Promise<void> {
  if (params.podUrl) {
    const cssPort = localCssPortOf(params.podUrl);
    if (cssPort) {
      const name = podNameFromDisplayName(params.identity.displayName);
      await ensureLocalCssRunning({ cssPort, name }).catch(() => undefined);
    }
  }

  const localIp = await detectLocalIp(params.discoveryUrl);
  const storedConfig = loadConfig(params.homeDir);

  console.log('');
  console.log(`[P2Pod] nama        : ${params.identity.displayName}`);
  console.log(`[P2Pod] Peer ID     : ${params.identity.peerId}`);
  console.log(`[P2Pod] fingerprint : ${params.identity.fingerprint}`);
  console.log(`[P2Pod] IP LAN      : ${localIp || '(tidak terdeteksi)'}`);
  console.log(`[P2Pod] home        : ${params.homeDir}`);
  console.log(`[P2Pod] discovery   : ${params.discoveryUrl}`);
  console.log(
    '[P2Pod] PENTING     : semua peer harus memakai URL discovery yang SAMA agar bisa saling menemukan.'
  );
  console.log(`[P2Pod] port TCP    : ${params.listenPort}`);
  console.log(
    `[P2Pod] endpoint    : ${
      params.publicHost
        ? `${params.publicHost}:${params.publicPort ?? params.listenPort} (publik dikonfigurasi)`
        : 'otomatis via IP yang diamati Discovery (atur --public-host untuk Docker/NAT)'
    }`
  );
  console.log(`[P2Pod] pod         : ${params.podUrl ?? '(nonaktif — history tidak disimpan)'}`);
  if (params.podUrl && storedConfig?.pod?.webId) {
    console.log(`[P2Pod] WebID       : ${storedConfig.pod.webId}`);
  }
  console.log(
    `[P2Pod] mode        : ${
      params.targetPeerId
        ? `menghubungi ${fingerprintOf(params.targetPeerId)}${
            params.targetIp ? ` (direct ${params.targetIp}:${params.targetPort ?? 5000})` : ''
          }`
        : 'listen (tunggu koneksi masuk)'
    }`
  );
  console.log('');
  console.log(
    `[P2Pod] Bagikan ke user lain → nama: ${params.identity.displayName} · endpoint: ${
      params.publicHost
        ? `${params.publicHost}:${params.publicPort ?? params.listenPort}`
        : `${localIp || '(?)'}:${params.listenPort}`
    } · Peer ID: ${params.identity.peerId}`
  );
  console.log('[P2Pod] Hubungi user lain → /connect <nama|PeerID>  atau  npm run user:connect -- <nama|PeerID>');
  console.log('');

  const app = new PeerApp({
    identity: params.identity,
    homeDir: params.homeDir,
    discoveryUrl: params.discoveryUrl,
    podUrl: params.podUrl,
    listenPort: params.listenPort,
    publicHost: params.publicHost,
    publicPort: params.publicPort,
    discoveryToken: params.discoveryToken,
    targetPeerId: params.targetPeerId,
    targetIp: params.targetIp,
    targetPort: params.targetPort,
  });

  await app.start();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (opts.publicPort !== undefined) {
    validatePort(opts.publicPort, 'Port publik');
  }
  if (opts.publicHost && !isValidHost(opts.publicHost)) {
    throw new Error(`--public-host tidak valid: ${opts.publicHost}`);
  }

  if (opts.command === 'list') {
    const homeDir = resolvedHome(opts);
    const discoveryUrl = opts.discoveryUrl ?? loadConfig(homeDir)?.discoveryUrl ?? 'http://localhost:4000';
    await runList(discoveryUrl);
    return;
  }

  if (opts.command === 'profiles') {
    runProfiles(opts.homeExplicit ? opts.homeDir : undefined);
    return;
  }

  if (opts.command === 'edit') {
    await runEdit({
      homeDir: opts.homeExplicit ? opts.homeDir : undefined,
      name: opts.displayName,
      discoveryUrl: opts.discoveryUrl,
      listenPort: opts.port,
      podUrl: opts.podUrl,
      podDisabled: opts.podDisabled,
      publicHost: opts.publicHost,
      publicPort: opts.publicPort,
      discoveryToken: opts.discoveryToken,
    });
    return;
  }

  if (opts.command === 'remove') {
    await runRemove({
      homeDir: opts.homeExplicit ? opts.homeDir : undefined,
      yes: opts.yes,
    });
    return;
  }

  if (opts.command === 'switch') {
    await runSwitch({
      homeDir: opts.homeExplicit ? opts.homeDir : undefined,
      target: opts.switchTarget,
    });
    return;
  }

  if (opts.command === 'pod-login') {
    await runPodLogin({
      homeDir: resolvedHome(opts, true),
      displayName: opts.displayName,
      issuerUrl: opts.issuerUrl,
      email: opts.email,
      password: opts.password,
      podUrl: opts.podUrl,
      useBrowser: opts.useBrowser,
    });
    return;
  }

  if (opts.command === 'pod-link') {
    await runPodLink({
      homeDir: resolvedHome(opts, true),
      podUrl: opts.podUrl,
      displayName: opts.displayName,
    });
    return;
  }

  if (opts.command === 'add') {
    const { homeDir, displayName } = await resolveAddTarget(opts);
    const { identity, config } = await runWizard({
      homeDir,
      displayName,
      discoveryUrl: opts.discoveryUrl,
      listenPort: opts.port,
      podUrl: opts.podUrl,
      podDisabled: opts.podDisabled,
      publicHost: opts.publicHost,
      publicPort: opts.publicPort,
      discoveryToken: opts.discoveryToken,
      reconfigure: false,
    });
    setActiveProfile(homeDir, identity.displayName);
    console.log('');
    console.log(`[P2Pod] Profil aktif → ${identity.displayName} (${homeDir})`);
    await startApp({
      identity,
      homeDir,
      discoveryUrl: config.discoveryUrl,
      listenPort: config.listenPort,
      podUrl: config.pod.enabled ? config.pod.podUrl : undefined,
      publicHost: config.network?.publicHost,
      publicPort: config.network?.publicPort,
      discoveryToken: config.network?.discoveryToken,
    });
    return;
  }

  if (opts.command === 'init') {
    const homeDir = resolvedHome(opts);
    const { identity, config } = await runWizard({
      homeDir,
      displayName: opts.displayName,
      discoveryUrl: opts.discoveryUrl,
      listenPort: opts.port,
      podUrl: opts.podUrl,
      podDisabled: opts.podDisabled,
      publicHost: opts.publicHost,
      publicPort: opts.publicPort,
      discoveryToken: opts.discoveryToken,
      reconfigure: opts.reconfigure,
    });
    setActiveProfile(homeDir, identity.displayName);
    await startApp({
      identity,
      homeDir,
      discoveryUrl: config.discoveryUrl,
      listenPort: config.listenPort,
      podUrl: config.pod.enabled ? config.pod.podUrl : undefined,
      publicHost: config.network?.publicHost,
      publicPort: config.network?.publicPort,
      discoveryToken: config.network?.discoveryToken,
    });
    return;
  }

  if (opts.command === 'web') {
    const homeDir = resolvedHome(opts);
    if (opts.uiPort !== undefined) {
      validatePort(opts.uiPort, 'Port Web UI');
    }
    if (opts.port !== undefined) {
      validatePort(opts.port, 'Port TCP');
    }
    if (opts.publicPort !== undefined) {
      validatePort(opts.publicPort, 'Port publik');
    }

    const staticCandidate = path.join(process.cwd(), 'packages', 'web-ui', 'dist');
    const hasStaticBuild = fs.existsSync(path.join(staticCandidate, 'index.html'));

    const bridge = new WebBridge({
      homeDir,
      displayName: opts.displayName,
      discoveryUrl: opts.discoveryUrl,
      listenPort: opts.port,
      podUrl: opts.podUrl,
      podDisabled: opts.podDisabled,
      publicHost: opts.publicHost,
      publicPort: opts.publicPort,
      discoveryToken: opts.discoveryToken,
      uiPort: opts.uiPort,
      uiHost: opts.uiHost,
      staticDir: hasStaticBuild ? staticCandidate : undefined,
    });

    const { url, state, needsSetup } = await bridge.start();
    console.log('');
    if (state) {
      console.log(`[P2Pod Web] User        : ${state.local.displayName} [${state.local.fingerprint}]`);
      console.log(`[P2Pod Web] Home        : ${state.local.homeDir}`);
      console.log(`[P2Pod Web] Discovery   : ${state.local.discoveryUrl}`);
      console.log(
        '[P2Pod Web] Catatan     : semua peer harus memakai URL discovery yang SAMA agar saling menemukan.'
      );
      console.log(`[P2Pod Web] TCP Listen  : port ${state.local.boundPort}`);
      console.log(
        `[P2Pod Web] Public      : ${state.local.publicEndpoint ?? '(otomatis via Discovery / atur di UI Network)'}`
      );
      console.log(`[P2Pod Web] Solid Pod   : ${state.pod.enabled ? state.pod.podUrl : '(nonaktif)'}`);
    } else {
      console.log(`[P2Pod Web] Home        : ${homeDir}`);
      console.log('[P2Pod Web] User        : belum ada profil — buka browser untuk setup pertama kali.');
    }
    if (needsSetup) {
      console.log('[P2Pod Web] Setup mode  : buat profil pertama melalui Web UI.');
    }
    console.log(`[P2Pod Web] Bridge URL  : ${url} (UI lokal)`);
    console.log(`[P2Pod Web] WebSocket   : ws://127.0.0.1:${bridge.uiPort}/ws`);
    if (hasStaticBuild) {
      console.log(`[P2Pod Web] Frontend    : disajikan langsung di ${url}`);
      if (!opts.noOpen) {
        openBrowser(url);
      }
    } else {
      console.log('[P2Pod Web] Mode API    : frontend statis belum di-build; jalankan dev server Web UI.');
    }
    console.log('[P2Pod Web] Tekan Ctrl+C untuk menghentikan daemon.');
    console.log('');

    let stopping = false;
    const handleExit = (reason: string): void => {
      if (stopping) return;
      stopping = true;
      console.log(`[P2Pod Web] ${reason}`);
      bridge
        .stop(reason)
        .catch(() => undefined)
        .finally(() => {
          const forceExit = setTimeout(() => process.exit(0), 1000);
          forceExit.unref();
        });
    };

    process.on('SIGINT', () => handleExit('Keluar (Ctrl+C)...'));
    process.on('SIGTERM', () => handleExit('Keluar (SIGTERM)...'));

    await new Promise<void>(() => {
      // tetap hidup sampai sinyal SIGINT/SIGTERM
    });
    return;
  }

  if (opts.command === 'run') {
    const homeDir = resolvedHome(opts, true);
    const config = loadConfig(homeDir);
    if (!config) {
      throw new Error(
        `Profil di ${homeDir} belum selesai setup. Buat profil: npm run user:add (atau buka Web UI).`
      );
    }
    const identity = Identity.loadOrCreate(homeDir, opts.displayName ?? config.displayName);
    // Environment overrides win over the saved profile (see webBridge.ts).
    const envDiscoveryUrl = process.env.P2P_DISCOVERY_URL?.trim() || undefined;
    const envListenPort = Number(process.env.P2P_LISTEN_PORT ?? '');
    const envPublicHost = normalizePublicHost(process.env.P2P_PUBLIC_HOST);
    const envPublicPort = Number(process.env.P2P_PUBLIC_PORT ?? '');
    const envDiscoveryToken = process.env.P2P_DISCOVERY_TOKEN?.trim() || undefined;
    const discoveryUrl = opts.discoveryUrl ?? envDiscoveryUrl ?? config.discoveryUrl;
    const listenPort =
      opts.port ??
      (Number.isInteger(envListenPort) && envListenPort > 0 ? envListenPort : undefined) ??
      config.listenPort;
    validatePort(listenPort, 'Port TCP');
    const podUrl = resolvePodUrl(opts, config, identity.displayName);
    await startApp({
      identity,
      homeDir,
      discoveryUrl,
      listenPort,
      podUrl,
      publicHost: opts.publicHost ?? envPublicHost ?? normalizePublicHost(config.network?.publicHost),
      publicPort:
        opts.publicPort ??
        (Number.isInteger(envPublicPort) && envPublicPort > 0 ? envPublicPort : undefined) ??
        config.network?.publicPort,
      discoveryToken: opts.discoveryToken ?? envDiscoveryToken ?? config.network?.discoveryToken,
    });
    return;
  }

  if (opts.command === 'none') {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const homeDir = resolvedHome(opts);
  const config = loadConfig(homeDir);
  ensureDir(homeDir);
  const displayName = opts.displayName ?? config?.displayName;
  const identity = Identity.loadOrCreate(homeDir, displayName);
  const discoveryUrl = opts.discoveryUrl ?? config?.discoveryUrl ?? 'http://localhost:4000';
  const listenPort = opts.port ?? config?.listenPort ?? 5000;
  validatePort(listenPort, 'Port TCP');
  const podUrl = resolvePodUrl(opts, config, identity.displayName);

  if (opts.command === 'connect') {
    if (!opts.connectTarget) {
      throw new Error('Perintah connect membutuhkan target: connect <nama|PeerID> (atau --connect <target>).');
    }
    if (opts.peerIp && !isValidHost(opts.peerIp)) {
      throw new Error(`--peer-ip tidak valid: ${opts.peerIp}`);
    }
    const resolved = await resolveTarget(opts.connectTarget, discoveryUrl);
    if (resolved.via === 'name') {
      console.log(`[P2Pod] target      : "${resolved.displayName}" (fingerprint ${fingerprintOf(resolved.peerId)})`);
    }
    await startApp({
      identity,
      homeDir,
      discoveryUrl,
      listenPort,
      podUrl,
      publicHost: opts.publicHost ?? config?.network?.publicHost,
      publicPort: opts.publicPort ?? config?.network?.publicPort,
      discoveryToken: opts.discoveryToken ?? config?.network?.discoveryToken,
      targetPeerId: resolved.peerId,
      targetIp: opts.peerIp,
      targetPort: opts.peerPort,
    });
    return;
  }

  // listen
  await startApp({
    identity,
    homeDir,
    discoveryUrl,
    listenPort,
    podUrl,
    publicHost: opts.publicHost ?? config?.network?.publicHost,
    publicPort: opts.publicPort ?? config?.network?.publicPort,
    discoveryToken: opts.discoveryToken ?? config?.network?.discoveryToken,
  });
}

main()
  .catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Fallback exit bila ada handle (undici/readline) yang menahan event loop.
    const t = setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
    t.unref();
  });
