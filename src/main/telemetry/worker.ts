// Windows spawn sites pass { shell: true } to execute .cmd shims, which makes
// Node print DEP0190 into the worker's stderr logs. Not actionable — suppress.
process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { reapOtherUsageWorkers } from './workerSingleton';

import type { UsageTelemetryStatus } from '@main/services/session-intelligence/usageTypes';
import type { TelemetryConfig } from '@shared/types/team';

const STATUS_SCHEMA_VERSION = 1;
const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const LARK_AUDIT_MAX_BYTES = 512 * 1024;

type WorkerState = 'starting' | 'scanning' | 'idle' | 'disabled' | 'stopped' | 'error';

export interface UsageTelemetryWorkerPaths {
  hermitHome: string;
  telemetryDir: string;
  pidPath: string;
  statusPath: string;
  logPath: string;
  errorLogPath: string;
  settingsPath: string;
}

export interface UsageTelemetryWorkerStatus {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  state: WorkerState;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string;
  lastScan: string | null;
  source: 'claude-jsonl' | 'local-jsonl';
  telemetryEnabled: boolean;
  telemetry: UsageTelemetryStatus;
  lastError?: string;
}

interface LarkCredentialsReportStatus {
  ok: boolean;
  enabled: boolean;
  reason?: 'config-disabled' | 'fetch-failed';
  message?: string;
  lastAttemptAt: string;
  lastErrorAt?: string;
  lastHttpStatus?: number;
  accountCount?: number;
  accounts?: { appId?: string; userOpenId?: string; scope?: string }[];
}

export interface LarkCredentialsWorkerPaths {
  statusPath: string;
  auditLogPath: string;
}

export interface LarkCredentialsWorkerStatus {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  state: 'starting' | 'reporting' | 'idle' | 'error' | 'stopped';
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string;
  lastAttempt: string | null;
  report?: LarkCredentialsReportStatus;
}

interface SavedSettings {
  taskBus?: TelemetryConfig;
}

let stopping = false;
let startedAt = new Date().toISOString();
let lastTelemetry = emptyUsageTelemetryStatus();
let lastScan: string | null = null;

export function createInterruptibleWait(): {
  wait: (ms: number) => Promise<void>;
  interrupt: () => void;
} {
  const pending = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();
  return {
    wait: (ms) =>
      new Promise((resolve) => {
        const entry = {
          timer: setTimeout(() => {
            pending.delete(entry);
            resolve();
          }, ms),
          resolve,
        };
        pending.add(entry);
      }),
    interrupt: () => {
      for (const entry of pending) {
        clearTimeout(entry.timer);
        entry.resolve();
      }
      pending.clear();
    },
  };
}

const schedulerWait = createInterruptibleWait();

function requestWorkerStop(): void {
  stopping = true;
  schedulerWait.interrupt();
}

export function resolveHermitHome(): string {
  return process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit');
}

export function getUsageTelemetryWorkerPaths(
  hermitHome = resolveHermitHome()
): UsageTelemetryWorkerPaths {
  const telemetryDir = path.join(hermitHome, 'telemetry');
  return {
    hermitHome,
    telemetryDir,
    pidPath: path.join(telemetryDir, 'worker.pid'),
    statusPath: path.join(telemetryDir, 'status.json'),
    logPath: path.join(hermitHome, 'logs', 'telemetry-worker.log'),
    errorLogPath: path.join(hermitHome, 'logs', 'telemetry-worker.err.log'),
    settingsPath: path.join(hermitHome, 'settings.json'),
  };
}

export function getLarkCredentialsWorkerPaths(
  hermitHome = resolveHermitHome()
): LarkCredentialsWorkerPaths {
  return {
    statusPath: path.join(hermitHome, 'lark-credentials', 'status.json'),
    auditLogPath: path.join(hermitHome, 'logs', 'lark-credentials-audit.ndjson'),
  };
}

