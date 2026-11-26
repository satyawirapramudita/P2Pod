# P2Pod CLI Reference

Use the web UI for normal daily actions. The commands below are the advanced/fallback interface and the infrastructure commands needed to host the Discovery Platform.

> npm argument forwarding: when a script needs flags, put `--` between the script name and the flags:
>
> ```bash
> npm run user:add -- --name rina --discovery http://localhost:4000
> ```

## Quick action map

| What you do in the app | CLI command |
|---|---|
| Host Discovery for other users | `npm run discovery` |
| Open the local web UI | `npm run user:web` / `npm start` |
| Create the first profile | `npm run user:add -- --name ... --discovery ...` |
| See peers online | `npm run user:list` |
| Connect and chat | `npm run user` then `/connect ...` |
| Connect directly without Discovery | `npm run user:connect -- <PeerID> --peer-ip <host>` |
| Read/sync chat history | `npm run user` then `/history` / `/sync` |
| Switch, edit, or delete profiles | `npm run user:switch` / `user:edit` / `user:remove` |
| Set the public endpoint | `npm run user:edit -- --public-host ... --public-port ...` |
| Login/link a Solid Pod | `npm run pod:login` / `npm run pod:link` |
| Run infrastructure in Docker | `docker compose up -d --build` |

## 1. Host the Discovery Platform

**If you want to let other people find each other, run the discovery server.**

```bash
npm run discovery
npm run discovery -- 4100
```

Environment options:

```bash
PORT=4000 PUBLIC_HOST=203.0.113.10 npm run discovery
PUBLIC_URL=https://discovery.example.com DISCOVERY_TOKEN=secret npm run discovery
```

| Variable | Meaning |
|---|---|
| `PORT` | Listening port (default `4000`). |
| `PUBLIC_HOST` | Public IP/DNS printed in the startup banner. |
| `PUBLIC_URL` | Full public URL, e.g. `https://discovery.example.com`. |
| `DISCOVERY_TOKEN` | Optional shared secret required for registration. |
| `ALLOW_ADVERTISE` | Set `0` to ignore client-provided public endpoints. |
| `TRUST_PROXY` | Set `1` when running behind a reverse proxy that sets `X-Forwarded-For`. |

Docker:

```bash
docker compose up -d discovery
docker compose logs -f discovery
```

Public access requires TCP `4000` to be reachable (VPS firewall or router port-forward).

## 2. Open the app / web UI

**If you want to start the UI and the local P2P node:**

```bash
npm run user:web
```

Alias:

```bash
npm start
```

Common options:

```bash
npm run user:web -- --home .p2pod/rina --port 5000 --ui-port 3333
npm run user:web -- --no-open
npm run user:web -- --ui-host 127.0.0.1
```

The UI is served at `http://127.0.0.1:<ui-port>` and binds to loopback only. If no complete profile exists yet, the UI opens the first-run setup page.

Docker:

```bash
docker compose up -d app
docker compose logs -f app
```

The Docker UI is published only to `127.0.0.1:3333`. For a remote host, use an SSH tunnel:

```bash
ssh -L 3333:127.0.0.1:3333 user@your-server
```

## 3. Create an identity / profile

**In the app:** first-run setup, or **Profiles → [+ PROFIL BARU]**.

CLI equivalents:

```bash
npm run user:add -- --name rina --discovery http://localhost:4000
npm run user:add -- --name rina --discovery http://localhost:4000 --port 5000 --no-pod
npm run user:add -- --name rina --discovery http://localhost:4000 --public-host 203.0.113.10 --public-port 5000
```

`user:add` creates the profile, marks it active, and starts the node.

Wizard mode with all values prompted:

```bash
npm run user:init
npm run user:init -- --home .p2pod/rina --reconfigure
```

## 4. Find and chat with someone

**In the app:** **Online** tab → select a peer → send messages in the E2EE terminal.

CLI fallback:

```bash
# Enter the active profile's interactive CLI
npm run user

# One-shot online list
npm run user:list
npm run user:list -- --discovery http://203.0.113.10:4000

# One-shot connect by display name or Peer ID
npm run user:connect -- rina
npm run user:connect -- MCowBQYDK2VwAyEA...
```

Inside the interactive CLI session:

```text
/connect <name|PeerID>       connect through Discovery
/connect <host> <PeerID>     direct TCP without Discovery
/list                        show online peers
/sync                        sync the active chat to Solid Pod
/history                     show local history statistics
/help                        show help
/quit                        end the session and finalize history
```

### Direct TCP connection

**In the app:** **Hubungkan Direct Host/IP** in the left panel.

CLI:

```bash
npm run user -- --listen --port 5000
npm run user -- --connect <PeerID> --peer-ip 203.0.113.10 --peer-port 5000
npm run user:connect -- <PeerID> --peer-ip peer.example.com --peer-port 5000
```

Hostnames, IPv4, and IPv6 are accepted.

## 5. Manage local profiles

**In the app:** **Profiles** modal.

CLI:

```bash
npm run user:profiles
npm run user:switch -- rina
npm run user:switch -- --home .p2pod/rina
npm run user:edit -- --home .p2pod/rina --name rina-baru
npm run user:remove -- --home .p2pod/rina
npm run user:remove -- --home .p2pod/rina --yes
```

## 6. Network and public endpoint

**In the app:** **Network** button in the top bar.

