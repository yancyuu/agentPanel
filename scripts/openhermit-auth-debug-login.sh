#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${OPENHERMIT_AUTH_DEBUG_PORT:-3001}"
BASE_URL="${OPENHERMIT_AUTH_BASE_URL:-http://127.0.0.1:${PORT}}"

export OPENHERMIT_AUTH_BASE_URL="${BASE_URL}"

# Set OPENHERMIT_AUTH_OPEN_BROWSER=fetch only for automated smoke tests.
# Leave it unset for manual testing so the browser flow is visible.
if [[ "${OPENHERMIT_AUTH_DEBUG_FETCH:-}" == "1" ]]; then
  export OPENHERMIT_AUTH_OPEN_BROWSER=fetch
fi

exec node "${ROOT_DIR}/bin/hermit.mjs" auth login "$@"
