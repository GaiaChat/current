#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR" || exit 1

node "$ROOT_DIR/scripts/install-local-current.mjs" "$@"
CURRENT_EXIT_CODE=$?

echo
if [[ "$CURRENT_EXIT_CODE" -eq 0 ]]; then
  echo "Current setup is complete. You can now run Current Server.command."
else
  echo "Current setup stopped with exit code $CURRENT_EXIT_CODE."
fi
read -r -p "Press Return to close this window."
exit "$CURRENT_EXIT_CODE"
