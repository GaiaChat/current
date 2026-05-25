#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Please run install-current.sh as root (sudo)."
  exit 1
fi

CURRENT_USER="${SUDO_USER:-$(whoami)}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${CURRENT_SERVER_INSTALL_ROOT:-/opt/current}"
STATE_DIR="${CURRENT_SERVER_STATE_DIR:-/var/lib/current}"
CONFIG_DIR="/etc/current"
CONFIG_PATH="$CONFIG_DIR/current.config.json"
SERVICE_TEMPLATE="$SOURCE_DIR/deploy/current.service"
SERVICE_TARGET="/etc/systemd/system/current.service"

if [[ ! -f "$SERVICE_TEMPLATE" ]]; then
  echo "Missing service template: $SERVICE_TEMPLATE"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required."
  exit 1
fi

VERSION="$(
  node - "$SOURCE_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
for (const file of ['release-info.json', 'package.json']) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      process.stdout.write(parsed.version.trim());
      process.exit(0);
    }
  } catch {
    // keep looking
  }
}
process.stdout.write('0.1.0');
NODE
)"
VERSION_NAME="current-server-v$VERSION"
VERSION_DIR="$INSTALL_ROOT/versions/$VERSION_NAME"
CURRENT_WORKDIR="$INSTALL_ROOT/current"

mkdir -p "$CONFIG_DIR" "$INSTALL_ROOT/versions" "$STATE_DIR/uploads" "$STATE_DIR/backups"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Creating default config at $CONFIG_PATH"
  cat > "$CONFIG_PATH" <<'JSON'
{
  "version": 1,
  "server": {
    "name": "Current Server",
    "slug": "current-server",
    "host": "0.0.0.0",
    "port": 6414,
    "publicUrl": "http://127.0.0.1:6414",
    "registrationMode": "invite_only",
    "tls": {
      "enabled": false,
      "certPath": "",
      "keyPath": ""
    }
  },
  "auth": {
    "mode": "atproto",
    "atprotoClientId": "",
    "redirectUri": "http://127.0.0.1:6414/api/v1/auth/oauth/callback",
    "lanRedirectBaseUrl": "",
    "authorizationEndpoint": "https://bsky.social/oauth/authorize",
    "tokenEndpoint": "https://bsky.social/oauth/token",
    "profileEndpoint": "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile",
    "scope": "atproto transition:generic identity:handle rpc?aud=*&lxm=com.atproto.server.getSession",
    "cookieSecret": "change-me-super-secret-cookie-key-please",
    "allowDevLogin": true
  },
  "storage": {
    "sqlitePath": "/var/lib/current/current.sqlite",
    "uploadDir": "/var/lib/current/uploads",
    "mediaBackend": "local"
  },
  "media": {
    "maxAttachmentBytes": 10485760,
    "allowedMimePrefixes": ["image/", "video/", "audio/", "application/pdf"],
    "gifProvider": "klipy",
    "gifFallbackProvider": "none",
    "klipyApiKey": "",
    "giphyApiKey": ""
  },
  "appearance": {
    "backgroundAttachmentId": "",
    "panelColor": "",
    "ownMessageColor": "",
    "otherMessageColor": ""
  },
  "moderation": {
    "defaultSlowmodeSeconds": 0,
    "maxMentionsPerMessage": 8,
    "linkPolicy": "members_only"
  },
  "rtc": {
    "listenIp": "0.0.0.0",
    "announcedIp": "127.0.0.1",
    "udpMinPort": 40000,
    "udpMaxPort": 40100,
    "workerCount": 0,
    "sessionTimeoutMs": 45000,
    "turnUrls": []
  },
  "observability": {
    "metricsEnabled": true,
    "logLevel": "info"
  }
}
JSON
fi

TMP_VERSION_DIR="$INSTALL_ROOT/versions/.stage-$VERSION_NAME-$$"
rm -rf "$TMP_VERSION_DIR"
mkdir -p "$TMP_VERSION_DIR"

tar \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./release-server' \
  --exclude='./apps/server/config' \
  --exclude='./apps/server/data' \
  --exclude='./apps/server/uploads' \
  --exclude='./apps/server/backups' \
  --exclude='./apps/server/**/*.sqlite' \
  --exclude='./apps/server/**/*.sqlite-shm' \
  --exclude='./apps/server/**/*.sqlite-wal' \
  -C "$SOURCE_DIR" -cf - . | tar -C "$TMP_VERSION_DIR" -xf -

rm -rf "$VERSION_DIR"
mv "$TMP_VERSION_DIR" "$VERSION_DIR"

if [[ -e "$CURRENT_WORKDIR" && ! -L "$CURRENT_WORKDIR" ]]; then
  echo "$CURRENT_WORKDIR exists and is not a symlink. Move it aside before installing."
  exit 1
fi
ln -sfn "$VERSION_DIR" "$CURRENT_WORKDIR"

sed \
  -e "s|{{CURRENT_USER}}|$CURRENT_USER|g" \
  -e "s|{{CURRENT_WORKDIR}}|$CURRENT_WORKDIR|g" \
  "$SERVICE_TEMPLATE" > "$SERVICE_TARGET"

chown -R "$CURRENT_USER":"$CURRENT_USER" "$INSTALL_ROOT" "$STATE_DIR"
chown root:"$CURRENT_USER" "$CONFIG_PATH" 2>/dev/null || true
chmod 0640 "$CONFIG_PATH" 2>/dev/null || true

cd "$CURRENT_WORKDIR"

PNPM_VERSION="${CURRENT_PNPM_VERSION:-11.3.0}"
if command -v pnpm >/dev/null 2>&1; then
  PM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  PM=(corepack pnpm)
elif command -v npx >/dev/null 2>&1; then
  PM=(npx --yes "pnpm@$PNPM_VERSION")
else
  echo "pnpm is required. Install pnpm, enable corepack, or install npm/npx so this script can run pnpm@$PNPM_VERSION."
  exit 1
fi

if [[ -f "$CURRENT_WORKDIR/release-info.json" ]]; then
  "${PM[@]}" install --prod --frozen-lockfile || "${PM[@]}" install --prod
else
  "${PM[@]}" install
  "${PM[@]}" --filter @current/types build
  "${PM[@]}" --filter @current/protocol build
  "${PM[@]}" --filter @current/config build
  "${PM[@]}" --filter @current/web build
  "${PM[@]}" --filter @current/server build
fi

systemctl daemon-reload
systemctl enable current.service
systemctl restart current.service

echo "Current installed and started."
echo "Service status: systemctl status current.service"
echo "App symlink: $CURRENT_WORKDIR -> $VERSION_DIR"
echo "Config file: $CONFIG_PATH"
echo "State dir: $STATE_DIR"
