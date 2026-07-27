#!/usr/bin/env node
// scripts/build-standalone-package.mjs
//
// Assemble a "no Node install" distribution of agentcli into dist-standalone/:
// the app + a bundled portable node + a launcher. Users unzip and run
// `agentcli.cmd` (Windows) / `agentcli` (unix) — Node does NOT need to be
// installed on their machine.
//
// This reuses the fast (~155ms cold-start) external bundle from build:server.
// The bundled node runs bin/hermit.mjs, which spawns the precompiled bundle
// (no tsx, no runtime transpilation).
//
// Node source (default): copy the currently-running node (process.execPath) —
// it is self-contained/relocatable on Windows/macOS/Linux, needs no download,
// and is guaranteed compatible with what you built with. Set NODE_VERSION to
// download a specific version instead. Set STANDALONE_PLATFORM for cross builds.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const PLATFORM = process.env.STANDALONE_PLATFORM || `${process.platform}-${process.arch}`;
const NODE_VERSION = process.env.NODE_VERSION || '';
const OUT = path.join(root, 'dist-standalone');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
const isWin = process.platform === 'win32';
const nodeExeName = isWin ? 'node.exe' : 'node';

function log(...a) {
  console.log('[build-standalone]', ...a);
}

async function downloadNode(dest) {
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${PLATFORM}.zip`;
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`node download failed: ${res.status} ${url}`);
  const zip = path.join(root, `.node-${PLATFORM}.zip`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const extractDir = path.join(root, `.node-extract`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  execSync(`tar -xf "${path.basename(zip)}"`, { cwd: extractDir, stdio: 'inherit' });
  const exeRel = isWin ? 'node.exe' : 'bin/node';
  const nodeSrc = path.join(extractDir, `node-v${NODE_VERSION}-${PLATFORM}`, exeRel);
  if (!existsSync(nodeSrc)) throw new Error(`node binary not found at ${nodeSrc}`);
  cpSync(nodeSrc, dest);
  rmSync(zip, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
}

function installNode() {
  const dest = path.join(OUT, nodeExeName);
  if (NODE_VERSION) {
    return downloadNode(dest);
  }
  // Default: copy the running node — relocatable, no download, guaranteed compatible.
  log(`copying running node: ${process.execPath} -> ${path.relative(root, dest)}`);
  cpSync(process.execPath, dest);
}

function writeLauncher() {
  if (isWin) {
    writeFileSync(
      path.join(OUT, 'agentcli.cmd'),
      '@echo off\r\n"%~dp0node.exe" "%~dp0bin\\hermit.mjs" %*\r\n',
    );
  } else {
    const p = path.join(OUT, 'agentcli');
    writeFileSync(p, '#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/bin/hermit.mjs" "$@"\n');
    execSync(`chmod +x "${p}"`);
  }
}

async function main() {
  log(`platform=${PLATFORM} node=${NODE_VERSION || 'running node (' + process.version + ')'}`);

  // 1. Ensure the fast external bundle exists.
  if (!existsSync(path.join(root, 'dist', 'server.bundle.mjs'))) {
    log('building server bundle...');
    execSync('node scripts/build-server.mjs', { cwd: root, stdio: 'inherit' });
  }

  // 2. Clean + create output dir.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 3. Mirror package.json `files` (bin/, src/, dist/, dist-renderer/, vendor/, ...).
  for (const f of pkg.files) {
    const src = path.join(root, f);
    if (!existsSync(src)) {
      log(`skip (not present locally): ${f}`);
      continue;
    }
    cpSync(src, path.join(OUT, f), { recursive: true });
    log(`copied ${f}`);
  }

  // 4. Bundled node.
  await installNode();

  // 5. Production dependencies (flat node_modules, portable). --ignore-scripts
  //    skips postinstall/prepare/husky and cc-connect's fetch (we ship vendor/).
  log('installing production deps (this needs network)...');
  execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock', {
    cwd: OUT,
    stdio: 'inherit',
  });

  // 6. Launcher.
  writeLauncher();

  log('done ->', path.relative(root, OUT));
  log('run it with:  .\\dist-standalone\\agentcli.cmd   (Windows)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
