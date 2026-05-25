#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR" || exit 1

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    sudo node "$ROOT_DIR/update-current-server.mjs" --no-pause "$@"
    CURRENT_EXIT_CODE=$?
  else
    echo "Current updater needs root permissions. Re-run this with sudo."
    CURRENT_EXIT_CODE=1
  fi
else
  node "$ROOT_DIR/update-current-server.mjs" --no-pause "$@"
  CURRENT_EXIT_CODE=$?
fi

echo
if [[ "$CURRENT_EXIT_CODE" -eq 0 ]]; then
  echo "Current updater is complete."
else
  echo "Current updater stopped with exit code $CURRENT_EXIT_CODE."
fi
read -r -p "Press Enter/Return to close this window."
exit "$CURRENT_EXIT_CODE"
