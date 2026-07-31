/**
 * CcConnectBinaryFetcher — runtime self-heal downloader for the cc-connect
 * native binary, independent of cc-connect's own install.js.
 *
 * Why this exists:
 *   cc-connect ships as an `optionalDependencies` entry. When its postinstall
 *   (GitHub Releases download) fails — common behind the GFW / corporate
 *   firewalls — npm silently skips it and the user is left with a broken
 *   install that only surfaces later as a cryptic "fetch failed" when
 *   hermit-bridge can't start. For users who already installed agentcli
 *   before the install.js mirror patch landed, re-running postinstall won't
 *   help either, because their on-disk cc-connect install.js is still the
 *   raw-GitHub original.
 *
 *   This module lets the boot path self-heal: when resolveHermitBridgeRunner()
 *   cannot find a usable runner (or the runner finds no binary), agentcli
 *   downloads the binary itself from mirror-proxied GitHub releases into a
 *   stable location under HERMIT_HOME, so the user never has to reinstall
 *   agentcli or touch GitHub directly.
 *
 * Download policy (mirrors HermitBridgeLauncher's resolve priority):
 *   1. CC_CONNECT_MIRROR env (comma-separated prefixes; user override)
 *   2. built-in GitHub-release proxies (gh-proxy.com, ghproxy.net)
 *   3. raw github.com (last resort)
 *
 * Platform coverage: darwin/linux/windows × amd64/arm64. Same archive naming
 * as upstream cc-connect releases.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLogger } from '@shared/utils/logger';

const require = createRequire(import.meta.url);
const logger = createLogger('CcConnectBinaryFetcher');

const UPSTREAM_REPO = 'chenhg5/cc-connect';

const DEFAULT_MIRROR_PREFIXES = ['https://gh-proxy.com/', 'https://ghproxy.net/'];

function abortError(): Error {
  const error = new Error('cc-connect binary preparation cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

interface PlatformTarget {
  os: string; // cc-connect release naming: darwin | linux | windows
  arch: string; // amd64 | arm64
  ext: '.tar.gz' | '.zip';
  binaryName: string; // cc-connect | cc-connect.exe
}

function detectPlatformTarget(): PlatformTarget | null {
  const platform = process.platform; // darwin | win32 | linux
  const arch = process.arch; // x64 | arm64

  const osMap: Record<string, string> = { darwin: 'darwin', win32: 'windows', linux: 'linux' };
  const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };

  const os = osMap[platform];
  const cpu = archMap[arch];
  if (!os || !cpu) return null;
  const isWindows = os === 'windows';
  return {
    os,
    arch: cpu,
    ext: isWindows ? '.zip' : '.tar.gz',
    binaryName: isWindows ? 'cc-connect.exe' : 'cc-connect',
  };
}

/** Resolve the cc-connect version agentcli expects, from package.json. */
function resolveExpectedVersion(): string | null {
  // 1. If cc-connect npm package is installed, its own package.json is the
  //    most authoritative source (matches exactly what run.js expects).
  try {
    const ccPkgPath = require.resolve('cc-connect/package.json');
    const ccPkg = JSON.parse(readFileSync(ccPkgPath, 'utf-8'));
    if (ccPkg.version) return ccPkg.version;
  } catch {
    /* not installed yet — fall through */
  }
  // 2. Read agentcli's own package.json (works both published and from source).
  try {
    const candidates = [
      () => require.resolve('@yancyyu/agentcli/package.json'),
      // dev / monorepo fallback: walk up from this module's location.
      () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs');
        let dir = __dirname;
        for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
          const candidate = path.join(dir, 'package.json');
          if (fs.existsSync(candidate)) {
            const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
            if (pkg.name === '@yancyyu/agentcli') return candidate;
          }
          dir = path.dirname(dir);
        }
        throw new Error('agentcli package.json not found');
      },
    ];
    for (const resolve of candidates) {
      try {
        const pkgPath = resolve();
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const pinned = pkg.optionalDependencies?.['cc-connect'];
        if (pinned) return pinned.replace(/^[^0-9]*/, '');
      } catch {
        /* try next candidate */
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

function buildCandidateUrls(filename: string, version: string): string[] {
  const base = `https://github.com/${UPSTREAM_REPO}/releases/download/v${version}/${filename}`;
  const configured = (process.env.CC_CONNECT_MIRROR || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const prefixes = [...configured, ...DEFAULT_MIRROR_PREFIXES];
  // Mirrors first (prepended to full GitHub URL), then raw GitHub last.
  return [...prefixes.map((p) => `${p}${base}`), base];
}

async function fetchToBuffer(
  url: string,
  redirectsLeft = 5,
  signal?: AbortSignal
): Promise<Buffer> {
  throwIfAborted(signal);
  if (redirectsLeft <= 0) throw new Error('Too many redirects');
  const request = url.startsWith('https') ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = <T>(callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      callback(value);
    };
    const req = request(
      url,
      { headers: { 'User-Agent': 'agentcli-cc-connect-fetcher' }, timeout: 60_000 },
      (res) => {
        if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          fetchToBuffer(next, redirectsLeft - 1, signal).then(
            (buffer) => finish(resolve, buffer),
            (error) => finish(reject, error)
          );
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          finish(reject, new Error(`HTTP ${String(res.statusCode)} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => finish(resolve, Buffer.concat(chunks)));
        res.on('error', (error: Error) => finish(reject, error));
      }
    );
    const handleAbort = (): void => {
      req.destroy(abortError());
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
    req.on('error', (error: Error) => finish(reject, error));
    req.on('timeout', () => req.destroy(new Error(`timeout fetching ${url}`)));
    if (signal?.aborted) handleAbort();
  });
}

async function downloadWithMirrors(
  filename: string,
  version: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const urls = buildCandidateUrls(filename, version);
  let lastErr: unknown;
  for (const url of urls) {
    throwIfAborted(signal);
    try {
      logger.info(`downloading cc-connect binary from ${url}`);
      const buf = await fetchToBuffer(url, 5, signal);
      logger.info(`downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
      return buf;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      logger.warn(`download failed: ${(err as Error).message}, trying next source`);
      lastErr = err;
    }
  }
  throw new Error(
    `Could not download cc-connect binary from any source. Last error: ${(lastErr as Error)?.message}`
  );
}

function extractArchive(buffer: Buffer, target: PlatformTarget, outDir: string): void {
  const tmpArchive = path.join(outDir, `_archive${target.ext}`);
  try {
    rmSync(tmpArchive, { force: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(tmpArchive, buffer);
    if (target.ext === '.tar.gz') {
      execFileSync('tar', ['xzf', tmpArchive, '-C', outDir], { stdio: 'pipe' });
    } else {
      // Windows .zip — prefer bsdtar (Win10+ ships it as `tar`), fall back to PowerShell.
      try {
        execFileSync('tar', ['xf', tmpArchive, '-C', outDir], { stdio: 'pipe' });
      } catch {
        execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Expand-Archive -Force -LiteralPath '${tmpArchive}' -DestinationPath '${outDir}'`,
          ],
          { stdio: 'pipe' }
        );
      }
    }
  } finally {
    rmSync(tmpArchive, { force: true });
  }
}

function locateBinary(rootDir: string, target: PlatformTarget): string | null {
  // Direct match first (preferred).
  const direct = path.join(rootDir, target.binaryName);
  if (existsSync(direct)) return direct;
  // Archives name the binary with a version suffix, e.g.
  // `cc-connect-v1.4.1-darwin-arm64` (no `bin/` nesting). Match any entry that
  // starts with the binary stem and has no archive extension.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const stem = target.binaryName.replace(/\.exe$/, '');
  for (const entry of fs.readdirSync(rootDir)) {
    // Skip archives, temp files, and the version-dir case (handled below).
    if (entry.startsWith('_') || /\.(zip|tar\.gz|tgz)$/i.test(entry)) continue;
    // Flat-file match: `cc-connect-vX.Y.Z-platform-arch[.exe]`
    if (entry.startsWith(stem)) {
      // On Windows the binary keeps .exe; on unix the archived name has no ext.
      const full = path.join(rootDir, entry);
      const stat = fs.statSync(full);
      if (stat.isFile()) return full;
    }
    // Nested-dir match (if upstream ever nests under a folder).
    if (entry.startsWith(stem) && fs.statSync(path.join(rootDir, entry)).isDirectory()) {
      const nested = path.join(rootDir, entry, target.binaryName);
      if (existsSync(nested)) return nested;
    }
  }
  return null;
}

function binaryReportsVersion(binaryPath: string, expected: string): boolean {
  try {
    const out = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true, // 否则 Windows 上每次校验版本都会闪一下 cc-connect.exe 黑框
    });
    return out.includes(expected);
  } catch {
    return false;
  }
}

export interface FetchResult {
  binaryPath: string;
  version: string;
  newlyDownloaded: boolean;
}

/**
 * Ensure the cc-connect binary is available at the stable HERMIT_HOME location.
 * Downloads (via mirrors) when missing or version-mismatched. Idempotent.
 *
 * @param hermitHome HERMIT_HOME dir; binary lands in `<hermitHome>/cc-connect-bin/`
 * @returns absolute path to the usable binary, or null if the current platform
 *          is unsupported / the expected version cannot be determined.
 */
export async function ensureCcConnectBinary(
  hermitHome: string,
  signal?: AbortSignal
): Promise<FetchResult | null> {
  throwIfAborted(signal);
  const target = detectPlatformTarget();
  if (!target) {
    logger.warn(`unsupported platform ${process.platform}/${process.arch}; skipping binary fetch`);
    return null;
  }
  const version = resolveExpectedVersion();
  if (!version) {
    logger.warn('could not resolve expected cc-connect version from package.json; skipping');
    return null;
  }

  const binDir = path.join(hermitHome, 'cc-connect-bin');
  const binaryPath = path.join(binDir, target.binaryName);
  mkdirSync(binDir, { recursive: true });

  if (existsSync(binaryPath) && binaryReportsVersion(binaryPath, version)) {
    logger.info(`cc-connect v${version} already present at ${binaryPath}`);
    return { binaryPath, version, newlyDownloaded: false };
  }

  const packageRoot = process.env.AGENTCLI_PACKAGE_ROOT?.trim();
  const bundledBinary = packageRoot
    ? path.join(
        packageRoot,
        'vendor',
        'cc-connect',
        `${target.os}-${target.arch}`,
        target.binaryName
      )
    : '';
  if (bundledBinary && existsSync(bundledBinary) && binaryReportsVersion(bundledBinary, version)) {
    rmSync(binaryPath, { force: true });
    copyFileSync(bundledBinary, binaryPath);
    if (process.platform !== 'win32') {
      execFileSync('chmod', ['+x', binaryPath], { stdio: 'pipe' });
    }
    logger.info(`cc-connect v${version} installed from desktop bundle to ${binaryPath}`);
    return { binaryPath, version, newlyDownloaded: false };
  }

  const filename = `cc-connect-v${version}-${target.os}-${target.arch}${target.ext}`;
  const buffer = await downloadWithMirrors(filename, version, signal);
  throwIfAborted(signal);

  const workDir = path.join(
    tmpdir(),
    // Non-secret: just a stable, collision-free temp dir name per platform+version.
    `cc-connect-fetch-${createHash('sha256').update(`${target.os}-${target.arch}-${version}`).digest('hex').slice(0, 16)}`
  );
  rmSync(workDir, { force: true, recursive: true });
  mkdirSync(workDir, { recursive: true });

  try {
    extractArchive(buffer, target, workDir);
    throwIfAborted(signal);
    const extracted = locateBinary(workDir, target);
    if (!extracted) {
      throw new Error(`binary ${target.binaryName} not found in archive after extract`);
    }

    throwIfAborted(signal);
    rmSync(binaryPath, { force: true });
    renameSync(extracted, binaryPath);
    if (process.platform !== 'win32') {
      execFileSync('chmod', ['+x', binaryPath], { stdio: 'pipe' });
    }
    if (process.platform === 'darwin') {
      try {
        execFileSync('xattr', ['-d', 'com.apple.quarantine', binaryPath], { stdio: 'pipe' });
      } catch {
        /* quarantine attribute absent is fine */
      }
    }
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }

  logger.info(`cc-connect v${version} installed to ${binaryPath}`);
  return { binaryPath, version, newlyDownloaded: true };
}