CLI equivalents:

```bash
npm run user:edit -- --home .p2pod/rina --public-host 203.0.113.10 --public-port 5000
npm run user:edit -- --home .p2pod/rina --discovery https://discovery.example.com --discovery-token secret
npm run user:web -- --home .p2pod/rina --public-host 203.0.113.10 --public-port 5000
```

Public chat requires the listener port to be reachable from the internet:

- forward TCP `5000` on the router, or
- publish/map the Docker port, and
- allow it in the host firewall.

The app uses the IP observed by discovery by default. Set `--public-host` when discovery sees an internal/container address or when using a DNS name.

## 7. Solid Pod storage

**In the app:** **Solid Pod** button → login/link/sync.

CLI equivalents:

```bash
# Generic account provisioning against a Community Solid Server
npm run setup:pod -- --css http://localhost:3000/ --email rina@example.com --password secret --pod rina --home .p2pod/rina

# Solid-OIDC browser login or direct account login (active profile)
npm run pod:login
npm run pod:login -- --issuer https://solidcommunity.net --browser
npm run pod:login -- --issuer http://localhost:3000/ --email rina@example.com --password secret

# Re-link the Ed25519 identity to the Pod
npm run pod:link
npm run pod:link -- --home .p2pod/rina

# Stop auto-started local Community Solid Servers
npm run pod:stop
npm run pod:stop -- --name rina
```

## 8. All main commands and flags

### npm scripts

| Command | Purpose |
|---|---|
| `npm run discovery` | Start Discovery Platform. |
| `npm run user:web` / `npm start` | Start local web UI + P2P node. |
| `npm run user` | Interactive CLI fallback (active profile). |
| `npm run user:init` | Interactive profile wizard. |
| `npm run user:add` | Create a profile and start. |
| `npm run user:switch` | Make a profile active. |
| `npm run user:list` | List online peers. |
| `npm run user:connect` | Connect to a peer once. |
| `npm run user:profiles` | List local profiles. |
| `npm run user:edit` | Edit profile/network settings. |
| `npm run user:remove` | Delete a local profile. |
| `npm run pod:login` | Solid login + WebID link. |
| `npm run pod:link` | Re-link identity to the Pod. |
| `npm run pod:stop` | Stop auto-started local CSS. |
| `npm run setup:pod` | Provision a CSS Pod account. |
| `npm run build` | Build shared types, server, client, and web UI. |
| `npm run typecheck` | Type-check root and web UI. |
| `npm run dev:web` | Vite dev server for the frontend. |
| `npm run patch:css` | Apply the Community Solid Server path patch. |

### Shared flags

| Flag | Meaning |
|---|---|
| `--home <dir>` | Profile directory. |
| `--name <name>` | Display name. |
| `--discovery <url>` | Discovery Platform URL. |
| `--discovery-token <token>` | Shared discovery token. |
| `--port <n>` | Local TCP listener port. |
| `--public-host <host>` | Public IP/DNS advertised to peers. |
| `--public-port <n>` | External TCP port. |
| `--ui-port <n>` | Local UI port. |
| `--ui-host <host>` | UI bind address; keep loopback unless Docker. |
| `--no-open` | Do not open the browser automatically. |
| `--pod <url>` | Enable a Solid Pod URL. |
| `--no-pod` | Disable Solid Pod storage. |
| `--peer-ip <host>` | Direct-connect target host/IP. |
| `--peer-port <n>` | Direct-connect target port. |
| `--reconfigure` | Re-run wizard questions. |
| `--yes` | Skip profile deletion confirmation. |
| `--issuer <url>` / `--css <url>` | Solid issuer/provider URL. |
| `--email <email>` / `--password <pass>` | Solid account credentials. |
| `--browser` | Use Solid-OIDC browser login. |
| `--help` | Show usage. |

### Internal positional commands

These are normally invoked through the npm scripts above:

```text
run
web
add
switch
init
listen
connect
list
profiles
edit
remove
pod-login
pod-link
```

## 9. Docker commands

```bash
docker compose build
docker compose up -d --build
docker compose ps
docker compose logs -f app
docker compose logs -f discovery
docker compose restart app
docker compose down
```

Run only the public discovery service:

```bash
docker compose up -d discovery
```

Run only the app while using an external discovery server:

```bash
P2P_DISCOVERY_URL=https://discovery.example.com docker compose up -d app --no-deps
```

PowerShell:

```powershell
$env:P2P_DISCOVERY_URL='https://discovery.example.com'; docker compose up -d app --no-deps
```

## 10. Troubleshooting

| Problem | Check |
|---|---|
| Discovery unreachable | Server running, URL/port correct, TCP `4000` open. |
| Peers list empty | Everyone must use the same discovery URL. |
| Public peer cannot be reached | Forward the P2P port, set public host/port, and run **Uji Port Publik**. |
| Both peers behind NAT | Each peer needs its own inbound forwarding for reliable connections. CGNAT requires a relay (not included). |
| UI cannot be reached from another machine | Expected: UI is loopback-only. Use an SSH tunnel. |
| Docker app cannot talk to discovery | Use `http://discovery:4000` inside Compose, or set `P2P_DISCOVERY_URL` to the public URL. |
| Pod sync fails | Pod URL/auth valid and Pod reachable; local history remains safe. |
| Port already in use | Change `--port`/`--ui-port` or stop the old process. |