# P2Pod

P2Pod is a decentralized peer-to-peer chat application. Messages travel directly between peers over encrypted TCP; a lightweight **Discovery Platform** only maps a Peer ID to a reachable host/port. Conversation history stays local and can optionally be backed up to a Solid Pod.

The **web UI is the primary interface**. The CLI remains available for hosting the Discovery Platform and for advanced/headless operation. See [CLI.md](CLI.md) for every command.

## Roles

| Role | What it does |
|---|---|
| **Discovery Platform** | Stateless Express service that maps `Peer ID -> host:port`. Never stores messages. |
| **P2Pod app** | Serves the local web UI, runs the P2P node, encrypts chat with ECDH + AES-256-GCM, and stores history locally. |
| **Solid Pod (optional)** | Solid-compatible storage for JSON-LD chat archives and WebID identity linking. |

The web UI binds to `127.0.0.1` only. Peers connect to the app's TCP port, not to the UI.

## Quick start with Docker

1. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env`:

   - `PUBLIC_HOST` — the address other peers should dial: the Docker host's LAN IP for same-network chat, or a public IP/DNS name for cross-network chat.
   - `P2P_PORT` — the TCP port exposed by your router (usually `5000`).
   - `DISCOVERY_URL` — keep `http://discovery:4000` when using the included discovery service.
   - `DISCOVERY_TOKEN` — optional shared secret for a public discovery server.

3. Build and start:

   ```bash
   docker compose up -d --build
   ```

4. Open the UI:

   ```text
   http://127.0.0.1:3333
   ```

5. Complete the first-run wizard in the browser: name, discovery URL, TCP port, public host/port, optional Solid Pod.

If ports `3333` / `4000` / `5000` are already used by a local dev process, change `UI_PORT`, `DISCOVERY_PORT`, or `P2P_PORT` in `.env` before starting, or stop the old process.

Check status:

```bash
docker compose ps
docker compose logs -f app
docker compose logs -f discovery
```

Stop:

```bash
docker compose down
```

Chat history, profiles, and optional local Pod data live in the `p2pod-data` volume.

## Quick start without Docker

Requirements: Node.js 18+ and npm.

```bash
npm install
npm run build:web
```

Start the Discovery Platform in one terminal:

```bash
npm run discovery
```

Start the app in another terminal:

```bash
npm run user:web
```

Open `http://127.0.0.1:3333` and create your profile in the UI.

## Chatting across different networks

Direct TCP chat needs an inbound path to the peer's TCP listener. Public IP alone is not enough — the port must also be reachable.

For a typical home setup:

1. Host the Discovery Platform on a public VPS or forward TCP `4000` to the discovery host.
2. Forward your app's TCP port (`5000` by default) on your router to the machine running the app.
3. In the app's **Network** modal, set:
   - **Public host / IP** — your public IP or DNS name.
   - **Port publik** — the external port (use the same value as the listener unless your router maps a different port).
4. Ask the other peer to do the same.
5. Use **Uji Port Publik** in the Network modal to ask discovery to test inbound reachability.

Firewall examples:

```bash
# Linux (ufw)
sudo ufw allow 4000/tcp
sudo ufw allow 5000/tcp
```

```powershell
# Windows (run as Administrator)
New-NetFirewallRule -DisplayName "P2Pod Discovery 4000" -Direction Inbound -Protocol TCP -LocalPort 4000 -Action Allow
New-NetFirewallRule -DisplayName "P2Pod P2P 5000" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow
```

Notes:

- Both peers should forward the port for reliable two-way connections.
- If only one side is reachable, the unreachable side must initiate the connection.
- **CGNAT** users cannot receive inbound connections without a relay. This version does not include a relay.
- The web UI is intentionally local-only. On a remote Docker host, use an SSH tunnel:

  ```bash
  ssh -L 3333:127.0.0.1:3333 user@your-server
  ```

  Then open `http://127.0.0.1:3333` on your machine.

### Using a separate public discovery server

Run only the discovery service on a public host:

```bash
docker compose up -d discovery
```

On each user's machine, run the app with the public discovery URL:

```bash
P2P_DISCOVERY_URL=https://discovery.example.com npm run user:web
```

If the discovery server is behind a reverse proxy, set `TRUST_PROXY=1` and use HTTPS in `P2P_DISCOVERY_URL`.

## What you can do in the UI

- **First run** — create an Ed25519 identity and profile.
- **Online peers** — see peers registered on the same discovery server.
- **Chat** — connect, send E2EE messages, disconnect, reconnect.
- **Direct connect** — connect by hostname/IP + TCP port + Peer ID without discovery.
- **Offline archive** — read locally stored conversation history while peers are offline.
- **Network settings** — change discovery URL, listener port, public endpoint, and discovery token.
- **Profiles** — create, switch, and delete local identities.
- **Solid Pod** — log in, link the Ed25519 identity to a WebID, and sync archives.
- **Topology/logs** — inspect the local peer graph and system log.

## Storage and security

- Identity keys are generated and stored locally; Peer ID is the Ed25519 public key.
- Session keys use ephemeral ECDH P-256; every chat message uses AES-256-GCM.
- Both peers sign the session transcript, so a man-in-the-middle is detected.
- The Discovery Platform only sees Peer ID, display name, WebID (optional), and endpoint metadata.
- Local chat history is written to disk immediately (local-first, crash-safe).
- Solid Pod sync is optional and disabled if no Pod is configured.
- The UI is served only on loopback. The P2P listener is the only port that needs public exposure.

## CLI

The complete, action-oriented CLI reference is in [CLI.md](CLI.md). This includes:

- discovery setup and options
- app/UI startup
- profile creation and management
- chat and direct-connect fallback commands
- Solid Pod commands
- Docker commands
- all flags and troubleshooting commands

## Project structure

```text
packages/
├── shared/              # protocol + discovery API types
├── discovery-platform/  # discovery server
├── user-client/         # peer daemon, WebBridge, local storage, Solid modules
└── web-ui/              # React + Vite web console
scripts/                 # generic Pod setup/stop and CSS patch
Dockerfile               # multi-target discovery/web images
docker-compose.yml       # public discovery + local UI app
```

## Development checks

```bash
npm run typecheck
npm run build
```

Docker health checks are defined in `docker-compose.yml`.

## License

MIT