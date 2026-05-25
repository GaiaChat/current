#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR" || exit 1

node "$ROOT_DIR/update-current-server.mjs" --no-pause "$@"
CURRENT_EXIT_CODE=$?

echo
if [[ "$CURRENT_EXIT_CODE" -eq 0 ]]; then
  echo "Current updater is complete."
else
  echo "Current updater stopped with exit code $CURRENT_EXIT_CODE."
fi
read -r -p "Press Enter/Return to close this window."
exit "$CURRENT_EXIT_CODE"
