import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '@shared/utils/logger';

import { ensureCcConnectBinary } from './CcConnectBinaryFetcher';

const require = createRequire(import.meta.url);
const log = createLogger('HermitBridgeLauncher');

/** Minimal view of HermitBridgeClient the launcher needs to probe readiness. */
export interface BridgeManagementProbe {
  listProjects(): Promise<unknown>;
}

/** A spawned bridge process: pid + a way to terminate it. */
export interface SpawnedBridge {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): void;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { logFile?: string; env?: NodeJS.ProcessEnv; cwd?: string }
) => SpawnedBridge;
export type ResolveBinaryFn = () => string | null;

export interface BridgeLaunchOptions {
  configPath: string;
  /** Args appended after `-config <configPath>` (e.g. ['--force']). */
  extraArgs?: string[];
  /** File path to redirect the child's combined stdout/stderr. */
  logFile?: string;
  /**
   * Environment for the child. Defaults to process.env. Callers restarting the
   * bridge should pass FRESH HERMIT_BRIDGE_* tokens read from the current
   * config.toml (like the boot path does) — the parent process's own env may
   * carry stale tokens from ITS boot, and cc-connect then comes up
   * misconfigured or fails silently.
   */
  env?: NodeJS.ProcessEnv;
}

export interface EnsureRunningOptions extends BridgeLaunchOptions {
  client: BridgeManagementProbe;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

interface EnsureBinaryReadyOptions extends BridgeLaunchOptions {
  signal?: AbortSignal;
}

export interface EnsureRunningResult {
  launched: boolean;
  alreadyRunning: boolean;
  pid?: number;
}

export interface BridgeCommand {
  cmd: string;
  args: string[];
}

/**
 * Pure name-mapper: maps platform+arch to the canonical `cc-connect` binary name.
 * Used by tests; the actual resolution in production goes through
 * `resolveBridgeCommand` which probes the `cc-connect` npm package directly.
 */
export function resolveHermitBridgeBinaryName(
  platform: NodeJS.Platform = process.platform,
  _arch: NodeJS.Architecture = process.arch
): string | null {
  // cc-connect ships a single cross-platform binary named `cc-connect`
  // (the Go binary is the canonical cc-connect, identical to hermit-bridge).
  if (platform === 'win32') return 'cc-connect.exe';
  if (platform === 'darwin' || platform === 'linux') return 'cc-connect';
  return null;
}

/**
 * Resolve the cc-connect npm package's `run.js` entry (an optionalDependency).
 * `run.js` is the self-installing launcher that fetches the canonical cc-connect
 * Go binary on first run, so it is always present once the package is installed.
 * Returns null when cc-connect is not installed so the caller can fall back to
 * an externally managed bridge. (agentcli brands this component as "bridge"
 * outward, but the upstream npm package it ships is `cc-connect` — the former
 * `hermit-bridge` wrapper was dropped because it duplicated cc-connect with no
 * added logic and broke its own version→release coupling.)
 *
 * IMPORTANT: this also verifies the Go binary itself is present. On Windows /
 * behind the GFW, cc-connect's own install.js (GitHub Releases download) fails
 * silently because cc-connect sits in optionalDependencies — npm keeps the
 * package shell (run.js, install.js) but the binary never lands. If we only
 * checked for run.js, the boot path would think the runner is ready and hand
 * off to run.js, which then re-runs the same failing install.js in a loop.
 * Returning null here forces ensureBinaryReady() down the self-heal download
 * path (agentcli's own mirror-based fetcher), which is the reliable fix.
 */
function resolveHermitBridgeRunner(): string | null {
  // PREFERRED: return the binary path directly (not run.js), mirroring bin/lib/runtime.mjs.
  // run.js does execFileSync(binary, {stdio:'inherit'}) WITHOUT windowsHide, so on
  // Windows the cc-connect.exe pops a console window — users close it and kill the
  // runtime. Spawning the binary ourselves (defaultSpawn, which sets windowsHide)
  // avoids that. ensureCcConnectBinary() already validated the binary before we
  // get here, so run.js's version re-check adds no value.
  try {
    const pkgRoot = path.dirname(require.resolve('cc-connect/package.json'));
    const binaryName = resolveHermitBridgeBinaryName() ?? 'cc-connect';
    const binaryPath = path.join(pkgRoot, 'bin', binaryName);
    if (existsSync(binaryPath)) return binaryPath;
    // Fallback: run.js if the binary somehow isn't placed yet.
    const runner = path.join(pkgRoot, 'run.js');
    return existsSync(runner) ? runner : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the cc-connect Go binary directly (no run.js wrapper). Used as a
 * self-heal fallback when the cc-connect npm package is absent entirely —
 * e.g. for users who installed agentcli before the install.js mirror patch
 * landed and whose `optionalDependencies` install was silently skipped.
 * Looks under HERMIT_HOME/cc-connect-bin/, where ensureCcConnectBinary()
 * drops the binary it downloads from mirror-proxied GitHub releases.
 *
 * @param hermitHome HERMIT_HOME directory.
 * @returns absolute binary path, or null when not present.
 */
export function resolveHermitBridgeBinaryDirect(hermitHome: string): string | null {
  const binaryName = resolveHermitBridgeBinaryName() ?? 'cc-connect';
  const candidate = path.join(hermitHome, 'cc-connect-bin', binaryName);
  return existsSync(candidate) ? candidate : null;
}

/** Build the argv for `-config <path>` plus any extras. */
export function buildBridgeArgs(opts: BridgeLaunchOptions): string[] {
  return ['-config', opts.configPath, ...(opts.extraArgs ?? [])];
}

/**
 * Resolve the command + args to launch the bridge via the bundled cc-connect
 * `run.js` entry. Mirrors the CLI (bin/hermit.mjs: `node run.js -config <path>`)
 * so the same self-installing Go binary runs under node on every platform.
 * Throws when cc-connect is absent so the boot wiring can skip auto-launch
 * and fall through to an externally managed bridge.
 */
export function resolveBridgeCommand(
  opts: BridgeLaunchOptions,
  resolveBinary: ResolveBinaryFn = resolveHermitBridgeRunner
): BridgeCommand {
  const runner = resolveBinary();
  if (!runner) {
    throw new Error(
      'cc-connect runner not found — install cc-connect via npm (npm i cc-connect) or use --no-hermit-bridge to skip.'
    );
  }
  // If runner is run.js, spawn under node; otherwise it's the native binary
  // (preferred — avoids run.js popping a console window on Windows) and spawn
  // directly. Mirrors bin/hermit.mjs's isJs branching.
  const isJs = /\.(js|mjs)$/i.test(runner);
  const bridgeArgs = buildBridgeArgs(opts);
  return isJs
    ? { cmd: process.execPath, args: [runner, ...bridgeArgs] }
    : { cmd: runner, args: bridgeArgs };
}

/** Spawn the bridge detached, redirecting stdio to a log file (or ignoring it). */
function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { logFile?: string; cwd?: string; env?: NodeJS.ProcessEnv }
): SpawnedBridge {
  const fs = require('node:fs') as typeof import('node:fs');
  // Match bin/hermit.mjs spawn options: cwd (repoRoot) + env (HERMIT_BRIDGE_*
  // tokens) are REQUIRED for cc-connect to start correctly. Without them the
  // re-launched process comes up misconfigured or fails silently — the root
  // cause of the 1.9.52 "restart kills the runtime" regression.
  const spawnOpts: import('node:child_process').SpawnOptions = {
    // Windows: NEVER combine detached:true with windowsHide — CREATE_NO_WINDOW
    // is ignored alongside DETACHED_PROCESS (MSDN), so the child console window
    // pops anyway (Node issue #21825). The user then closes that "black box",
    // which KILLS the cc-connect runtime and every subsequent API call fails.
    // Non-detached + stdio-to-file + unref keeps the child alive after the
    // parent exits on Windows (no process-group/job kill), without a console.
    detached: process.platform !== 'win32',
    windowsHide: true,
    // Default to the current process cwd + env (which, in the daemon child,
    // is repoRoot + the HERMIT_BRIDGE_* tokens set by bin/hermit.mjs). This
    // matches the proven hermit.mjs spawn path. Callers can still override.
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
  };
  if (opts.logFile) {
    const fd = fs.openSync(opts.logFile, 'a');
    spawnOpts.stdio = ['ignore', fd, fd];
  } else {
    spawnOpts.stdio = 'ignore';
  }
  const child: ChildProcess = spawn(cmd, args, spawnOpts);
  child.on('error', (err) => log.error({ err, cmd }, 'cc-connect spawn failed'));
  child.unref();
  return child;
}

/**
 * Owns launching the cc-connect sidecar when it is not already running. Idempotent
 * and double-launch-safe: if the management API already responds, ensureRunning()
 * is a no-op and leaves any externally managed cc-connect untouched. Only stop()
 * kills a process THIS launcher started.
 */
export class HermitBridgeLauncher {
  private child: SpawnedBridge | null = null;
  private readonly binaryReadyTasks = new Map<string, Promise<BridgeCommand>>();

  constructor(
    private readonly deps: {
      now?: () => number;
      spawn?: SpawnFn;
      resolveBinary?: ResolveBinaryFn;
      ensureBinary?: typeof ensureCcConnectBinary;
    } = {}
  ) {}

  /** True when the cc-connect management API responds. */
  async isRunning(client: BridgeManagementProbe, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.awaitWithAbort(client.listProjects(), signal);
      return true;
    } catch (error) {
      if (this.isAbortError(error)) throw error;
      return false;
    }
  }

  /**
   * Fail-fast prerequisite: ensure the cc-connect binary is ready to launch
   * (either via the bundled npm package's run.js, or via the self-heal
   * downloader). Returns the cmd/args to launch it. Throws when the binary
   * cannot be resolved NOR downloaded — callers SHOULD let this propagate to
   * abort startup, so a missing binary is surfaced as a clear startup error
   * instead of a silently broken workbench where every config save fails with
   * a cryptic "fetch failed".
   *
   * Split out from ensureRunning() so the boot path can report binary
   * diagnostics independently while sharing the same deduplicated preparation
   * and lifecycle cancellation as the non-blocking service readiness wait.
   */
  async ensureBinaryReady(
    opts: EnsureBinaryReadyOptions,
    resolveBinary: ResolveBinaryFn = this.deps.resolveBinary ?? resolveHermitBridgeRunner
  ): Promise<BridgeCommand> {
    this.throwIfAborted(opts.signal);
    const taskKey = JSON.stringify([opts.configPath, opts.extraArgs ?? []]);
    let task = this.binaryReadyTasks.get(taskKey);
    if (!task) {
      task = this.prepareBinary(opts, resolveBinary).finally(() => {
        if (this.binaryReadyTasks.get(taskKey) === task) this.binaryReadyTasks.delete(taskKey);
      });
      this.binaryReadyTasks.set(taskKey, task);
    }
    return this.awaitWithAbort(task, opts.signal);
  }

  async ensureRunning(opts: EnsureRunningOptions): Promise<EnsureRunningResult> {
    this.throwIfAborted(opts.signal);
    if (await this.isRunning(opts.client, opts.signal)) {
      this.throwIfAborted(opts.signal);
      return { launched: false, alreadyRunning: true };
    }

    // Hard prerequisite: binary must be ready (self-heals if missing). A
    // failure here is the fail-fast signal callers should let propagate.
    const { cmd, args } = await this.ensureBinaryReady(opts);
    this.throwIfAborted(opts.signal);

    log.info({ cmd, args }, 'launching cc-connect');
    const spawnFn = this.deps.spawn ?? defaultSpawn;
    this.throwIfAborted(opts.signal);
    this.child = spawnFn(cmd, args, { logFile: opts.logFile, env: opts.env });
    const pid = this.child.pid;
    try {
      await this.waitForReady(opts);
      return { launched: true, alreadyRunning: false, pid };
    } catch (error) {
      if (opts.signal?.aborted) this.stop();
      throw error;
    }
  }

  private async prepareBinary(
    opts: EnsureBinaryReadyOptions,
    resolveBinary: ResolveBinaryFn
  ): Promise<BridgeCommand> {
    try {
      return resolveBridgeCommand(opts, resolveBinary);
    } catch {
      // cc-connect npm package not present (the classic silent-optional-failure
      // case). Self-heal: download the binary directly into HERMIT_HOME from
      // mirror-proxied GitHub releases.
      const hermitHome = process.env.HERMIT_HOME ?? path.join(os.homedir(), '.hermit');
      log.warn('cc-connect runner missing — attempting self-heal binary download');
      let result: { binaryPath: string } | null = null;
      try {
        result = await (this.deps.ensureBinary ?? ensureCcConnectBinary)(hermitHome, opts.signal);
      } catch (downloadErr) {
        if (this.isAbortError(downloadErr)) throw downloadErr;
        throw new Error(
          `cc-connect is not installed and could not be downloaded automatically: ${(downloadErr as Error).message}. ` +
            'Run `npm install -g cc-connect` manually, or set CC_CONNECT_MIRROR to a reachable GitHub-release proxy.'
        );
      }
      this.throwIfAborted(opts.signal);
      if (!result) {
        throw new Error(
          'cc-connect is not installed and the current platform is unsupported for auto-download. ' +
            'Run `npm install -g cc-connect` manually.'
        );
      }
      return { cmd: result.binaryPath, args: buildBridgeArgs(opts) };
    }
  }

  private abortError(): Error {
    const error = new Error('cc-connect launch cancelled');
    error.name = 'AbortError';
    return error;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.abortError();
  }

  private awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.throwIfAborted(signal);
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
      const handleAbort = (): void => {
        signal.removeEventListener('abort', handleAbort);
        reject(this.abortError());
      };
      signal.addEventListener('abort', handleAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', handleAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', handleAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  private waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', handleAbort);
        resolve();
      }, delayMs);
      const handleAbort = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', handleAbort);
        reject(this.abortError());
      };
      signal?.addEventListener('abort', handleAbort, { once: true });
    });
  }

  private async waitForReady(opts: EnsureRunningOptions): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const interval = opts.pollIntervalMs ?? 1000;
    const now = this.deps.now ?? Date.now;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await this.waitForDelay(interval, opts.signal);
      this.throwIfAborted(opts.signal);
      if (await this.isRunning(opts.client, opts.signal)) return;
      this.throwIfAborted(opts.signal);
    }
    throw new Error(`cc-connect did not become ready within ${timeoutMs}ms`);
  }

  /** Stop the bridge only if THIS launcher started it. */
  stop(): void {
    if (!this.child) return;
    try {
      this.child.kill('SIGTERM');
      log.info('stopped cc-connect launched by Hermit');
    } catch (err) {
      log.warn({ err }, 'failed to stop cc-connect');
    }
    this.child = null;
  }
}
