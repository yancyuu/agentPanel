#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${OPENHERMIT_AUTH_DEBUG_PORT:-3001}"
HOST="${OPENHERMIT_AUTH_DEBUG_HOST:-127.0.0.1}"
FEISHU_APP_ID="${FEISHU_APP_ID:-cli_aab211aa86129cce}"

if [[ -z "${FEISHU_APP_SECRET:-}" ]]; then
  printf 'Feishu app_id: %s\n' "${FEISHU_APP_ID}"
  printf 'Feishu app_secret (input hidden, not written to disk): '
  IFS= read -rs FEISHU_APP_SECRET
  printf '\n'
fi

if [[ -z "${FEISHU_APP_SECRET}" ]]; then
  printf 'Missing FEISHU_APP_SECRET. Abort.\n' >&2
  exit 1
fi

export HOST
export PORT
export FEISHU_APP_ID
export FEISHU_APP_SECRET

printf 'Starting openHermit Feishu auth debug broker...\n'
printf 'Broker: http://%s:%s\n' "${HOST}" "${PORT}"
printf 'Callback URL to configure in Feishu: http://%s:%s/api/feishu/oauth/callback\n' "${HOST}" "${PORT}"
printf '\nAfter this server is ready, run in another terminal:\n'
printf '  node %q --control-url http://%s:%s\n' "${ROOT_DIR}/bin/hermit.mjs" "${HOST}" "${PORT}"
printf '\n'

exec node "${ROOT_DIR}/scripts/openhermit-device-auth-debug-server.mjs"
