# Current

Current is a local-first, Discord-style chat platform with browser + Electron clients, self-hosted community data, and Bluesky atproto OAuth identity.

## Highlights

- Local server ownership for chat, media, and voice metadata
- atproto OAuth-only authentication flow
- Text channels, DMs, reactions, attachments, GIF search (Tenor)
- Voice channel signaling and state (WebRTC SFU-ready config surface)
- Strong moderation baseline: roles, automod rules, invite controls, moderation actions, audit logs
- Setup wizard and admin studio UI
- Linux-first native hosting with `systemd` installer script

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

```bash
pnpm install
pnpm --filter @current/server dev
pnpm --filter @current/web dev
```

Open `http://127.0.0.1:5173`.

If Bluesky OAuth is not configured yet, use `Local Dev Sign-In` on the auth screen.
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

OAuth defaults to atproto loopback mode (no custom `atprotoClientId` required).
Use a `127.0.0.1` callback URL for local testing.

## Linux Native Install (`systemd`)

```bash
sudo ./scripts/install-current.sh
```

This installs dependencies, builds server packages, writes `/etc/systemd/system/current.service`, and starts the service.

## Tests

```bash
pnpm test
```

## Reliability Roadmap

- v1 GA target: stable for up to 500 concurrent users
- hardening milestone target: validated up to 2,000 concurrent users with expanded load/soak gates
