#!/usr/bin/env node
/**
 * fetch-vendor-cc-connect.mjs
 *
 * Pre-publish helper: downloads cc-connect native binaries from upstream
 * GitHub releases (via mirror) into vendor/cc-connect/<os>-<arch>/ so they
 * get baked into the npm tarball. This is the "pre-baked binary" strategy —
 * end users never download anything at install/runtime, works on the
 * nastiest networks (air-gapped, corp proxy, GFW, …).
 *
 * Why a script (not committed binaries): the 4 binaries total ~100MB; keeping
 * them in git bloats the repo and slows every clone. Instead this script
 * fetches them right before `npm publish`, so only the published tarball
 * carries the weight.
 *
 * Idempotent: skips platforms whose binary already reports the right version.
 *
 * Usage:
 *   node scripts/fetch-vendor-cc-connect.mjs           # 1.4.1 (from package.json)
 *   node scripts/fetch-vendor-cc-connect.mjs 1.5.0      # specific version
 *   CC_CONNECT_MIRROR=https://gh-proxy.com/ node ...    # force mirror
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(projectRoot, 'vendor', 'cc-connect');
const UPSTREAM_REPO = 'chenhg5/cc-connect';

const DEFAULT_MIRRORS = [
  process.env.CC_CONNECT_MIRROR,
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  '', // raw github last resort
].filter((m) => m !== undefined);

// Desktop packages are self-contained on every supported OS/architecture.
const TARGETS = [
  { os: 'darwin', arch: 'amd64', ext: '.tar.gz', binary: 'cc-connect' },
  { os: 'darwin', arch: 'arm64', ext: '.tar.gz', binary: 'cc-connect' },
  { os: 'windows', arch: 'amd64', ext: '.zip', binary: 'cc-connect.exe' },
  { os: 'windows', arch: 'arm64', ext: '.zip', binary: 'cc-connect.exe' },
  { os: 'linux', arch: 'amd64', ext: '.tar.gz', binary: 'cc-connect' },
  { os: 'linux', arch: 'arm64', ext: '.tar.gz', binary: 'cc-connect' },
];

function log(...args) { console.log('[fetch-vendor]', ...args); }
function warn(...args) { console.warn('[fetch-vendor] WARN:', ...args); }

function resolveVersion(override) {
  if (override) return override;
  const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
  const pinned = pkg.optionalDependencies?.['cc-connect'];
  if (pinned) return pinned.replace(/^[^0-9]*/, '');
  throw new Error('Cannot determine cc-connect version; pass it explicitly.');
}

function buildUrls(filename, version) {
  const base = `https://github.com/${UPSTREAM_REPO}/releases/download/v${version}/${filename}`;
  return DEFAULT_MIRRORS.map((m) => `${m}${base}`);
}

async function fetchToBuffer(url, redirects = 5) {
  if (redirects <= 0) throw new Error('Too many redirects');
  const mod = await import(url.startsWith('https') ? 'node:https' : 'node:http');
  return new Promise((resolve, reject) => {
    const req = mod.default.get(url, { headers: { 'User-Agent': 'agentpanel-vendor-fetch' }, timeout: 120_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchToBuffer(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout: ${url}`)));
  });
}

async function download(filename, version) {
  let lastErr;
  for (const url of buildUrls(filename, version)) {
    try {
      log('downloading', url);
      const buf = await fetchToBuffer(url);
      log(`downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
      return buf;
    } catch (err) { warn(err.message); lastErr = err; }
  }
  throw new Error(`All mirrors failed. Last: ${lastErr?.message}`);
}

function extract(buffer, target, outDir) {
  const tmp = path.join(outDir, `_a${target.ext}`);
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, buffer);
    if (target.ext === '.tar.gz') {
      execFileSync('tar', ['xzf', tmp, '-C', outDir], { stdio: 'pipe' });
      return;
    }
    // .zip — cross-platform cascade. GNU tar (ubuntu) can't read zip and the
    // host may lack powershell; try common extractors in order, first success wins.
    const attempts = [
      ['unzip', ['-o', '-q', tmp, '-d', outDir]],
      ['tar', ['xf', tmp, '-C', outDir]],
      ['7z', ['x', '-y', '-bd', `-o${outDir}`, tmp]],
      ['powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${tmp}' -DestinationPath '${outDir}'`]],
    ];
    let lastErr;
    for (const [cmd, args] of attempts) {
      try { execFileSync(cmd, args, { stdio: 'pipe' }); return; }
      catch (e) { lastErr = e; }
    }
    throw lastErr;
  } finally { rmSync(tmp, { force: true }); }
}

function locateBinary(dir, target) {
  const direct = path.join(dir, target.binary);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('_') || /\.(zip|tar\.gz|tgz)$/i.test(entry)) continue;
    if (entry.startsWith(target.binary.replace(/\.exe$/, ''))) {
      const full = path.join(dir, entry);
      if (statSync(full).isFile()) return full;
    }
  }
  return null;
}

function versionOk(binaryPath, expected) {
  try {
    const out = execFileSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.includes(expected);
  } catch { return false; }
}

async function fetchOne(target, version) {
  const dir = path.join(VENDOR_DIR, `${target.os}-${target.arch}`);
  const binPath = path.join(dir, target.binary);
  mkdirSync(dir, { recursive: true });

  if (existsSync(binPath) && versionOk(binPath, version)) {
    log(`${target.os}-${target.arch}: v${version} already present, skipping`);
    return 'skip';
  }

  const filename = `cc-connect-v${version}-${target.os}-${target.arch}${target.ext}`;
  const buf = await download(filename, version);
  const work = path.join(tmpdir(), `cc-vendor-${createHash('sha256').update(target.os + target.arch).digest('hex').slice(0, 12)}`);
  rmSync(work, { force: true, recursive: true });
  mkdirSync(work, { recursive: true });
  extract(buf, target, work);
  const extracted = locateBinary(work, target);
  if (!extracted) throw new Error(`${target.binary} not found in archive`);
  rmSync(binPath, { force: true });
  // renameSync fails across drives/devices (Windows EXDEV: temp on C: → vendor on D:).
  try {
    renameSync(extracted, binPath);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(extracted, binPath);
    unlinkSync(extracted);
  }
  if (target.os !== 'windows') execFileSync('chmod', ['+x', binPath], { stdio: 'pipe' });
  if (target.os === 'darwin') { try { execFileSync('xattr', ['-d', 'com.apple.quarantine', binPath], { stdio: 'pipe' }); } catch {} }
  rmSync(work, { force: true, recursive: true });
  log(`${target.os}-${target.arch}: installed v${version}`);
  return 'installed';
}

async function main() {
  const version = resolveVersion(process.argv[2]);
  log(`version=v${version} mirrors=${DEFAULT_MIRRORS.map((m) => m || '<direct>').join(',')}`);
  const results = [];
  for (const target of TARGETS) results.push(await fetchOne(target, version));
  log('done:', JSON.stringify(results));
}

main().catch((err) => { console.error('[fetch-vendor] FATAL:', err.message); process.exit(1); });
