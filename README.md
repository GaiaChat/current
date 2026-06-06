# Current

Current is a local-first, Discord-style chat platform with browser + Electron clients, self-hosted community data, and ATProto OAuth identity.

## Highlights

- Local server ownership for chat, media, and voice metadata
- Browser-side encryption for new web-client text message bodies with a shared key available to authenticated users
- atproto OAuth-only authentication flow
- Text channels, DMs, reactions, attachments, GIF search (Tenor)
- Voice channel signaling and state (WebRTC SFU-ready config surface)
- Strong moderation baseline: roles, automod rules, invite controls, moderation actions, audit logs
- Setup wizard and admin studio UI
- Cross-platform Node `.mjs` install/run/update launchers, plus Linux `systemd` hosting scripts

## Monorepo Structure

- `apps/server`: Fastify API, gateway, voice signaling, services, repositories
- `apps/web`: React/Vite app for setup, chat, voice, and admin controls
- `apps/desktop`: Electron shell wrapping the shared web UI
- `packages/types`: domain types shared across apps
- `packages/protocol`: typed gateway event contracts
- `packages/config`: versioned config schema + migration helpers
- `packages/ui`: reusable UI primitives
- `tests`: unit/integration/realtime/voice/load test suites

## Modularity Principles

- Transport adapters (`api`, `realtime`) only orchestrate request/response/event flow
- Domain services (`services`, `setup`, `voice`, `auth`) hold business logic
- Repositories isolate all SQL and persistence concerns
- Shared contracts live in workspace packages and are imported by all apps

## Quick Start

Install Node.js 24 or newer first. Current uses the built-in `node:sqlite`
runtime module, so Node 20/22 will install some dependencies but cannot run the
server. The setup scripts run the pinned project package manager,
`pnpm@11.3.0`, through an exact local pnpm, Corepack, or `npx` when needed. The
root `.mjs` launchers are the same on Windows, macOS, and Linux:

1. `Install Current.mjs`
2. `Run Current.mjs`

Terminal equivalent:

```bash
node "Install Current.mjs"
node "Run Current.mjs"
```

Some desktops open `.mjs` files in an editor instead of executing them; running them with `node` is the reliable path everywhere.

The run launcher asks how to start, checks first-time setup, installs dependencies only when `node_modules` is missing or dependencies changed, starts the server in a terminal, and keeps the terminal attached so you can stop it with `Ctrl+C`.
It will ask which server instance to run:

- Standard: the normal Current server using `apps/server/config/current.config.json`
- LAN: a separate LAN-only instance using `apps/server/config/current-lan.config.json`, `apps/server/data/lan/`, `apps/server/uploads/lan/`, and port `8081`

It will ask for a launch mode:

- Normal: builds once, then runs the server without source watchers
- Dev: builds/watches the web GUI and restarts the server on source changes

If the configured port is already in use, the launcher will stop before building and offer to open the existing server, stop the process using that port, start this session on a different port, retry, or exit.

Open `http://127.0.0.1:6414` for the standard instance, or `http://127.0.0.1:8081` for the LAN instance.

Manual equivalent:

```bash
pnpm run setup
pnpm launch:server:normal
# or
pnpm launch:server:dev
# or
pnpm launch:server:lan:normal
```

To use a different port for one launch, pass `--port` or set `CURRENT_PORT`:

```bash
pnpm launch:server:normal -- --port 7000
pnpm dev -- --port 7000
CURRENT_PORT=7000 node "Run Current.mjs"
```

For a noninteractive cloud launch, pass the public origin and any listen
overrides as flags or environment variables:

```bash
CURRENT_PUBLIC_URL=https://chat.example.com \
CURRENT_HOST=0.0.0.0 \
CURRENT_RTC_ANNOUNCED_IP=203.0.113.10 \
node "Run Current.mjs" --no-pause --mode=normal --instance=standard
```

`CURRENT_PUBLIC_URL` also derives the default ATProto OAuth callback URL. For an
HTTPS domain, Current publishes discoverable OAuth metadata at
`/api/v1/auth/client-metadata.json`.

For internet hosting, forward TCP `6414` to the machine running the standard server unless you changed `server.port`. Voice also uses the configured UDP range, `40000-40100` by default. The LAN instance uses TCP `8081` by default.

The server dev launcher builds and watches the web GUI, then serves it from the API server.
For API-only development, run `pnpm --filter @current/server dev:api` and start the Vite client separately with `pnpm --filter @current/web dev`.
For the old workspace-wide dev watchers, run `pnpm dev:workspace`.

Text messages are encrypted in the browser before they are sent. Authenticated clients automatically claim or fetch the shared room key so messages stay readable across browsers.

