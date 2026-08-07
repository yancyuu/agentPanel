#!/usr/bin/env bash
set -euo pipefail

# publish-agentpanel.sh — one-shot npm publish from a clean worktree.
# Token must be set as NPM_TOKEN env var or passed via --token flag.
# The script writes a temporary .npmrc, publishes, then removes it.
# Never prints the token.

registry="https://registry.npmjs.org/"
worktree_dir="${1:-}"

if [[ -z "$worktree_dir" || ! -d "$worktree_dir" ]]; then
  echo "Usage: bash scripts/publish-agentpanel.sh <worktree-dir>" >&2
  echo "  worktree-dir: path to a clean git worktree with bumped version" >&2
  exit 2
fi

cd "$worktree_dir"

# Resolve token: env var > --token flag > hidden prompt
NPM_TOKEN="${NPM_TOKEN:-}"
if [[ -z "$NPM_TOKEN" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == --token=* ]]; then
      NPM_TOKEN="${arg#--token=}"
    fi
  done
fi
if [[ -z "$NPM_TOKEN" ]]; then
  printf 'Paste npm token (input hidden): ' >&2
  IFS= read -rs NPM_TOKEN
  printf '\n' >&2
fi

if [[ -z "$NPM_TOKEN" ]]; then
  echo 'NPM token is empty' >&2
  exit 2
fi

cleanup() { rm -f .npmrc; }
trap cleanup EXIT

{
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN"
  printf 'registry=%s\n' "$registry"
  printf 'always-auth=true\n'
} > .npmrc

echo "=== npm whoami ===" >&2
npm whoami --registry "$registry"

pkg_name=$(node -e 'const p=require("./package.json"); console.log(p.name)')
pkg_version=$(node -e 'const p=require("./package.json"); console.log(p.version)')
echo "=== publishing ${pkg_name}@${pkg_version} ===" >&2

npm publish --access public --registry "$registry"

echo "=== verifying ===" >&2
npm view "${pkg_name}" version dist-tags --json --registry "$registry"
