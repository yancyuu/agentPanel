// usageCommand.mjs — `usage status | today | report | start | stop | autostart`
// and all supporting telemetry/worker lifecycle functions. Extracted from
// hermit.mjs to keep it under 3000 lines.
import {
  args,
  currentVersion,
  commandArgs,
  jsonRequested,
  port,
  hermitHome,
  telemetryDir,
  telemetryWorkerPidPath,
  telemetryWorkerStatusPath,
  telemetryWorkerLogPath,
  telemetryWorkerErrorLogPath,
  repoRoot,
  daemonLogPath,
} from './env.mjs';
import {
  printJson,
  ui,
  SPINNER_FRAMES,
  displayWidth,
  printCliRows,
} from './terminal.mjs';
import {
  fetchAuthoritativeUsage,
  fetchRemoteUsageStatus,
  normalizeUploadProviders,
  formatUploadProviders,
  uploadProviderLabel,
} from './usageRemote.mjs';
import { cursorPendingRows, formatNumber, localServerRows, serverUsageUnauthorized } from './usageRows.mjs';
import { resolveConversationUploadEnabled } from './uploadState.mjs';
import { absoluteProgressLabel, aggregateUploadProgress, foldFinishedBatches, uploadProgressLabel } from './usageProgress.mjs';
import {
  collectDaemonStatus,
  readPidFile,
  isPidRunning,
  listProcessesWin,
  stopFallbackProcesses,
  signalDaemon,
  waitForOpenHermitServerReady,
} from './daemon.mjs';
import { currentFeatureStates } from './featureState.mjs';
import { readHermitSettings, writeHermitSettings, safeReadJson } from './settings.mjs';
import {
  resolveConversationUploadBaseUrl,
  refreshOpenHermitAuthStatus,
  readOpenHermitAuthStatus,
} from './auth.mjs';
import { BRAND, brandLogPrefix } from '../branding.mjs';
import { rethrowIfExitSentinel } from './exitGuard.mjs';
import { checkExistingOpenHermitServer } from './runtime.mjs';
import { findAnyOptionValues } from './env.mjs';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs';
import { spawn, execFileSync, execSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Progress/display helpers (used internally) -------------------------------

function fitProgressLine(text) {
  const columns = Math.max(40, Number(process.stdout.columns || 80));
  const maxWidth = Math.max(20, columns - 2);
  if (displayWidth(text) <= maxWidth) return text;
  let result = '';
  for (const char of text) {
    if (displayWidth(`${result}${char}…`) > maxWidth) break;
    result += char;
  }
  return `${result}…`;
}

// --- Shared status structures -------------------------------------------------

export function larkStartupStatusRow(larkStatus) {
  if (!larkStatus) return null;
  if (larkStatus.enabled === false) return ['Lark 授权', '未启用（需要单独的高风险授权）', 'off'];
  return [
    'Lark 授权',
    larkStatus.ok ? `已批量上报 (${larkStatus.accountCount ?? 0} 个)` : `未上报: ${larkStatus.reason || ''}`,
    larkStatus.ok ? 'ok' : 'warn',
  ];
}

export function usageStartupModeText(larkStatus) {
  return larkStatus?.enabled === false
    ? '启动即上报用量，之后后台增量上报'
    : '启动即上报用量+Lark授权，之后后台增量上报';
}

export function emptyUsageTelemetryStatus() {
  return {
    connected: false,
    lastScan: null,
    sessions: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheCreation: 0,
    totalTokens: 0,
    recentMessages: 0,
    recentTokensTotal: 0,
    activeDays: 0,
    hourly: Array.from({ length: 24 }, () => 0),
    projects: [],
    workSecondsByDay: {},
    daily: {},
    localUsers: [],
    unresolvedUsage: { sessions: 0, messages: 0, tokensTotal: 0 },
  };
}

export function usageDaemonPayload(server) {
  return {
    running: Boolean(server?.running),
    url: server?.url || `http://127.0.0.1:${port}`,
    version: server?.version || '',
  };
}

// --- Upload status helpers ---------------------------------------------------

// Server channel status strings (succeeded / unknown / failed / never_reported)
// are protocol values, not user-facing labels — humanize so "unknown" during a
// first/in-flight upload reads as a normal waiting state instead of the alarming
// raw "unknown · 无服务端游标". Unrecognized values fall through verbatim so new
// server statuses stay visible.
function humanizeChannelStatus(status) {
  switch (status) {
    case 'succeeded':
      return '已上报';
    case 'unknown':
      return '上报中';
    case 'failed':
      return '上报失败';
    case 'never_reported':
      return '未上报';
    default:
      return status || '';
  }
}

export function cursorStatusText(channel = {}) {
  if (channel.hasCursor) {
    const parts = [`cursor ${String(channel.cursorHash || '').slice(0, 12)}`];
    // Label the count as a per-batch figure (本批), not a running total: this is
    // the message count of the last uploaded cursor batch (payload.messages.length),
    // which is far smaller than the cumulative server total and would otherwise
    // read like "total uploaded = 25" and contradict the 服务端（全量） row.
    if (Number.isFinite(channel.cursorMessageCount))
      parts.push(`本批 ${formatNumber(channel.cursorMessageCount)} msg`);
    if (channel.cursorGeneratedAt)
      parts.push(new Date(channel.cursorGeneratedAt).toLocaleString('zh-CN'));
    return parts.join(' · ');
  }
  // No committed server cursor yet. 'unknown' = the server hasn't confirmed one
  // (first upload / mid-batch) — normal, not broken. Other non-never_reported
  // statuses keep the dedup reminder.
  if (channel.status === 'unknown') return '等待服务端确认游标';
  if (channel.status && channel.status !== 'never_reported')
    return '无服务端游标 · 上报最近 7 天（服务端按 eventId 去重）';
  if (channel.attemptedCursorHash) {
    return `attempted ${String(channel.attemptedCursorHash).slice(0, 12)}${Number.isFinite(channel.attemptedCursorMessageCount) ? ` · 本批 ${formatNumber(channel.attemptedCursorMessageCount)} msg` : ''}`;
  }
  return '尚未提交 cursor';
}

function conversationUploadRows(auth = readOpenHermitAuthStatus(), remote = null) {
  const rows = [];

  if (remote) {
    const remoteChannels = Array.isArray(remote.channels) ? remote.channels : [];
    const remoteErrors = Array.isArray(remote.errors) ? remote.errors : [];
    if (remoteChannels.length) {
      for (const c of remoteChannels) {
        const parts = [
          humanizeChannelStatus(c.status),
          cursorStatusText(c),
          c.inFlight ? `处理中 ${c.inFlight}` : '',
          c.lastUploadId ? String(c.lastUploadId).slice(0, 12) : '',
        ].filter(Boolean);
        rows.push([
          `${uploadProviderLabel(c.platform)}/${c.scene || 'coding'}`,
          parts.join(' · '),
          c.inFlight ? 'warn' : 'info',
        ]);
      }
    } else {
      rows.push([
        '服务端状态',
        remoteErrors.length
          ? '读取 /report/usage/status 失败'
          : auth.authorized
            ? '等待读取 /report/usage/status'
            : '等待登录后读取 /report/usage/status',
        remoteErrors.length ? 'error' : 'info',
      ]);
    }
    for (const error of remoteErrors) {
      if (!error.platform) continue;
      const detail = error.httpStatus
        ? `HTTP ${error.httpStatus}${error.body ? ` · ${error.body}` : ''}`
        : error.error || '请求失败';
      rows.push([
        `${uploadProviderLabel(error.platform)}/${error.scene || 'coding'}`,
        `读取 /report/usage/status 失败：${detail}`,
        'error',
      ]);
    }
  }

  if (!auth.authorized) rows.push(['授权', '未登录，请在「用户」中登录', 'warn']);

  return rows;
}

function appendUsageServerRows(
  rows,
  { telemetry, authoritativeUsage, remoteUsage, upload, auth, uploadEnabled }
) {
  const usageUnauthorized = serverUsageUnauthorized(authoritativeUsage, remoteUsage);
  const loginExpired = usageUnauthorized && (!auth?.authorized || auth?.expired);
  rows.push(...localServerRows(telemetry, usageUnauthorized ? undefined : authoritativeUsage));
  rows.push(...cursorPendingRows(upload));
  if (loginExpired) {
    rows.push(['登录', '登录已失效，请重新登录', 'warn']);
  } else if (usageUnauthorized) {
    rows.push(['上报接口', '授权异常；本地登录态仍有效，请重试或检查 upload 授权', 'warn']);
    if (uploadEnabled) rows.push(...conversationUploadRows(auth, remoteUsage));
  } else if (uploadEnabled) {
    rows.push(...conversationUploadRows(auth, remoteUsage));
  }
  return { usageUnauthorized, loginExpired };
}

// --- Usage auth availability check -------------------------------------------

export function isUsageAuthUnavailable(result = {}) {
  if (serverUsageUnauthorized(result.authoritativeUsage, result.remoteUsage)) return true;
  const errors = [result.error, result.telemetry?.conversationUpload?.lastError]
    .filter((item) => item !== undefined && item !== null)
    .map(String);
  return errors.some((text) =>
    /HTTP\s*(401|403)|授权不可用|登录已过期|登录已失效|insufficient_scope|upload:read/u.test(text)
  );
}

export async function loginAfterUsageAuthExpired() {
  const { runAuthLogin } = await import('./auth.mjs');
  printCliRows(
    '登录已过期',
    [
      ['原因', '消息上报需要重新登录', 'warn'],
      ['下一步', '正在打开登录流程', 'info'],
    ],
    '登录完成后会回到用量上报菜单。'
  );
  await runAuthLogin({ exitOnDone: false, interactiveMenu: true });
}

// --- Worker log/offset helpers -----------------------------------------------

function readConversationUploadLogEvents(limit = 200) {
  if (!existsSync(telemetryWorkerLogPath)) return [];
  const lines = readFileSync(telemetryWorkerLogPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-limit);
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// --- Log tail helpers --------------------------------------------------------

function readLogChunkSince(filePath, offset) {
  try {
    const stat = statSync(filePath);
    const safeOffset = stat.size < offset ? 0 : offset;
    if (stat.size <= safeOffset) return { chunk: '', offset: stat.size };
    const raw = readFileSync(filePath, 'utf-8');
    return { chunk: raw.slice(safeOffset), offset: stat.size };
  } catch {
    return { chunk: '', offset };
  }
}

function printStartupLogChunk(chunk) {
  const lines = String(chunk || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-12);
  for (const line of lines) {
    process.stdout.write(`${ui.dim('│')} ${fitProgressLine(line)}\n`);
  }
}

export async function waitForOpenHermitServerReadyWithLogs(pid, timeoutMs = 30_000) {
  if (jsonRequested || !process.stdout.isTTY) return waitForOpenHermitServerReady(pid, timeoutMs);
  const startedAt = Date.now();
  let logOffset = 0;
  process.stdout.write(`${ui.dim('正在启动 Web 工作台，日志：')} ${daemonLogPath}\n`);
  while (Date.now() - startedAt < timeoutMs) {
    const log = readLogChunkSince(daemonLogPath, logOffset);
    logOffset = log.offset;
    if (log.chunk) printStartupLogChunk(log.chunk);

    if (pid && !isPidRunning(pid)) {
      return {
        ready: false,
        reason: '服务进程已退出，请查看日志',
        url: `http://127.0.0.1:${port}`,
      };
    }
    const server = await checkExistingOpenHermitServer();
    if (server.running) return { ready: true, ...server };
    process.stdout.write(`${ui.dim('… 等待 Web 服务就绪')}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return {
    ready: false,
    reason: '服务还没准备好，请稍后刷新或查看日志',
    url: `http://127.0.0.1:${port}`,
  };
}

// --- Usage task-bus settings helpers ----------------------------------------

// Exported for tests: old-config opt-in semantics are asserted in bin/lib/__tests__.
export function buildLocalUsageTaskBusConfig(current = {}) {
  const existing = current && typeof current === 'object' ? current : {};
  const redis =
    existing.redis && typeof existing.redis === 'object'
      ? existing.redis
      : { host: '127.0.0.1', port: 6379 };
  const existingTelemetry =
    existing.telemetry && typeof existing.telemetry === 'object' ? existing.telemetry : {};
  const { uploadEnabled: _legacyUploadEnabled, ...telemetryWithoutLegacy } = existingTelemetry;
  void _legacyUploadEnabled;
  const uploadProviders = normalizeUploadProviders(
    existingTelemetry.uploadProviders || ['claudecode', 'codex', 'pi']
  );
  const canonicalUpload = existingTelemetry.conversationUploadEnabled;
  const legacyUpload = existingTelemetry.conversations?.uploadEnabled;
  // 消息正文上报必须显式 opt-in：老配置缺 canonical 字段时不得默认补 true。
  const conversationUploadEnabled =
    typeof canonicalUpload === 'boolean'
      ? canonicalUpload
      : typeof legacyUpload === 'boolean'
        ? legacyUpload
        : false;
  return {
    ...existing,
    enabled: Boolean(existing.enabled),
    redis: {
      host: typeof redis.host === 'string' && redis.host.trim() ? redis.host : '127.0.0.1',
      port: Number.isFinite(Number(redis.port)) ? Number(redis.port) : 6379,
      ...(redis.password ? { password: redis.password } : {}),
      ...(redis.db !== undefined ? { db: redis.db } : {}),
    },
    telemetry: {
      ...telemetryWithoutLegacy,
      enabled: true,
      conversationUploadEnabled,
      uploadProviders,
      platform: uploadProviders[0] || existingTelemetry.platform || 'claudecode',
    },
  };
}

export function enableLocalUsageTelemetry() {
  const settings = readHermitSettings();
  const taskBus = buildLocalUsageTaskBusConfig(settings.taskBus);
  writeHermitSettings({ ...settings, taskBus });
  return taskBus;
}

export function disableLocalUsageTelemetry() {
  const settings = readHermitSettings();
  const existing = settings.taskBus && typeof settings.taskBus === 'object' ? settings.taskBus : {};
  const telemetry =
    existing.telemetry && typeof existing.telemetry === 'object' ? existing.telemetry : {};
  const taskBus = {
    ...existing,
    telemetry: {
      ...telemetry,
      enabled: false,
      platform: telemetry.platform || 'claudecode',
    },
  };
  writeHermitSettings({ ...settings, taskBus });
  return taskBus;
}

export function setConversationUploadEnabled(enabled, providers = null) {
  const selectedProviders = providers == null ? null : normalizeUploadProviders(providers);
  const settings = readHermitSettings();
  const existing = settings.taskBus && typeof settings.taskBus === 'object' ? settings.taskBus : {};
  const telemetry =
    existing.telemetry && typeof existing.telemetry === 'object' ? existing.telemetry : {};
  const uploadProviders =
    selectedProviders ??
    normalizeUploadProviders(telemetry.uploadProviders || ['claudecode', 'codex', 'pi']);
  const taskBus = {
    ...existing,
    telemetry: {
      ...telemetry,
      enabled: true,
      platform: uploadProviders[0] || telemetry.platform || 'claudecode',
      uploadProviders,
      conversationUploadEnabled: Boolean(enabled),
      conversations: {
        ...(telemetry.conversations && typeof telemetry.conversations === 'object'
          ? telemetry.conversations
          : {}),
        uploadEnabled: Boolean(enabled),
        baseUrl: resolveConversationUploadBaseUrl(telemetry.conversations?.baseUrl),
      },
    },
  };
  writeHermitSettings({ ...settings, taskBus });
  return taskBus;
}

// --- Provider selection -------------------------------------------------------

function getUploadProvidersFromFlags() {
  const values = findAnyOptionValues(['--upload-provider', '--provider', '--providers']);
  return normalizeUploadProviders(values).length
    ? normalizeUploadProviders(values)
    : ['claudecode', 'codex', 'pi'];
}

export async function enableConversationUploadWithProvider(
  providers = ['claudecode', 'codex', 'pi']
) {
  const selectedProviders = normalizeUploadProviders(providers);
  const enabledProviders = selectedProviders.length
    ? selectedProviders
    : ['claudecode', 'codex', 'pi'];
  const taskBus = setConversationUploadEnabled(true, enabledProviders);
  // Actually launch the background worker so the toggle is running, not just
  // "enabled + 未运行". Mirrors the `usage start` lifecycle: the worker reads
  // telemetry.enabled (set above) and scans immediately on boot, which also
  // refreshes the 本地（最近 7 天）row right away. Without this the menu showed
  // no checkmark + "未运行" because usageRunning stayed false after toggling ON.
  await enableUsageAutostart();
  await restartTelemetryWorkerIfStale({ quiet: true });
  const worker = await startTelemetryWorker({ quiet: true });
  return { taskBus, providers: enabledProviders, started: true, worker };
}

export async function reconcileEnabledTelemetryWorker() {
  const settings = readHermitSettings();
  const telemetry = settings.taskBus?.telemetry;
  if (!telemetry || !resolveConversationUploadEnabled(telemetry)) {
    return { reconciled: false, reason: 'upload disabled' };
  }
  const { status } = readTelemetryWorkerStatusFile();
  if (telemetryWorkerHealth(status).running) {
    return { reconciled: false, reason: 'worker healthy' };
  }
  await enableUsageAutostart();
  await clearStaleConversationUploadLock();
  const worker = await startTelemetryWorker({ quiet: true });
  return { reconciled: true, worker };
}

// --- Worker lifecycle ---------------------------------------------------------

import { telemetryWorkerChildArgs } from './telemetryWorker.mjs';

function latestUsageWorkerSourceMtime() {
  return Math.max(
    ...[
      'src/main/telemetry/worker.ts',
      'src/main/services/session-intelligence/UsageTelemetryService.ts',
      'src/main/services/session-intelligence/SessionUsageParser.ts',
      'src/main/services/session-intelligence/usageTypes.ts',
      'src/main/services/session-intelligence/ConversationMessageUploadService.ts',
      'src/main/services/session-intelligence/AiMonitorUsageClient.ts',
      'src/main/services/auth/OpenHermitAuthClient.ts',
    ].map((rel) => {
      try {
        return statSync(path.join(repoRoot, rel)).mtimeMs;
      } catch {
        return 0;
      }
    })
  );
}

export function markTelemetryWorkerRestarting(reason = '正在重启 worker') {
  try {
    mkdirSync(telemetryDir, { recursive: true, mode: 0o700 });
    const previous = readTelemetryWorkerStatusFile().status;
    writeFileSync(
      telemetryWorkerStatusPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          state: 'restarting',
          running: false,
          pid: null,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastScan: previous?.lastScan ?? null,
          source: 'claude-jsonl',
          telemetryEnabled: previous?.telemetryEnabled ?? true,
          restartReason: reason,
          telemetry: previous?.telemetry ?? emptyUsageTelemetryStatus(),
        },
        null,
        2
      )}\n`,
      { encoding: 'utf-8', mode: 0o600 }
    );
  } catch {}
}

function readTelemetryWorkerStatusFile() {
  if (!existsSync(telemetryWorkerStatusPath)) return { status: null, error: '' };
  const { value, error } = safeReadJson(telemetryWorkerStatusPath);
  if (error) return { status: null, error };
  return value && typeof value === 'object'
    ? { status: value, error: '' }
    : { status: null, error: 'invalid status file' };
}

function telemetryFromWorkerStatus(status) {
  return status?.telemetry && typeof status.telemetry === 'object'
    ? status.telemetry
    : emptyUsageTelemetryStatus();
}

// Called by update.mjs after self-update so the live worker picks up new code.
export async function restartUsageWorkerIfRunning({
  quiet = false,
  reason = 'update 后重载 worker',
} = {}) {
  const pid = readPidFile(telemetryWorkerPidPath);
  if (!pid || !isPidRunning(pid)) return { restarted: false, reason: 'no running worker' };
  return { restarted: true, ...(await restartTelemetryWorker({ quiet, reason })) };
}

export async function clearStaleConversationUploadLock() {
  const lockPath = path.join(telemetryDir, 'conversation-message-upload.lock');
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const lock = JSON.parse(raw);
    const pid = Number(lock.pid);
    const ageMs = Date.now() - Date.parse(lock.createdAt || '');
    let staleByPid = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch {
        staleByPid = true;
      }
    }
    if (staleByPid || (Number.isFinite(ageMs) && ageMs > 30 * 60 * 1000)) unlinkSync(lockPath);
  } catch {}
}

function workerNeedsRestart(status) {
  if (!status?.startedAt) return true;
  const health = telemetryWorkerHealth(status);
  if (!health.running) return true;
  const startedAt = Date.parse(status.startedAt);
  return !Number.isFinite(startedAt) || latestUsageWorkerSourceMtime() > startedAt;
}

async function restartTelemetryWorkerIfStale({ quiet = true } = {}) {
  const { status } = readTelemetryWorkerStatusFile();
  const pid = readPidFile(telemetryWorkerPidPath);
  if (!pid || !isUsageWorkerPid(pid) || !workerNeedsRestart(status)) return null;
  return restartTelemetryWorker({ quiet, reason: '源码已更新，正在重启 worker' });
}

export async function restartTelemetryWorker({ quiet = true, reason = '手动重启 worker' } = {}) {
  await stopTelemetryWorker();
  await clearStaleConversationUploadLock();
  markTelemetryWorkerRestarting(reason);
  return startTelemetryWorker({ quiet, forceRestart: true });
}

export function isUsageWorkerCommand(command) {
  const normalized = String(command || '').replace(/\\/g, '/').toLowerCase();
  return normalized.includes('telemetry/worker.ts') || normalized.includes('dist/telemetry-worker.bundle.mjs');
}

export function processListHasUsageWorkerPid(processes, pid) {
  return processes.some(
    (processInfo) => Number(processInfo?.pid) === Number(pid) && isUsageWorkerCommand(processInfo?.command)
  );
}

export function isUsageWorkerPid(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0 || !isPidRunning(Number(pid))) return false;
  if (process.env.OPENHERMIT_USAGE_WORKER_MODE === 'test' && Number(pid) === process.pid) return true;
  if (process.platform === 'win32') {
    try { return processListHasUsageWorkerPid(listProcessesWin(), pid); } catch { return false; }
  }
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
    return isUsageWorkerCommand(command);
  } catch {
    return false;
  }
}

function isTransientUsageWorkerCommand(command) {
  return ['--scan-once', '--startup-once', '--report-lark-credentials-once'].some((flag) =>
    command.includes(flag)
  );
}

function collectRunningUsageWorkerPids() {
  if (process.platform === 'win32') {
    try {
      return listProcessesWin()
        .filter(
          (p) =>
            p.pid !== process.pid &&
            isUsageWorkerCommand(p.command) &&
            !isTransientUsageWorkerCommand(p.command)
        )
        .map((p) => p.pid);
    } catch {
      return [];
    }
  }
  let output = '';
  try {
    output = execSync('ps -axo pid=,command=', { encoding: 'utf-8' });
  } catch {
    return [];
  }
  const pids = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+([\s\S]+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    const command = match[2];
    if (!isUsageWorkerCommand(command)) continue;
    if (isTransientUsageWorkerCommand(command)) continue;
    pids.push(pid);
  }
  return pids;
}

export async function startTelemetryWorker({
  quiet = false,
  forceRestart = false,
  startupPassCompleted = false,
} = {}) {
  let existingPid = readPidFile(telemetryWorkerPidPath);
  if (existingPid && isPidRunning(existingPid) && !isUsageWorkerPid(existingPid)) {
    removeTelemetryWorkerPidFile();
    existingPid = null;
  }
  for (const stray of collectRunningUsageWorkerPids()) {
    if (Number(stray) === Number(existingPid)) continue;
    if (isPidRunning(stray)) signalDaemon(stray, 'SIGKILL');
  }
  if (!forceRestart && existingPid && isPidRunning(existingPid)) {
    const { status } = readTelemetryWorkerStatusFile();
    if (telemetryWorkerHealth(status).running) {
      return { started: false, running: true, pid: existingPid, pidPath: telemetryWorkerPidPath, statusPath: telemetryWorkerStatusPath, logPath: telemetryWorkerLogPath };
    }
    signalDaemon(existingPid, 'SIGKILL');
    await waitForPidExit(existingPid, 3000);
    removeTelemetryWorkerPidFile();
  }

  if (process.env.OPENHERMIT_USAGE_WORKER_MODE === 'test') {
    mkdirSync(telemetryDir, { recursive: true, mode: 0o700 });
    try {
      try {
        unlinkSync(telemetryWorkerPidPath);
      } catch {}
      writeFileSync(telemetryWorkerPidPath, String(process.pid), {
        encoding: 'utf-8',
        mode: 0o600,
      });
    } catch {}
    writeFileSync(
      telemetryWorkerStatusPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          state: 'idle',
          running: true,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastScan: null,
          source: 'claude-jsonl',
          telemetryEnabled: true,
          telemetry: emptyUsageTelemetryStatus(),
        },
        null,
        2
      )}\n`,
      { encoding: 'utf-8', mode: 0o600 }
    );
    return {
      started: true,
      running: true,
      pid: process.pid,
      pidPath: telemetryWorkerPidPath,
      statusPath: telemetryWorkerStatusPath,
      logPath: telemetryWorkerLogPath,
      mode: 'test',
    };
  }

  mkdirSync(telemetryDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(telemetryWorkerLogPath), { recursive: true, mode: 0o700 });
  const out = openSync(telemetryWorkerLogPath, 'a');
  const err = openSync(telemetryWorkerErrorLogPath, 'a');
  const childArgs = await telemetryWorkerChildArgs();
  const child = spawn(process.execPath, childArgs, {
    cwd: repoRoot,
    // Same fix as daemon.mjs: the upload worker is a BACKGROUND service and
    // must outlive the launching terminal. Non-detached on Windows tied it to
    // the console's CTRL_CLOSE group, so closing the CLI terminal killed the
    // worker and the 消息上报 toggle looked "退出去就没了". detached +
    // windowsHide + stdio-to-file spawns no visible console (verified).
    detached: true,
    windowsHide: true,
    env: {
      ...process.env,
      HERMIT_HOME: hermitHome,
      ...(startupPassCompleted ? { HERMIT_USAGE_STARTUP_PASS_COMPLETED: '1' } : {}),
    },
    stdio: ['ignore', out, err],
  });
  child.unref();
  closeSync(out);
  closeSync(err);
  try {
    try {
      unlinkSync(telemetryWorkerPidPath);
    } catch {}
    writeFileSync(telemetryWorkerPidPath, String(child.pid), { encoding: 'utf-8', mode: 0o600 });
  } catch (e) {
    if (!quiet)
      console.error(`${brandLogPrefix()} 警告: 无法写入 ${telemetryWorkerPidPath}: ${e.message}`);
  }
  if (!quiet) console.error(`${brandLogPrefix()} usage telemetry worker started: pid ${child.pid}`);
  return {
    started: true,
    running: true,
    pid: child.pid,
    pidPath: telemetryWorkerPidPath,
    statusPath: telemetryWorkerStatusPath,
    logPath: telemetryWorkerLogPath,
  };
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidRunning(pid);
}