If ATProto OAuth is not configured yet, use `Local Dev Sign-In` on the auth screen.
This is controlled by `auth.allowDevLogin` in server config (enabled by default for local testing).

## Desktop App

```bash
pnpm --filter @current/desktop build
pnpm --filter @current/desktop start
```

For dev mode (web + electron):

```bash
pnpm --filter @current/desktop dev
```

## Config

Server config is loaded from:

- `CURRENT_CONFIG_PATH` env var, or
- `config/current.config.json`

On first run, a default config file is generated automatically.
For a persistent port change, edit `server.port` and the **Server address**
stored as `server.publicUrl`. Current generates the OAuth redirect URL from
that Server address unless you set a custom OAuth redirect URI.

OAuth defaults to atproto loopback mode (no custom `atprotoClientId` required).
Use a `127.0.0.1` callback URL for local testing.

## Headless / Cloud Setup

On a headless server, start Current in normal mode, then run the bootstrap helper
from the same machine or over SSH:

```bash
# SSH session 1: keep the server running.
CURRENT_PUBLIC_URL=https://chat.example.com node "Run Current.mjs" --no-pause --mode=normal

# SSH session 2: complete first-run setup through the local API.
node bootstrap-current-server.mjs \
  --public-url https://chat.example.com \
  --server-name "Current Cloud" \
  --registration-mode invite_only
```

The helper calls the local setup API, so remote browsers still cannot take over
first-run setup unauthenticated. After bootstrap, generate an owner code in the
SSH session and enter it in the browser:

```bash
node bootstrap-current-server.mjs --owner-code
```

Open the Server address, sign in, and enter the code to claim owner/admin. The
code is printed only in the server terminal, expires after 15 minutes, and is
rotated by restarting the server or generating a new code.

For AWS-style hosting, allow inbound TCP for the HTTP/HTTPS port you expose and
allow the configured UDP voice range if you use voice. Put `CURRENT_PUBLIC_URL`
behind your load balancer or reverse proxy URL, and set
`CURRENT_RTC_ANNOUNCED_IP` to the public address clients should use for voice.
Current respects `X-Forwarded-Proto` and `X-Forwarded-Host`, so ALB, Cloudflare,
Caddy, and nginx HTTPS termination can keep Current running HTTP on the instance
while browsers use HTTPS outside.

### HTTPS

The easiest cloud setup is usually a reverse proxy or load balancer that handles
HTTPS and forwards to Current over HTTP. Set the first-run **Server address** to
the external `https://` URL.

If you want Current to serve HTTPS directly, use Server Settings -> System ->
Network & TLS, choose **Let's Encrypt**, enter an ACME email and domain, then
issue a certificate. Current serves the HTTP-01 challenge at
`/.well-known/acme-challenge/*`, writes the certificate and key paths into the
TLS config, and reports that a restart is required before direct HTTPS is live.

## Linux Native Install (`systemd`)

```bash
sudo node install-current.mjs \
  --public-url https://chat.example.com \
  --host 0.0.0.0 \
  --port 6414 \
  --rtc-announced-ip 203.0.113.10
```

This installs runtime dependencies with a symlink-safe layout, writes
`/etc/current/current.config.json`, writes
`/etc/systemd/system/current.service`, and starts the service. The service runs
the built server directly with Node, so it does not need a global `pnpm` after
installation.
After the service starts, run `node /opt/current/current/bootstrap-current-server.mjs --public-url https://chat.example.com` on the host if you want to complete first-run setup without opening the setup UI locally.

## Server Release Updates

```bash
pnpm release:server
```

This writes a runtime-focused `release-server/current-server-v<version>.tar.gz` and
`release-server/current-server-latest.json` for the
`GaiaChat/current` GitHub Releases update channel.

```bash
sudo pnpm update:server
# or
sudo node "Update Current.mjs"
```

This downloads the latest server release, verifies its SHA-256, backs up config
and SQLite, stages the new app under `/opt/current/versions`, and restarts the
systemd service without overwriting messages, settings, uploads, or backups.
When run from an extracted portable bundle such as
`current-server-v0.3.5`, `Update Current.mjs` stages releases next to that bundle
instead. If the drive cannot create symlinks, it keeps a real `current`
directory there so the root launchers start the active version.
See [docs/SERVER_UPDATES.md](docs/SERVER_UPDATES.md) for the rollout/apply
design.

## Tests

```bash
pnpm test
```

## Reliability Roadmap

- v1 GA target: stable for up to 500 concurrent users
- hardening milestone target: validated up to 2,000 concurrent users with expanded load/soak gates