export function isUsageTelemetryWorkerPidRunning(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function emptyUsageTelemetryStatus(): UsageTelemetryStatus {
  return {
    connected: false,
    lastScan: null,
    sessions: 0,
    messages: 0,
    imMessages: 0,
    imTokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheCreation: 0,
    totalTokens: 0,
    recentMessages: 0,
    recentTokensTotal: 0,
    recentByProvider: {
      claudecode: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
      codex: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
      pi: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
    },
    activeDays: 0,
    hourly: Array.from({ length: 24 }, () => 0),
    projects: [],
    workSecondsByDay: {},
    daily: {},
    localUsers: [],
    byProvider: {
      claudecode: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
      codex: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
      pi: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
    },
    unresolvedUsage: { sessions: 0, messages: 0, tokensTotal: 0 },
  };
}

export async function readUsageTelemetryWorkerStatus(
  hermitHome = resolveHermitHome()
): Promise<{ status: UsageTelemetryWorkerStatus | null; error?: string }> {
  const paths = getUsageTelemetryWorkerPaths(hermitHome);
  try {
    const raw = await readFile(paths.statusPath, 'utf-8');
    const parsed = JSON.parse(raw) as UsageTelemetryWorkerStatus;
    return { status: parsed };
  } catch (err) {
    if (!existsSync(paths.statusPath)) return { status: null };
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function readTelemetryConfig(
  paths: UsageTelemetryWorkerPaths
): Promise<TelemetryConfig | null> {
  try {
    const raw = await readFile(paths.settingsPath, 'utf-8');
    const settings = JSON.parse(raw) as SavedSettings;
    return settings.taskBus ?? null;
  } catch {
    return null;
  }
}

async function writePid(paths: UsageTelemetryWorkerPaths): Promise<void> {
  await mkdir(paths.telemetryDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.pidPath, String(process.pid), { encoding: 'utf-8', mode: 0o600 });
}

async function removePid(paths: UsageTelemetryWorkerPaths): Promise<void> {
  await rm(paths.pidPath, { force: true });
}

function hasLocalTelemetry(telemetry: UsageTelemetryStatus | null | undefined): boolean {
  return Boolean(
    telemetry &&
    (Number(telemetry.sessions) > 0 ||
      Number(telemetry.messages) > 0 ||
      Number(telemetry.totalTokens) > 0 ||
      Boolean(telemetry.lastScan))
  );
}

async function readPersistedTelemetry(
  paths: UsageTelemetryWorkerPaths
): Promise<UsageTelemetryStatus | null> {
  try {
    const raw = await readFile(paths.statusPath, 'utf-8');
    const parsed = JSON.parse(raw) as UsageTelemetryWorkerStatus;
    return parsed?.telemetry && typeof parsed.telemetry === 'object' ? parsed.telemetry : null;
  } catch {
    return null;
  }
}

async function resolveStatusTelemetry(
  paths: UsageTelemetryWorkerPaths,
  telemetry: UsageTelemetryStatus | undefined
): Promise<UsageTelemetryStatus> {
  if (telemetry) return telemetry;
  if (hasLocalTelemetry(lastTelemetry)) return lastTelemetry;
  const persisted = await readPersistedTelemetry(paths);
  return persisted ?? lastTelemetry;
}

async function writeStatus(
  paths: UsageTelemetryWorkerPaths,
  state: WorkerState,
  cfg: TelemetryConfig | null,
  options: {
    running?: boolean;
    telemetry?: UsageTelemetryStatus;
    error?: string;
    startedAt?: string | null;
  } = {}
): Promise<UsageTelemetryWorkerStatus> {
  const telemetry = await resolveStatusTelemetry(paths, options.telemetry);
  lastTelemetry = telemetry;
  lastScan = telemetry.lastScan ?? lastScan;
  const status: UsageTelemetryWorkerStatus = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    state,
    running: options.running ?? !['disabled', 'stopped'].includes(state),
    pid: options.running === false ? null : process.pid,
    startedAt: options.startedAt === undefined ? startedAt : options.startedAt,
    updatedAt: new Date().toISOString(),
    lastScan,
    source: 'local-jsonl',
    telemetryEnabled: Boolean(cfg?.telemetry?.enabled),
    telemetry,
    ...(options.error ? { lastError: options.error } : {}),
  };
  await mkdir(paths.telemetryDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.statusPath, `${JSON.stringify(status, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return status;
}

function isUsageUploadDisabled(): boolean {
  return (
    process.env.HERMIT_USAGE_UPLOAD_DISABLED === '1' ||
    process.env.HERMIT_USAGE_FORCE_LOCAL_ONLY === '1'
  );
}

function uploadDisabledTelemetryConfig(cfg: TelemetryConfig | null): TelemetryConfig | null {
  if (!isUsageUploadDisabled() || !cfg?.telemetry) return cfg;
  return {
    ...cfg,
    telemetry: {
      ...cfg.telemetry,
      conversationUploadEnabled: false,
      conversations: {
        ...cfg.telemetry.conversations,
        uploadEnabled: false,
      },
    },
  };
}

function shouldForceLocalScan(): boolean {
  return process.env.HERMIT_USAGE_SCAN_DISABLED === '1' || isUsageUploadDisabled();
}

async function scanUsageTelemetryOnce(
  cfg: TelemetryConfig | null
): Promise<UsageTelemetryStatus | null | undefined> {
  const { scanTelemetryOnce } =
    await import('@main/services/session-intelligence/UsageTelemetryService');
  return scanTelemetryOnce(cfg ?? undefined);
}

export async function scanUsageTelemetryWorkerOnce(
  hermitHome = resolveHermitHome(),
  options: { keepWorkerRunning?: boolean } = {}
): Promise<{ status: UsageTelemetryWorkerStatus; shouldContinue: boolean }> {
  const paths = getUsageTelemetryWorkerPaths(hermitHome);
  const cfg = uploadDisabledTelemetryConfig(await readTelemetryConfig(paths));
  if (!cfg?.telemetry?.enabled) {
    if (shouldForceLocalScan()) {
      await writeStatus(paths, 'scanning', cfg);
      try {
        const telemetry = (await scanUsageTelemetryOnce(null)) ?? emptyUsageTelemetryStatus();
        const status = await writeStatus(paths, 'idle', cfg, {
          running: Boolean(options.keepWorkerRunning),
          telemetry,
          startedAt: options.keepWorkerRunning ? startedAt : null,
        });
        return { status, shouldContinue: false };
      } catch (err) {
        const status = await writeStatus(paths, 'error', cfg, {
          running: Boolean(options.keepWorkerRunning),
          error: err instanceof Error ? err.message : String(err),
          startedAt: options.keepWorkerRunning ? startedAt : null,
        });
        return { status, shouldContinue: false };
      }
    }
    const status = await writeStatus(paths, 'disabled', cfg, {
      running: Boolean(options.keepWorkerRunning),
      telemetry: lastTelemetry,
      startedAt: options.keepWorkerRunning ? startedAt : null,
    });
    if (!options.keepWorkerRunning) await removePid(paths);
    return { status, shouldContinue: false };
  }

  await writeStatus(paths, 'scanning', cfg);
  try {
    const telemetry = (await scanUsageTelemetryOnce(cfg)) ?? emptyUsageTelemetryStatus();
    const status = await writeStatus(paths, 'idle', cfg, { telemetry });
    return { status, shouldContinue: true };
  } catch (err) {
    const status = await writeStatus(paths, 'error', cfg, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { status, shouldContinue: true };
  }
}

function redactLarkError(message: string): string {
  return message
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1[hidden]')
    .replace(/(token|secret|password|authorization)=([^\s,;&]+)/gi, '$1=[hidden]')
    .slice(0, 500);
}

interface LarkCredentialsAuditEntry {
  timestamp: string;
  ok: boolean;
  reason?: LarkCredentialsReportStatus['reason'];
  message?: string;
  httpStatus?: number;
  accountCount?: number;
  accounts?: LarkCredentialsReportStatus['accounts'];
}

function buildLarkCredentialsAuditEntry(
  report: LarkCredentialsReportStatus
): LarkCredentialsAuditEntry {
  return {
    timestamp: report.lastAttemptAt,
    ok: report.ok,
    ...(report.reason ? { reason: report.reason } : {}),
    // message 携带可读的失败/未开启原因，进审计日志前统一过 redactLarkError 脱敏
    ...(report.message ? { message: redactLarkError(report.message) } : {}),
    ...(report.lastHttpStatus ? { httpStatus: report.lastHttpStatus } : {}),
    ...(report.accountCount ? { accountCount: report.accountCount } : {}),
    ...(report.accounts ? { accounts: report.accounts } : {}),
  };
}

export async function appendLarkCredentialsAuditLog(
  hermitHome: string,
  report: LarkCredentialsReportStatus
): Promise<void> {
  const { auditLogPath } = getLarkCredentialsWorkerPaths(hermitHome);
  try {
    await mkdir(path.dirname(auditLogPath), { recursive: true, mode: 0o700 });
    try {
      if ((await stat(auditLogPath)).size >= LARK_AUDIT_MAX_BYTES) {
        await truncate(auditLogPath, 0);
      }
    } catch {
      // First append creates the file.
    }
    await appendFile(auditLogPath, `${JSON.stringify(buildLarkCredentialsAuditEntry(report))}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    // An audit-write failure must never block the five-minute reporting loop.
  }
}

async function safeWriteLarkCredentialsStatus(
  hermitHome: string,
  state: LarkCredentialsWorkerStatus['state'],
  options: { report?: LarkCredentialsReportStatus; attemptAt?: string } = {}
): Promise<void> {
  try {
    await persistLarkCredentialsStatus(hermitHome, state, options);
  } catch {
    // Status persistence is diagnostic only; it must not stop Lark reporting.
  }
}

async function readLarkCredentialsWorkerStatus(
  hermitHome: string
): Promise<LarkCredentialsWorkerStatus | null> {
  try {
    const { statusPath } = getLarkCredentialsWorkerPaths(hermitHome);
    return JSON.parse(await readFile(statusPath, 'utf-8')) as LarkCredentialsWorkerStatus;
  } catch {
    return null;
  }
}

async function persistLarkCredentialsStatus(
  hermitHome: string,
  state: LarkCredentialsWorkerStatus['state'],
  options: { report?: LarkCredentialsReportStatus; attemptAt?: string } = {}
): Promise<void> {
  const paths = getLarkCredentialsWorkerPaths(hermitHome);
  const previous = await readLarkCredentialsWorkerStatus(hermitHome);
  const report = options.report
    ? options.report.message
      ? { ...options.report, message: redactLarkError(options.report.message) }
      : options.report
    : previous?.report;
  const lastAttempt =
    options.attemptAt ?? options.report?.lastAttemptAt ?? previous?.lastAttempt ?? null;
  await mkdir(path.dirname(paths.statusPath), { recursive: true, mode: 0o700 });
  const status: LarkCredentialsWorkerStatus = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    state,
    running: state !== 'stopped',
    pid: state === 'stopped' ? null : process.pid,
    startedAt: previous?.startedAt ?? startedAt,
    updatedAt: new Date().toISOString(),
    lastAttempt,
    ...(report ? { report } : {}),
  };
  await writeFile(paths.statusPath, `${JSON.stringify(status, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export async function scanLarkCredentialsOnce(
  hermitHome = resolveHermitHome()
): Promise<LarkCredentialsReportStatus> {
  // This compatibility seam intentionally performs no credential-store access,
  // token refresh, or network request. External Feishu channels are handled by
  // the optional cc-connect integration, not by personal credential reporting.
  const report: LarkCredentialsReportStatus = {
    ok: true,
    enabled: false,
    reason: 'config-disabled',
    message: '飞书凭证上报功能已移除',
    lastAttemptAt: new Date().toISOString(),
  };
  await safeWriteLarkCredentialsStatus(hermitHome, 'idle', { report });
  return report;
}

export interface FixedRateWorkerSchedulerOptions {
  intervalMs: number;
  initialDelayMs: number;
  now?: () => number;
  wait: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
  scanUsage: () => Promise<unknown>;
  scanLark: () => Promise<unknown>;
}

interface ScheduledTaskSlot {
  inFlight: Promise<void> | null;
}

function safeInvokePromise<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(fn());
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function launchScheduledTask(slot: ScheduledTaskSlot, task: () => Promise<unknown>): boolean {
  if (slot.inFlight) return false;
  slot.inFlight = safeInvokePromise(task)
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      slot.inFlight = null;
    });
  return true;
}

/**
 * Run usage and Lark on absolute, fixed-rate deadlines. Each task owns an
 * independent in-flight slot: a slow task skips only itself at the next tick,
 * while its peer continues on the five-minute cadence.
 */
export async function runFixedRateWorkerScheduler(
  options: FixedRateWorkerSchedulerOptions
): Promise<void> {
  const now = options.now ?? Date.now;
  const usageSlot: ScheduledTaskSlot = { inFlight: null };
  const larkSlot: ScheduledTaskSlot = { inFlight: null };
  let nextTickAt = now() + Math.max(0, options.initialDelayMs);

  while (!options.shouldStop()) {
    const delay = Math.max(0, nextTickAt - now());
    if (delay > 0) await options.wait(delay);
    if (options.shouldStop()) break;

    launchScheduledTask(usageSlot, options.scanUsage);
    launchScheduledTask(larkSlot, options.scanLark);

    nextTickAt += options.intervalMs;
    const currentTime = now();
    if (nextTickAt <= currentTime) {
      const missedIntervals = Math.floor((currentTime - nextTickAt) / options.intervalMs) + 1;
      nextTickAt += missedIntervals * options.intervalMs;
    }
  }
}

function scanIntervalMs(): number {
  const raw = Number.parseInt(process.env.HERMIT_USAGE_TELEMETRY_INTERVAL_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1_000, raw) : DEFAULT_SCAN_INTERVAL_MS;
}

export async function runUsageTelemetryWorker(hermitHome = resolveHermitHome()): Promise<void> {
  const paths = getUsageTelemetryWorkerPaths(hermitHome);
  startedAt = new Date().toISOString();
  await mkdir(path.dirname(paths.logPath), { recursive: true, mode: 0o700 });
  // At-most-one: reap any OTHER live worker daemon (pidfile-stale orphans included)
  // before claiming the pidfile, so a freshly booted worker — even after a reinstall
  // or respawn with no manual `usage stop` — always becomes the sole one.
  await reapOtherUsageWorkers();
  await writePid(paths);
  await writeStatus(paths, 'starting', await readTelemetryConfig(paths));

  const stop = async () => {
    if (stopping) return;
    requestWorkerStop();
    await writeStatus(paths, 'stopped', await readTelemetryConfig(paths), {
      running: false,
      startedAt,
    });
    await safeWriteLarkCredentialsStatus(hermitHome, 'stopped');
    await removePid(paths);
  };

  process.once('SIGINT', () => {
    void stop().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void stop().finally(() => process.exit(0));
  });

  // `usage start` has already run both tasks in its foreground startup pass, so
  // it marks the daemon to wait one interval before the first tick. Direct
  // launchd/restart boots run the first tick immediately. After that, ticks are
  // always fixed-rate and never depend on either task's completion or Lark status.
  const intervalMs = scanIntervalMs();
  const initialDelayMs = process.env.HERMIT_USAGE_STARTUP_PASS_COMPLETED === '1' ? intervalMs : 0;

  await runFixedRateWorkerScheduler({
    intervalMs,
    initialDelayMs,
    wait: (ms) => schedulerWait.wait(ms),
    shouldStop: () => stopping,
    scanUsage: () => scanUsageTelemetryWorkerOnce(hermitHome, { keepWorkerRunning: true }),
    scanLark: () => scanLarkCredentialsOnce(hermitHome),
  });
  await safeWriteLarkCredentialsStatus(hermitHome, 'stopped');
}

/**
 * Foreground startup pass for `agentpanel usage start`: start one usage telemetry
 * scan and one Lark credential batch report concurrently, then emit a single
 * safe JSON object to stdout. This is a bounded one-shot pass and deliberately
 * does NOT write or remove the daemon PID file. Each scan settles independently;
 * a Lark problem remains visible but never prevents daemon startup.
 */
export interface StartupOnceResult {
  ok: boolean;
  usage: { status: UsageTelemetryWorkerStatus; shouldContinue: boolean };
  lark: LarkCredentialsReportStatus;
}

export interface StartupOnceScans {
  scanUsage: () => Promise<{ status: UsageTelemetryWorkerStatus; shouldContinue: boolean }>;
  scanLark: () => Promise<LarkCredentialsReportStatus>;
}

export async function runStartupOnce(
  hermitHome = resolveHermitHome(),
  scans: StartupOnceScans = {
    scanUsage: () => scanUsageTelemetryWorkerOnce(hermitHome),
    scanLark: () => scanLarkCredentialsOnce(hermitHome),
  }
): Promise<StartupOnceResult> {
  const [usageResult, larkResult] = await Promise.allSettled([scans.scanUsage(), scans.scanLark()]);
  if (usageResult.status === 'rejected') throw usageResult.reason;
  const usage = usageResult.value;
  const lark =
    larkResult.status === 'fulfilled'
      ? larkResult.value
      : {
          ok: false,
          enabled: true,
          reason: 'fetch-failed' as const,
          message: redactLarkError(
            larkResult.reason instanceof Error
              ? larkResult.reason.message
              : String(larkResult.reason)
          ),
          lastAttemptAt: new Date().toISOString(),
          lastErrorAt: new Date().toISOString(),
        };
  return {
    ok: Boolean(usage?.status) && lark.ok,
    usage,
    lark,
  };
}

/**
 * The usage scan re-parses every session JSONL under ~/.claude + ~/.codex every
 * interval — on a heavy dev machine that is ~1GB of parsing per tick (~10s of
 * one full core), which users feel as periodic stutter ("一卡一卡"). Run the
 * worker at BelowNormal priority on Windows so the scan yields to interactive
 * work. Best-effort: priority change failure must never affect the worker.
 */
function lowerProcessPriorityOnWindows(): void {
  if (process.platform !== 'win32') return;
  try {
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${process.pid}).PriorityClass = 'BelowNormal'`,
      ],
      { stdio: 'ignore', windowsHide: true }
    );
  } catch {
    /* priority tweak is best-effort */
  }
}

async function runCli(): Promise<void> {
  lowerProcessPriorityOnWindows();
  if (process.argv.includes('--startup-once')) {
    const result = await runStartupOnce();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (process.argv.includes('--scan-once')) {
    const result = await scanUsageTelemetryWorkerOnce();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  await runUsageTelemetryWorker();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runCli().catch((err) => {
    process.stderr.write(
      `[AgentPanel] telemetry worker failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}