function removeTelemetryWorkerPidFile() {
  try {
    unlinkSync(telemetryWorkerPidPath);
  } catch {}
}

export async function stopTelemetryWorker() {
  const pid = readPidFile(telemetryWorkerPidPath);
  if (pid === process.pid && process.env.OPENHERMIT_USAGE_WORKER_MODE === 'test') {
    removeTelemetryWorkerPidFile();
    return { stopped: true, pid, running: false, mode: 'test' };
  }
  const targets = Array.from(new Set([
    ...(Number.isInteger(pid) && pid > 0 && isUsageWorkerPid(pid) ? [pid] : []),
    ...collectRunningUsageWorkerPids(),
  ]));
  if (targets.length === 0) {
    removeTelemetryWorkerPidFile();
    return { stopped: false, pid: null, running: false };
  }
  await stopFallbackProcesses(targets);
  removeTelemetryWorkerPidFile();
  return { stopped: true, pid, running: false };
}

// --- Foreground scan --------------------------------------------------------

/**
 * Foreground startup pass for `usage start`: spawns the TSX-backed worker with
 * `--startup-once`, which serially runs one usage telemetry scan and one Lark
 * credential batch report, then emits a single safe JSON object. This is the
 * synchronous, observable equivalent of one worker cycle, run before the
 * detached daemon starts so the user gets immediate feedback instead of waiting
 * for the first 5-minute background cycle. Lark failures surface as a sanitized
 * degraded status and never block daemon startup; a usage/Lark child process
 * failure (non-zero exit or invalid JSON) IS treated as a startup failure.
 */
