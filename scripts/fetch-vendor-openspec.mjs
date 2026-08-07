#!/usr/bin/env node
/**
 * fetch-vendor-openspec.mjs
 *
 * Pre-publish helper: downloads @fission-ai/openspec (version pinned in
 * package.json optionalDependencies) and pre-bakes it, with its production
 * dependencies installed, into vendor/openspec/. The standalone package then
 * ships a ready-to-run CLI — end users need no Node.js/npm and no network.
 *
 * Idempotent: skips when vendor/openspec already matches the pinned version.
 *
 * Usage:
 *   node scripts/fetch-vendor-openspec.mjs           # version from package.json
 *   node scripts/fetch-vendor-openspec.mjs 1.7.0      # specific version
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = process.argv[2] ?? pkg.optionalDependencies?.['@fission-ai/openspec'];
if (!version) {
  console.error('no pinned @fission-ai/openspec version in package.json optionalDependencies');
  process.exit(1);
}

const outDir = path.join(root, 'vendor', 'openspec');
const markerPath = path.join(outDir, '.version');
if (existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === version) {
  console.log(`openspec v${version} already vendored at vendor/openspec`);
  process.exit(0);
}

const work = path.join(
  tmpdir(),
  `openspec-vendor-${version}-${Math.random().toString(36).slice(2, 8)}`
);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

try {
  console.log(`packing @fission-ai/openspec@${version} ...`);
  execFileSync('npm', ['pack', `@fission-ai/openspec@${version}`, '--pack-destination', work], {
    cwd: root,
    stdio: 'inherit',
  });
  execSync('tar -xzf *.tgz', { cwd: work, stdio: 'inherit' });

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  renameSync(path.join(work, 'package'), outDir);

  console.log('installing production dependencies into vendor/openspec ...');
  execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock', {
    cwd: outDir,
    stdio: 'inherit',
  });

  writeFileSync(markerPath, `${version}\n`);
  console.log(`done -> vendor/openspec (v${version})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
