#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "Installing dependencies with pnpm..."
if command -v pnpm >/dev/null 2>&1; then
  PM="pnpm"
else
  PM="npm"
fi

"$PM" install

echo "Building shared packages..."
if [[ "$PM" == "pnpm" ]]; then
  pnpm --filter @current/types build
  pnpm --filter @current/protocol build
  pnpm --filter @current/config build
  pnpm --filter @current/ui build
else
  npm run build --workspace=@current/types
  npm run build --workspace=@current/protocol
  npm run build --workspace=@current/config
  npm run build --workspace=@current/ui
fi

echo "Bootstrapping complete."
echo "Run with: pnpm --filter @current/server dev and pnpm --filter @current/web dev"
