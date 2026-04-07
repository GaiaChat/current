# Current API (v1)

Base path: `/api/v1`

## Setup

- `GET /setup/status`
- `POST /setup/bootstrap`

## Auth

- `GET /auth/oauth/start?handle=you.bsky.social&returnTo=http://localhost:5173`
- `GET /auth/oauth/callback?...` (processes OAuth response and sets `current_session` cookie)
- `GET /auth/client-metadata.json` (discoverable OAuth metadata when `server.publicUrl` is HTTPS domain)
- `GET /auth/lan/handoffs/:handoffId/start` (host-machine OAuth step for LAN loopback mode)
- `GET /auth/lan/handoffs/:handoffId/complete` (host callback completion page for LAN handoff)
- `GET /auth/lan/handoffs/:handoffId` (handoff status polling endpoint)
- `POST /auth/lan/handoffs/:handoffId/claim` (claims handoff auth ticket for session exchange)
- `POST /auth/exchange` (one-time auth ticket exchange for cross-host local dev redirects)
- `POST /auth/dev-login` (local testing, gated by `auth.allowDevLogin`)
- `GET /auth/session`
- `POST /auth/logout`

## Server

- `GET /server`
- `PATCH /server/registration-mode`
- `GET /members`
- `GET /admin/settings` (includes `auth.lanRedirectBaseUrl` for LAN OAuth handoff links)
- `PATCH /admin/settings` (supports `lanRedirectBaseUrl`)
- `POST /admin/ownership/transfer`
- `GET /admin/moderation/logs`
- `GET /admin/shared-ips`

## Chat + Media

- `GET /channels`
- `POST /channels`
- `PATCH /channels/:channelId`
- `DELETE /channels/:channelId`
- `GET /channels/:channelId/messages`
- `POST /channels/:channelId/messages`
- `PATCH /messages/:messageId`
- `DELETE /messages/:messageId`
- `POST /messages/:messageId/reactions`
- `POST /media/attachments`
- `GET /media/attachments/:attachmentId`
- `GET /media/gifs/search?q=...`

## Moderation

- `GET /roles`
- `POST /roles`
- `PATCH /roles/:roleId`
- `DELETE /roles/:roleId`
- `GET /moderation/actions`
- `POST /moderation/actions`
- `PATCH /channels/:channelId/moderation`
- `GET /automod/rules`
- `POST /automod/rules`
- `PATCH /automod/rules/:ruleId`
- `DELETE /automod/rules/:ruleId`
- `GET /audit/logs`
- `GET /invites`
- `POST /invites`
- `DELETE /invites/:code`

## Voice

- `POST /voice/channels/:channelId/token`
- `POST /voice/channels/:channelId/join`
- `POST /voice/channels/:channelId/leave`
- `PATCH /voice/state`
- `GET /voice/channels/:channelId/state`
- `GET /voice/diagnostics`

## Health and Metrics

- `GET /health`
- `GET /ready`
- `GET /admin/metrics`
