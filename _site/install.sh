#!/usr/bin/env bash
# scripts/install.sh
#
# One-line installer for agentpanel (macOS / Linux). Downloads a self-contained
# portable build that BUNDLES Node from GitHub Releases, extracts it to
# ~/.agentpanel, and puts it on PATH. No Node.js install required on the host.
#
# Users run:
#   curl -fsSL https://yancyuu.github.io/agentpanel/install.sh | bash
#
# Windows users: use the PowerShell installer instead:
#   irm https://yancyuu.github.io/agentpanel/install.ps1 | iex

set -euo pipefail

# GitHub repo that hosts the Releases with the portable zips.
REPO="yancyuu/agentpanel"
INSTALL_DIR="${AGENTPANEL_HOME:-$HOME/.agentpanel}"

c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info() { printf '%s %s\n' "$(c 36 '►')" "$*"; }
ok()   { printf '%s %s\n' "$(c 32 '✓')" "$*"; }
die()  { printf '%s %s\n' "$(c 31 '✗')" "$*" >&2; exit 1; }

# --- detect platform -------------------------------------------------------
case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*)
    die "你在 Windows 的 git-bash 里。请用 PowerShell 跑: irm https://yancyuu.github.io/agentpanel/install.ps1 | iex" ;;
  *) die "不支持的系统: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "不支持的架构: $(uname -m)" ;;
esac

ASSET="agentpanel-${OS}-${ARCH}.zip"
# GitHub 镜像前缀（国内 / 企业防火墙）。留空 = 直连 github.com；按顺序尝试，首个成功即用。
# 可用环境变量覆盖，例: AGENTPANEL_MIRROR=https://ghproxy.net/
MIRRORS=("${AGENTPANEL_MIRROR:-}" "https://gh-proxy.com/" "https://ghproxy.net/" "")

# --- download --------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
downloaded=0
for prefix in "${MIRRORS[@]}"; do
  URL="${prefix}https://github.com/${REPO}/releases/latest/download/${ASSET}"
  info "下载 $URL"
  if curl -fSL "$URL" -o "$TMP/$ASSET"; then
    ok "下载成功（镜像: ${prefix:-直连 github.com}）"
    downloaded=1
    break
  fi
done
[ "$downloaded" -eq 1 ] || die "下载失败。确认 ${REPO} 已发布含 ${ASSET} 的 Release（首次发版前还没有），或当前网络无法访问 GitHub。"

# --- extract ---------------------------------------------------------------
info "安装到 $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if command -v unzip >/dev/null 2>&1; then
  unzip -oq "$TMP/$ASSET" -d "$INSTALL_DIR"
elif tar -xf "$TMP/$ASSET" -C "$INSTALL_DIR" 2>/dev/null; then
  : # bsdtar can read zip
else
  die "需要 unzip 或 tar 来解压，装一个再重试。"
fi
# ensure executable bits (zip may not preserve them)
chmod +x "$INSTALL_DIR/node" 2>/dev/null || true
chmod +x "$INSTALL_DIR/agentpanel" 2>/dev/null || true

# --- PATH ------------------------------------------------------------------
ensure_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return 0 ;;
  esac
  local line="export PATH=\"$INSTALL_DIR:\$PATH\""
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    if ! grep -qF "$INSTALL_DIR" "$rc" 2>/dev/null; then
      printf '\n# added by agentpanel installer\n%s\n' "$line" >> "$rc"
      ok "已写入 $rc（重开终端生效）"
      return
    fi
  done
  printf '\n# added by agentpanel installer\n%s\n' "$line" >> "$HOME/.profile"
  ok "已写入 ~/.profile（重开终端生效）"
}
ensure_path

ok "安装完成 → $INSTALL_DIR"
printf '\n%s\n' "$(c 32 '开一个新终端，运行:') agentpanel"
printf '（或当前终端先: export PATH="%s:$PATH"）\n' "$INSTALL_DIR"