async function runStartupOnceWorker() {
  const childArgs = await telemetryWorkerChildArgs(['--startup-once']);
  const child = spawn(process.execPath, childArgs, {
    cwd: repoRoot,
    env: { ...process.env, HERMIT_HOME: hermitHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let interrupted = false;
  const stopChild = () => {
    interrupted = true;
    if (child.pid && !child.killed) child.kill('SIGTERM');
    setTimeout(() => {
      if (child.pid && !child.killed) child.kill('SIGKILL');
    }, 2_000).unref();
  };
  process.prependOnceListener('SIGINT', stopChild);
  process.prependOnceListener('SIGTERM', stopChild);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  process.off('SIGINT', stopChild);
  process.off('SIGTERM', stopChild);
  if (interrupted) throw new Error('已取消本次启动上报，子进程已停止');
  if (code !== 0) throw new Error(stderr.trim() || `telemetry worker startup exited with ${code}`);
  const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}');
  return parsed;
}

async function runTelemetryWorkerScanOnce({
  localOnly = false,
  uploadDisabled = false,
  scanDisabled = false,
} = {}) {
  const childArgs = await telemetryWorkerChildArgs(['--scan-once']);
  const child = spawn(process.execPath, childArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HERMIT_HOME: hermitHome,
      HERMIT_USAGE_FOREGROUND_SCAN: '1',
      ...(localOnly ? { HERMIT_USAGE_FORCE_LOCAL_ONLY: '1' } : {}),
      ...(uploadDisabled ? { HERMIT_USAGE_UPLOAD_DISABLED: '1' } : {}),
      ...(scanDisabled ? { HERMIT_USAGE_SCAN_DISABLED: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let interrupted = false;
  const stopChild = () => {
    interrupted = true;
    if (child.pid && !child.killed) child.kill('SIGTERM');
    setTimeout(() => {
      if (child.pid && !child.killed) child.kill('SIGKILL');
    }, 2_000).unref();
  };
  process.prependOnceListener('SIGINT', stopChild);
  process.prependOnceListener('SIGTERM', stopChild);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  process.off('SIGINT', stopChild);
  process.off('SIGTERM', stopChild);
  if (interrupted) throw new Error('已取消本次扫描，子进程已停止');
  if (code !== 0) throw new Error(stderr.trim() || `telemetry worker scan exited with ${code}`);
  const parsed = JSON.parse(stdout.trim() || '{}');
  return parsed.status?.telemetry ? parsed.status.telemetry : emptyUsageTelemetryStatus();
}

async function scanUsageTelemetryOnce({ localOnly = false, uploadDisabled = false } = {}) {
  if (process.env.OPENHERMIT_USAGE_WORKER_MODE === 'test') {
    const { status } = readTelemetryWorkerStatusFile();
    const autostart = await getUsageAutostartStatus();
    return {
      daemon: usageDaemonPayload({ running: false, url: `http://127.0.0.1:${port}`, version: '' }),
      worker: telemetryWorkerPayload({ status, autostart }),
      telemetry: telemetryFromWorkerStatus(status),
      source: 'claude-jsonl',
    };
  }
  const telemetry = await runTelemetryWorkerScanOnce({ localOnly, uploadDisabled });
  const { status } = readTelemetryWorkerStatusFile();
  const autostart = await getUsageAutostartStatus();
  return {
    daemon: usageDaemonPayload({ running: false, url: `http://127.0.0.1:${port}`, version: '' }),
    worker: telemetryWorkerPayload({ status, autostart }),
    telemetry,
    source: 'claude-jsonl',
  };
}

const TELEMETRY_HEARTBEAT_STALE_MS = 15 * 60 * 1000;

function telemetryWorkerHealth(status = null) {
  const pid = readPidFile(telemetryWorkerPidPath);
  const processAlive = Boolean(pid && isPidRunning(pid));
  const statusPidMatches = Boolean(processAlive && status?.pid && Number(status.pid) === Number(pid));
  const updatedAtMs = Date.parse(status?.updatedAt || '');
  const heartbeatFresh =
    Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= TELEMETRY_HEARTBEAT_STALE_MS;
  return {
    pid,
    processAlive,
    statusPidMatches,
    heartbeatFresh,
    running: processAlive && statusPidMatches && heartbeatFresh && status?.running !== false,
  };
}

function telemetryWorkerPayload({ status = null, statusError = '', autostart = null } = {}) {
  const health = telemetryWorkerHealth(status);
  return {
    running: health.running,
    pid: health.running ? health.pid : null,
    processAlive: health.processAlive,
    statusPidMatches: health.statusPidMatches,
    heartbeatFresh: health.heartbeatFresh,
    pidfilePresent: Boolean(health.pid),
    pidPath: telemetryWorkerPidPath,
    statusPath: telemetryWorkerStatusPath,
    logPath: telemetryWorkerLogPath,
    errorLogPath: telemetryWorkerErrorLogPath,
    lastStatus: status,
    statusError,
    autostart,
  };
}

// --- Autostart (macOS launchd / Windows Task Scheduler) ---------------------

function usageLaunchdLabel() {
  return 'com.openhermit.telemetry';
}
function usageLaunchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${usageLaunchdLabel()}.plist`);
}
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function usageCliPath() {
  const packaged = path.join(repoRoot, 'bin', 'agentcli.mjs');
  return existsSync(packaged) ? packaged : fileURLToPath(import.meta.url);
}

export function buildUsageLaunchdPlist() {
  const pathValue = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>${usageLaunchdLabel()}</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${xmlEscape(process.execPath)}</string>\n\t\t<string>${xmlEscape(usageCliPath())}</string>\n\t\t<string>__telemetry-worker</string>\n\t</array>\n\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>\n\t\t<key>HERMIT_HOME</key>\n\t\t<string>${xmlEscape(hermitHome)}</string>\n\t\t<key>PATH</key>\n\t\t<string>${xmlEscape(pathValue)}</string>\n\t</dict>\n\t<key>RunAtLoad</key>\n\t<true/>\n\t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>\n\t<key>ThrottleInterval</key>\n\t<integer>30</integer>\n\t<key>StandardOutPath</key>\n\t<string>${xmlEscape(telemetryWorkerLogPath)}</string>\n\t<key>StandardErrorPath</key>\n\t<string>${xmlEscape(telemetryWorkerErrorLogPath)}</string>\n</dict>\n</plist>\n`;
}

function launchctlBestEffort(args) {
  if (process.env.OPENHERMIT_SKIP_LAUNCHCTL === '1') return { ok: true, output: 'skipped' };
  try {
    const output = execSync(`launchctl ${args.map((arg) => JSON.stringify(arg)).join(' ')}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

function usageWindowsTaskName() { return 'AgentCLI Usage Telemetry'; }
function usageWindowsTaskXmlPath() { return path.join(telemetryDir, 'usage-worker-task.xml'); }
function usageWindowsWrapperPath() { return path.join(telemetryDir, 'usage-worker.cmd'); }

export function buildUsageWindowsWrapper() {
  const pathValue = process.env.PATH || '';
  const escapeBatch = (value) => String(value).replace(/%/g, '%%').replace(/"/g, '""');
  return `@echo off\r\nchcp 65001 >nul\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "HERMIT_HOME=${escapeBatch(hermitHome)}"\r\nset "PATH=${escapeBatch(pathValue)}"\r\n"${escapeBatch(process.execPath)}" "${escapeBatch(usageCliPath())}" __telemetry-worker >> "${escapeBatch(telemetryWorkerLogPath)}" 2>> "${escapeBatch(telemetryWorkerErrorLogPath)}"\r\n`;
}

export function buildUsageWindowsTaskXml() {
  const wrapper = usageWindowsWrapperPath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>AgentCLI usage telemetry worker</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>cmd.exe</Command><Arguments>/d /s /c &quot;&quot;${xmlEscape(wrapper)}&quot;&quot;</Arguments></Exec></Actions>
</Task>\n`;
}

function schtasksBestEffort(args) {
  if (process.env.OPENHERMIT_SKIP_SCHTASKS === '1') return { ok: true, output: 'skipped' };
  const result = spawnSync('schtasks.exe', args, { encoding: 'utf-8', windowsHide: true });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

export async function getUsageAutostartStatus() {
  const label = usageLaunchdLabel();
  const plistPath = usageLaunchdPlistPath();
  if (process.platform === 'win32') {
    const taskName = usageWindowsTaskName();
    const query = schtasksBestEffort(['/Query', '/TN', taskName, '/FO', 'LIST', '/V']);
    return {
      supported: true,
      enabled: query.ok,
      loaded: query.ok,
      label: taskName,
      taskName,
      plistPath: usageWindowsTaskXmlPath(),
      message: query.ok ? undefined : query.output,
    };
  }
  if (process.platform !== 'darwin') return { supported: false, enabled: false, loaded: false, label, plistPath };
  const print = launchctlBestEffort(['print', `gui/${process.getuid?.() ?? ''}/${label}`]);
  return { supported: true, enabled: existsSync(plistPath), loaded: print.ok, label, plistPath };
}

export async function enableUsageAutostart() {
  const plistPath = usageLaunchdPlistPath();
  if (process.platform === 'win32') {
    mkdirSync(telemetryDir, { recursive: true, mode: 0o700 });
    writeFileSync(usageWindowsWrapperPath(), buildUsageWindowsWrapper(), 'utf-8');
    writeFileSync(usageWindowsTaskXmlPath(), buildUsageWindowsTaskXml(), 'utf-8');
    schtasksBestEffort([
      '/Create',
      '/F',
      '/TN',
      usageWindowsTaskName(),
      '/XML',
      usageWindowsTaskXmlPath(),
    ]);
    return getUsageAutostartStatus();
  }
  if (process.platform !== 'darwin') return getUsageAutostartStatus();
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(path.dirname(telemetryWorkerLogPath), { recursive: true, mode: 0o700 });
  writeFileSync(plistPath, buildUsageLaunchdPlist(), 'utf-8');
  const uid = process.getuid?.();
  if (uid !== undefined) {
    launchctlBestEffort(['bootout', `gui/${uid}`, plistPath]);
    launchctlBestEffort(['bootstrap', `gui/${uid}`, plistPath]);
    launchctlBestEffort(['enable', `gui/${uid}/${usageLaunchdLabel()}`]);
    launchctlBestEffort(['kickstart', '-k', `gui/${uid}/${usageLaunchdLabel()}`]);
  }
  return getUsageAutostartStatus();
}

async function keepUsageAutostartWithoutRunning() {
  const plistPath = usageLaunchdPlistPath();
  if (process.platform === 'win32') return enableUsageAutostart();
  if (process.platform !== 'darwin') return getUsageAutostartStatus();
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(path.dirname(telemetryWorkerLogPath), { recursive: true, mode: 0o700 });
  writeFileSync(plistPath, buildUsageLaunchdPlist(), 'utf-8');
  const uid = process.getuid?.();
  if (uid !== undefined) {
    launchctlBestEffort(['bootout', `gui/${uid}`, plistPath]);
    launchctlBestEffort(['enable', `gui/${uid}/${usageLaunchdLabel()}`]);
  }
  return getUsageAutostartStatus();
}

export async function disableUsageAutostart() {
  const plistPath = usageLaunchdPlistPath();
  const uid = process.getuid?.();
  if (process.platform === 'darwin' && uid !== undefined) launchctlBestEffort(['bootout', `gui/${uid}`, plistPath]);
  if (process.platform === 'win32') {
    schtasksBestEffort(['/Delete', '/F', '/TN', usageWindowsTaskName()]);
    try { unlinkSync(usageWindowsTaskXmlPath()); } catch {}
    try { unlinkSync(usageWindowsWrapperPath()); } catch {}
  }
  try { unlinkSync(plistPath); } catch {}
  return getUsageAutostartStatus();
}

// --- Progress bars -----------------------------------------------------------

async function withCliProgress(label, task) {
  if (jsonRequested || !process.stdout.isTTY) return task();
  const frames = SPINNER_FRAMES;
  let index = 0;
  process.stdout.write(`${ui.dim(frames[index])} ${label}`);
  const timer = setInterval(() => {
    index = (index + 1) % frames.length;
    process.stdout.write(`\r${ui.dim(frames[index])} ${label}`);
  }, 120);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    // Use \x1b[2K\x1b[0G to erase line and move cursor to column 0, then newline.
    // This is more reliable than printing spaces whose count may not cover the full line.
    const columns = Number(process.stdout.columns) || 80;
    process.stdout.write(`\x1b[2K\x1b[0G${' '.repeat(Math.min(columns - 1, 60))}\r\n`);
  }
}

async function withUploadProgress(label, task, { fullRescan = false } = {}) {
  if (jsonRequested || !process.stdout.isTTY) return task();
  const sinceMs = Date.now() - 1000;
  const frames = SPINNER_FRAMES;
  let frame = 0;
  const startedAt = Date.now();
  let finishedSeen = new Map();
  process.stdout.write(`${ui.dim(label)}\n`);
  const render = () => {
    const events = readConversationUploadLogEvents().filter(
      (event) => Date.parse(event?.timestamp || '') >= sinceMs
    );
    const snapshot = aggregateUploadProgress(events);
    const acc = foldFinishedBatches(events, finishedSeen);
    finishedSeen = acc.seen;
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    const idle =
      !snapshot.hasBatch &&
      Number(snapshot.discovered ?? 0) <= 0 &&
      Number(snapshot.scanFiles ?? 0) <= 0;
    const bar = idle
      ? `扫描本地会话日志中 · 已用时 ${elapsedSec}s`
      : fullRescan
        ? absoluteProgressLabel(
            { ...snapshot, completedBatches: acc.completedBatches, runUploaded: acc.runUploaded },
            { elapsedSec }
          )
        : uploadProgressLabel(snapshot, { barWidth: 26 });
    const text = fitProgressLine(`${frames[frame]} ${bar}`);
    process.stdout.write(`\r\x1b[2K${text}`);
    frame = (frame + 1) % frames.length;
  };
  render();
  const timer = setInterval(render, 500);
  const stdin = process.stdin;
  const hadRawMode = stdin.isTTY && stdin.isRaw === true;
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(false);
    } catch {}
  }
  try {
    return await task();
  } finally {
    clearInterval(timer);
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      try {
        stdin.setRawMode(hadRawMode);
      } catch {}
    }
    process.stdout.write('\r\x1b[2K\x1b[1A\x1b[2K');
  }
}

// --- Foreground scan sequence ------------------------------------------------

async function runForegroundScan({ fullRescan = false, progressText }) {
  const workerPid = readPidFile(telemetryWorkerPidPath);
  const workerWasRunning =
    (Number.isInteger(workerPid) && workerPid > 0 && isPidRunning(workerPid)) ||
    collectRunningUsageWorkerPids().some((p) => isPidRunning(p));
  if (workerWasRunning) await stopTelemetryWorker();
  if (fullRescan) process.env.HERMIT_USAGE_FULL_RESCAN = '1';
  try {
    return await withUploadProgress(
      progressText,
      () => readUsageStatus({ scan: true, localOnly: false }),
      { fullRescan }
    );
  } finally {
    if (fullRescan) delete process.env.HERMIT_USAGE_FULL_RESCAN;
    if (workerWasRunning) await startTelemetryWorker({ quiet: true });
  }
}

// --- Backend usage status ----------------------------------------------------

async function fetchBackendUsageStatus() {
  const daemon = await collectDaemonStatus();
  if (!daemon.server?.running) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/telemetry/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const telemetry = await res.json();
    const autostart = await getUsageAutostartStatus();
    return {
      daemon: usageDaemonPayload(daemon.server),
      worker: telemetryWorkerPayload({ status: null, autostart }),
      telemetry,
      source: 'backend-api',
    };
  } catch {
    return null;
  }
}

// --- Read usage status --------------------------------------------------------

export async function readUsageStatus({
  scan = false,
  localOnly = false,
  uploadDisabled = false,
  includeRemote = !localOnly,
} = {}) {
  let base;
  if (scan) {
    base = await scanUsageTelemetryOnce({ localOnly, uploadDisabled });
  } else {
    const backend = await fetchBackendUsageStatus();
    if (backend) {
      base = backend;
    } else {
      const { status, error } = readTelemetryWorkerStatusFile();
      const autostart = await getUsageAutostartStatus();
      base = {
        daemon: usageDaemonPayload({
          running: false,
          url: `http://127.0.0.1:${port}`,
          version: '',
        }),
        worker: telemetryWorkerPayload({ status, statusError: error, autostart }),
        telemetry: telemetryFromWorkerStatus(status),
        source: 'claude-jsonl',
      };
    }
  }
  if (includeRemote) {
    const [remote, authoritative] = await Promise.all([
      fetchRemoteUsageStatus(currentFeatureStates().uploadProviders),
      fetchAuthoritativeUsage(),
    ]);
    base.remoteUsage = remote;
    base.authoritativeUsage = authoritative;
  }
  return base;
}

// --- Shared print helpers -----------------------------------------------------

async function printUsageRows(title, data, hint) {
  const states = currentFeatureStates();
  const auth = await refreshOpenHermitAuthStatus();
  const uploadRaw = data.telemetry.conversationUpload;
  const upload =
    uploadRaw && typeof uploadRaw === 'object' ? { ...uploadRaw, lastError: '' } : uploadRaw;
  // 上报状态权威开关：telemetry.enabled（与菜单/worker gate 同一语义）
  const uploadEnabled = Boolean(states.usageReportingEnabled);
  const workerText = states.usageRunning
    ? `后台运行中 (pid ${states.usagePid})，每 5 分钟增量扫描`
    : '后台未运行';
  const uploadText = uploadEnabled
    ? auth.authorized
      ? workerText
      : `${workerText}，等待登录授权`
    : '关闭';
  const rows = [
    ['版本', `agentcli v${currentVersion}`, 'info'],
    [
      '消息上报',
      uploadText,
      uploadEnabled ? (auth.authorized ? (states.usageRunning ? 'ok' : 'warn') : 'warn') : 'off',
    ],
  ];
  const serverAuth = appendUsageServerRows(rows, {
    telemetry: data.telemetry,
    authoritativeUsage: data.authoritativeUsage,
    remoteUsage: data.remoteUsage,
    upload,
    auth,
    uploadEnabled,
  });
  printCliRows(
    title,
    rows,
    serverAuth.loginExpired
      ? '服务端确认登录已失效。进入「用户」登录（命令行：agentcli auth login）后重试。'
      : serverAuth.usageUnauthorized
        ? '本地登录态仍有效，但上报接口返回未授权；请稍后重试，或重新登录刷新 upload 授权。'
        : hint || '待上报来自服务端 cursor 扫描结果；本地/服务端总账只作诊断对比。'
  );
}

// --- Command entries ----------------------------------------------------------

export async function printUsageStatus({ exitOnDone = true } = {}) {
  try {
    const data = await withCliProgress('正在读取用量上报状态...', () =>
      readUsageStatus({ scan: false, uploadDisabled: true, includeRemote: true })
    );
    const result = { ok: true, command: 'usage status', hermitHome, ...data };
    if (jsonRequested) printJson(result);
    await printUsageRows(
      '用量上报状态',
      data,
      data.daemon.running ? '触发扫描：agentcli usage report' : '启动本地采集：agentcli usage start'
    );
    if (exitOnDone) process.exit(0);
    return result;
  } catch (err) {
    rethrowIfExitSentinel(err);
    const result = {
      ok: false,
      command: 'usage status',
      hermitHome,
      error: err instanceof Error ? err.message : String(err),
    };
    if (jsonRequested) printJson(result, 1);
    console.error(`${brandLogPrefix()} usage status 失败：${result.error}`);
    if (exitOnDone) process.exit(1);
    return result;
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function todayUsageFromStatus(status) {
  const date = todayKey();
  const daily = status.daily?.[date];
  return {
    date,
    sessions: daily?.sessions ?? 0,
    messages: daily?.messages ?? 0,
    tokensIn: daily?.tokensIn ?? 0,
    tokensOut: daily?.tokensOut ?? 0,
    cacheRead: daily?.cacheRead ?? 0,
    cacheCreation: daily?.cacheCreation ?? 0,
    totalTokens: daily?.tokensTotal ?? 0,
    workSeconds: daily?.workSeconds ?? status.workSecondsByDay?.[date] ?? 0,
  };
}

export async function printUsageToday({ exitOnDone = true } = {}) {
  try {
    const data = await readUsageStatus({ scan: false });
    const today = todayUsageFromStatus(data.telemetry);
    const result = {
      ok: true,
      command: 'usage today',
      hermitHome,
      daemon: data.daemon,
      worker: data.worker,
      source: data.source,
      today,
    };
    if (jsonRequested) printJson(result);
    printCliRows(
      '今日用量',
      [
        ['日期', today.date],
        ['后台扫描', data.worker?.running ? `运行中 (pid ${data.worker.pid})` : '未运行'],
        ['会话数', formatNumber(today.sessions)],
        ['消息数', formatNumber(today.messages)],
        ['Token 总量', formatNumber(today.totalTokens)],
        ['工作时长（秒）', formatNumber(today.workSeconds)],
        ['来源', 'Claude Code 本地消息记录'],
      ],
      data.daemon.running ? '刷新统计：agentcli usage report' : '启动本地采集：agentcli usage start'
    );
    if (exitOnDone) process.exit(0);
    return result;
  } catch (err) {
    rethrowIfExitSentinel(err);
    const result = {
      ok: false,
      command: 'usage today',
      hermitHome,
      error: err instanceof Error ? err.message : String(err),
    };
    if (jsonRequested) printJson(result, 1);
    console.error(`${brandLogPrefix()} usage today 失败：${result.error}`);
    if (exitOnDone) process.exit(1);
    return result;
  }
}

export async function printUsageReport({ exitOnDone = true } = {}) {
  try {
    const auth = await refreshOpenHermitAuthStatus();
    const states = currentFeatureStates();
    if (states.conversationUploadEnabled && !auth.authorized) {
      const result = {
        ok: false,
        command: 'usage report',
        hermitHome,
        error: `${BRAND.stylizedName} login required for message upload`,
        auth: { authorized: false },
        upload: { enabled: true, authorized: false },
      };
      if (jsonRequested) printJson(result, 1);
      printCliRows(
        '用量上报报告',
        [
          ['消息上报', '已开启，但未登录', 'warn'],
          ['本次扫描', '已取消，避免扫描后无法上报', 'warn'],
          ['下一步', '进入「用户」登录（命令行：agentcli auth login）', 'info'],
        ],
        '在「用户」中登录后再扫描上报，会按服务端 cursor 只扫描新增消息。'
      );
      if (exitOnDone) process.exit(1);
      return result;
    }
    const fullRescan = commandArgs.includes('--full');
    const data = await runForegroundScan({
      fullRescan,
      progressText: fullRescan
        ? '正在重扫并重传最近 7 天（--full，服务端按 eventId 去重，请勿退出）...'
        : '正在执行一次增量扫描并按需上报，请勿退出...',
    });
    const upload = data.telemetry.conversationUpload;
    const result = {
      ok: true,
      command: 'usage report',
      hermitHome,
      localOnly: false,
      upload: {
        enabled: Boolean(upload?.enabled),
        authorized: auth.authorized,
        attempted: upload?.attempted || 0,
        accepted: upload?.accepted || 0,
        duplicated: upload?.duplicated || 0,
        rejected: upload?.rejected || 0,
      },
      ...data,
    };
    if (jsonRequested) printJson(result);
    await printUsageRows(
      '用量上报报告',
      data,
      '已执行一次增量扫描；消息上报开启时会按服务端 cursor 只扫描新增消息。'
    );
    if (exitOnDone) process.exit(0);
    return result;
  } catch (err) {
    rethrowIfExitSentinel(err);
    const result = {
      ok: false,
      command: 'usage report',
      hermitHome,
      error: err instanceof Error ? err.message : String(err),
    };
    if (jsonRequested) printJson(result, 1);
    console.error(`${brandLogPrefix()} usage report 失败：${result.error}`);
    if (exitOnDone) process.exit(1);
    return result;
  }
}

export async function printScanOnceResult({ exitOnDone = true, fullRescan = false } = {}) {
  const title = fullRescan ? '立即全量上报' : '立即扫描并上报一次';
  try {
    const auth = await refreshOpenHermitAuthStatus();
    const states = currentFeatureStates();
    if (states.conversationUploadEnabled && !auth.authorized) {
      const result = {
        ok: false,
        command: 'scan-once',
        hermitHome,
        auth: { authorized: false },
        upload: { enabled: true, authorized: false },
      };
      if (jsonRequested) printJson(result, 1);
      printCliRows(
        title,
        [
          ['消息上报', '已开启，但未登录', 'warn'],
          ['本次扫描', '已取消，避免扫描后无法上报', 'warn'],
          ['下一步', '进入「用户」登录（命令行：agentcli auth login）', 'info'],
        ],
        '在「用户」中登录后再执行，会按服务端 cursor 只扫描新增消息。'
      );
      if (exitOnDone) process.exit(1);
      return result;
    }

    const data = await runForegroundScan({
      fullRescan,
      progressText: fullRescan
        ? '正在重扫并重传最近 7 天（服务端按 eventId 去重，请勿退出）...'
        : '正在执行一次增量扫描并按需上报，请勿退出...',
    });

    const upload = data.telemetry?.conversationUpload || {};
    const attempted = Number(upload.attempted || 0);
    const accepted = Number(upload.accepted || 0);
    const after = currentFeatureStates();
    const workerText = after.usageRunning
      ? `后台运行中 (pid ${after.usagePid})，每 5 分钟继续增量扫描`
      : '后台未运行';

    const rows = [];
    const uploadError =
      typeof upload.lastError === 'string' && upload.lastError ? upload.lastError : '';
    rows.push([
      '本次上报',
      accepted > 0
        ? `${formatNumber(accepted)} 条消息已上传${attempted !== accepted ? ` · 尝试 ${formatNumber(attempted)}` : ''}`
        : uploadError
          ? `上报失败：${uploadError}`
          : fullRescan
            ? '无消息可上报（服务端已全部入库）'
            : '无新增消息',
      accepted > 0 ? 'ok' : uploadError ? 'error' : 'info',
    ]);
    const serverAuth = appendUsageServerRows(rows, {
      telemetry: data.telemetry,
      authoritativeUsage: data.authoritativeUsage,
      remoteUsage: data.remoteUsage,
      upload,
      auth,
      uploadEnabled: true,
    });
    rows.push(['消息上报', workerText, after.usageRunning ? 'ok' : 'warn']);

    const result = { ok: true, command: 'scan-once', hermitHome, ...data };
    if (jsonRequested) printJson(result);
    printCliRows(
      title,
      rows,
      serverAuth.loginExpired
        ? '服务端确认登录已失效。进入「用户」登录（命令行：agentcli auth login）后重试。'
        : serverAuth.usageUnauthorized
          ? '本地登录态仍有效，但上报接口返回未授权；请稍后重试，或重新登录刷新 upload 授权。'
          : fullRescan
            ? '重报忽略游标、仅最近 7 天；服务端按 eventId 去重，已入库的消息不会重复计数。'
            : '待上报来自本次按服务端 cursor 扫描后尚未成功提交的消息数。'
    );
    if (exitOnDone) process.exit(0);
    return result;
  } catch (err) {
    rethrowIfExitSentinel(err);
    const result = {
      ok: false,
      command: 'scan-once',
      hermitHome,
      error: err instanceof Error ? err.message : String(err),
    };
    if (jsonRequested) printJson(result, 1);
    console.error(`${brandLogPrefix()} 扫描失败：${result.error}`);
    if (exitOnDone) process.exit(1);
    return result;
  }
}

export async function printUsageStart({ exitOnDone = true } = {}) {
  const autostartRequested = !commandArgs.includes('--no-autostart');
  const shouldEnableConversationUpload =
    args.includes('--upload') || args.includes('--upload-conversations');
  if (shouldEnableConversationUpload) {
    const providers = getUploadProvidersFromFlags();
    setConversationUploadEnabled(providers.length > 0, providers);
  }
  await restartTelemetryWorkerIfStale({ quiet: jsonRequested });
  const taskBus = enableLocalUsageTelemetry();

  // Foreground startup pass: synchronously run one usage scan + one Lark batch
  // report before daemonizing, so `usage start` immediately uploads (matching one
  // worker cycle) instead of waiting for the first background tick. A failure to
  // run the child is a command failure; a Lark-only failure is surfaced but does
  // not block the daemon.
  let startup;
  let startupError;
  try {
    startup = await runStartupOnceWorker();
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
  }
  if (startupError) {
    const result = {
      ok: false,
      command: 'usage start',
      hermitHome,
      error: startupError,
      telemetry: { localScanEnabled: true, source: 'claude-jsonl' },
    };
    if (jsonRequested) printJson(result);
    else console.error(`${brandLogPrefix()} 启动上报失败: ${startupError}`);
    if (exitOnDone) process.exit(1);
    return result;
  }

  const worker = await startTelemetryWorker({
    quiet: jsonRequested,
    startupPassCompleted: true,
  });
  const autostart = autostartRequested
    ? await enableUsageAutostart()
    : await getUsageAutostartStatus();
  const result = {
    ok: true,
    command: 'usage start',
    hermitHome,
    worker,
    daemon: usageDaemonPayload({ running: false, url: `http://127.0.0.1:${port}`, version: '' }),
    autostart,
    telemetry: { localScanEnabled: true, source: 'claude-jsonl' },
    auth: { authorized: readOpenHermitAuthStatus().authorized },
    startup,
  };
  if (jsonRequested) printJson(result);
  const auth = readOpenHermitAuthStatus();
  const conversationUploadEnabled = Boolean(taskBus.telemetry?.conversationUploadEnabled);
  const featureProviders = currentFeatureStates().uploadProviders;
  const attributionProviders = featureProviders?.length
    ? featureProviders
    : ['claudecode', 'codex', 'pi'];
  const larkStatus = startup?.lark;
  const larkRow = larkStartupStatusRow(larkStatus);
  const rows = [
    [
      '消息上报',
      conversationUploadEnabled
        ? auth.authorized
          ? `开启（pid ${worker.pid}）`
          : `等待登录（pid ${worker.pid}）`
        : '关闭',
      conversationUploadEnabled ? (auth.authorized ? 'ok' : 'warn') : 'off',
    ],
    ['日志', worker.logPath, 'info'],
    ['开机自启', autostart.enabled ? '开启' : '关闭', autostart.enabled ? 'ok' : 'off'],
    ['模式', usageStartupModeText(larkStatus), 'info'],
    ['归因', `${formatUploadProviders(attributionProviders)} + IM 会话归因`, 'info'],
  ];
  if (larkRow) rows.splice(1, 0, larkRow);
  printCliRows(
    '消息上报后台已启动',
    rows,
    conversationUploadEnabled
      ? '消息上报已执行首次同步上报；需要登录后用 Bearer 授权发送。'
      : '消息上报已执行首次同步上报；会话内容上报当前关闭。'
  );
  if (exitOnDone) process.exit(0);
  return result;
}

export async function printUsageStop({ exitOnDone = true } = {}) {
  const disableAutostart = !commandArgs.includes('--keep-autostart');
  const taskBus = disableLocalUsageTelemetry();
  const worker = await stopTelemetryWorker();
  const autostart = disableAutostart
    ? await disableUsageAutostart()
    : await keepUsageAutostartWithoutRunning();
  const result = {
    ok: true,
    command: 'usage stop',
    hermitHome,
    worker,
    autostart,
    telemetry: { localScanEnabled: taskBus.telemetry?.enabled ?? false },
  };
  if (jsonRequested) printJson(result);
  printCliRows(
    '消息上报后台已停止',
    [
      [
        'worker',
        worker.stopped ? `已停止 (pid ${worker.pid})` : '未运行',
        worker.stopped ? 'off' : 'info',
      ],
      ['开机自启', autostart.enabled ? '仍开启' : '已关闭', autostart.enabled ? 'warn' : 'ok'],
    ],
    autostart.enabled
      ? 'worker 已停止，但开机自启仍开启；下次开机 worker 会重新启动。'
      : 'worker 已停止，开机自启已关闭。'
  );
  if (exitOnDone) process.exit(0);
  return result;
}

export async function printUsageAutostart({ exitOnDone = true } = {}) {
  const action = commandArgs[2] || 'status';
  if (action === 'status') {
    const status = await getUsageAutostartStatus();
    const result = { ok: true, command: 'usage autostart status', hermitHome, autostart: status };
    if (jsonRequested) printJson(result);
    printCliRows(
      'usage autostart 状态',
      [
        [
          '平台支持',
          status.supported ? '支持' : '不支持（仅 macOS）',
          status.supported ? 'ok' : 'warn',
        ],
        ['开机自启', status.enabled ? '已开启' : '未开启', status.enabled ? 'ok' : 'off'],
        [
          'launchd',
          status.loaded ? `已加载 (${status.label})` : '未加载',
          status.loaded ? 'ok' : 'warn',
        ],
      ],
      status.supported
        ? '开机自启通过 launchd 管理，重启后自动恢复后台采集。'
        : '仅 macOS 支持开机自启功能；其他平台请手动启动。'
    );
    if (exitOnDone) process.exit(0);
    return result;
  }
  if (action === 'enable') {
    const status = await enableUsageAutostart();
    const result = { ok: true, command: 'usage autostart enable', hermitHome, autostart: status };
    if (jsonRequested) printJson(result);
    printCliRows(
      'usage autostart 已开启',
      [
        ['launchd', `已安装 (${status.label})`, 'ok'],
        ['下次开机', '自动启动 usage worker', 'info'],
      ],
      '已配置 launchd，下次开机自动启动。'
    );
    if (exitOnDone) process.exit(0);
    return result;
  }
  if (action === 'disable') {
    const status = await disableUsageAutostart();
    const result = { ok: true, command: 'usage autostart disable', hermitHome, autostart: status };
    if (jsonRequested) printJson(result);
    printCliRows(
      'usage autostart 已关闭',
      [
        ['launchd', '已移除', 'off'],
        ['下次开机', '不自动启动 usage worker', 'info'],
      ],
      'launchd 已卸载，下次开机不会自动启动。'
    );
    if (exitOnDone) process.exit(0);
    return result;
  }
  if (jsonRequested)
    printJson({ ok: false, command: 'usage autostart', error: `Unknown action: ${action}` }, 1);
  console.error(
    `${brandLogPrefix()} usage autostart: unknown action '${action}' (expected status|enable|disable)`
  );
  if (exitOnDone) process.exit(1);
}
