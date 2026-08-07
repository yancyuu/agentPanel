#!/usr/bin/env bash
set -euo pipefail

command -v lark-cli >/dev/null 2>&1 || {
  printf '错误：未找到 lark-cli\n' >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || {
  printf '错误：需要 jq，可运行 brew install jq\n' >&2
  exit 1
}

run_lark() {
  if [[ -n "${LARK_CLI_PROFILE:-}" ]]; then
    lark-cli --profile "$LARK_CLI_PROFILE" "$@"
  else
    lark-cli "$@"
  fi
}

CONFIG="${HOME}/.lark-cli/config.json"

if [[ ! -f "$CONFIG" ]]; then
  printf '错误：未找到 lark-cli 配置：%s\n' "$CONFIG" >&2
  exit 1
fi

STATUS="$(
  run_lark auth status --json
)"

APP_ID="$(
  jq -r '
    .apps[0].appId //
    .apps[0].app_id //
    empty
  ' "$CONFIG"
)"

printf '%s\n' '=== lark-cli 当前凭据状态 ==='
printf 'App ID: %s\n' "${APP_ID:-未找到}"

jq -r '
  .identities.user as $u |
  "用户名: \($u.userName // "未知")",
  "Open ID: \($u.openId // "未知")",
  "Token 状态: \($u.tokenStatus // "未知")",
  "身份类型: user"
' <<<"$STATUS"

printf '%s\n' \
  'App Secret: 已由 lark-cli 加密保存，不导出' \
  'Access Token: 已由 lark-cli 管理，不导出' \
  'Refresh Token: 已由 lark-cli 管理，不导出'

printf '\n%s\n' '=== 权限检查 ==='
run_lark auth check \
  --scope 'im:message.send_as_user im:message' \
  --json |
  jq .
