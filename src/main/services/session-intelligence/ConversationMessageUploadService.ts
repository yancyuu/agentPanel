import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import {
  authedFetch,
  getValidBearerToken,
  refreshAccessToken,
} from '@main/services/auth/OpenHermitAuthClient';
import { getProjectsBasePath } from '@main/utils/pathDecoder';
// Single source for the cloud host/port default — change it in
// src/shared/constants/cloudConfig.mjs only.
import {
  DEFAULT_OPENHERMIT_CLOUD_BASE_URL,
  migrateLegacyCloudBaseUrl,
} from '@shared/constants/cloudConfig.mjs';

import { codexEventTimestamp, CodexUsageAccumulator } from './codexTokenUsage';
import { resolveUsageTotalTokens } from './tokenUsageTotals';

import type { CodexUsage } from './codexTokenUsage';
interface ConversationUploadTelemetryConfig {
  enabled?: boolean;
  platform?: UploadPlatform;
  uploadProviders?: UploadPlatform[];
  conversationUploadEnabled?: boolean;
  conversations?: {
    uploadEnabled?: boolean;
    batchSize?: number;
    uploadBatchSize?: number;
    uploadBatchDelayMs?: number;
    fullRescanWindowSize?: number;
    // Hours back the PERIODIC first-run scan will collect (no server cursor yet).
    // Bounds the initial backfill so a never-reported channel doesn't try to upload
    // all history at once. 0 = no floor (collect everything). A manual full rescan
    // and any run that already has a server cursor ignore this (cursor resumes).
    uploadSinceHours?: number;
    baseUrl?: string;
  };
}

interface ConversationUploadConfig {
  telemetry?: ConversationUploadTelemetryConfig;
}

const UPLOAD_LOCK_FILE = 'conversation-message-upload.lock';
const UPLOAD_LOG_FILE = 'conversation-upload.log';
// `reporter` (channel-isolation key, sent in the body) and the matching filter
// used to find THIS client's channel in /report/usage/status responses must stay
// in sync — both derive from SOURCE. Value is the product name (an open string);
// the API doc's 'report' is only a generic example. Changing it moves new data to
// a new server-side channel, isolated from any history stored under the old value.
const SOURCE = 'agentcli' as const;
const API_TIMEOUT_MS = 8_000;
// Uploading a batch is a heavy server-side write (N messages with usage +
// dedup). 8s is plenty for auth/usage-status reads but routinely times out a
// 100- or 500-message batch → HTTP 599, which left claudecode stuck on the
// same failing batch forever (cursor never advanced, full rescan retried the
// identical window every time). Give uploads their own longer timeout.
const UPLOAD_TIMEOUT_MS = 60_000;
// Unified upload endpoint for local coding (Claude Code / Codex / Pi) usage. Each
// message carries its own project/conversation context; scene is always `coding`.
const UPLOAD_ENDPOINT = '/api/v1/report/messages';
// Fallback content for usage-bearing turns that carry neither readable text nor
// a tool_use name (e.g. tool-result rows, thinking-only turns). The wire
// contract requires `message.content`, so those turns get this fixed
// placeholder; text turns ship full text and tool-use turns ship the tool name.
const REPORTED_CONTENT_PLACEHOLDER = '[usage only]';
const SCAN_PROGRESS_FILE_INTERVAL = 25;
const SCAN_PROGRESS_MIN_INTERVAL_MS = 1_000;
const SCAN_YIELD_FILE_INTERVAL = 25;
const SCAN_LINE_YIELD_INTERVAL = 500;

export interface ConversationUploadStatus {
  enabled: boolean;
  endpointConfigured: boolean;
  totalDiscovered?: number;
  skippedAlreadyUploaded?: number;
  pending?: number;
  pendingTokens?: number;
  attempted: number;
  accepted: number;
  duplicated: number;
  rejected: number;
  inserted?: number;
  failed?: number;
  queued?: number;
  uploadIds?: string[];
  lastUploadStatus?: string;
  lastReceiptId?: string;
  lastStatusUrl?: string;
  lastError?: string;
}

type UploadPlatform = 'claudecode' | 'codex' | 'pi';

interface UploadMessage {
  kind: 'conversation_message';
  eventId: string;
  reportedAt: string;
  // Per-message context, kept on each message as collected. The unified contract
  // allows per-message project/conversation (message-level wins over a top-level
  // fallback), so nothing is stripped or hoisted.
  project?: {
    projectRef: string;
    name?: string;
    pathHash?: string;
  };
  conversation?: {
    conversationId: string;
    sessionRef: string;
    startedAt?: string;
  };
  message: {
    messageRef: string;
    parentRef: string | null;
    role: 'user' | 'assistant';
    occurredAt?: string;
    modelName?: string;
    content: string;
    contentFormat: 'text' | 'markdown';
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      totalTokens: number;
    };
  };
}

interface CursorFileRange {
  fileKey: string;
  pathHash: string;
  size: number;
  mtimeMs: number;
  fromOffset: number;
  toOffset: number;
}

interface ClientCursor {
  schemaVersion: 1;
  purpose: 'local-jsonl-scan-position';
  transactionId: string;
  baseCursorHash: string;
  targetCursorHash: string;
  fileCount: number;
  messageCount: number;
  generatedAt: string;
  files: CursorFileRange[];
}

interface UploadPayload {
  schemaVersion: 1;
  generatedAt: string;
  reporter: string;
  // `client.tool` declares the producing tool explicitly (claudecode/codex); the
  // server registers it as the channel key with no model→platform inference.
  // 新协议 ReportClient 仅允许 {tool}（additionalProperties:false）：禁止 version /
  // instanceId 等附加字段，否则服务端返回 422。类型即契约——这里收紧后无法再
  // 表达会触发 422 的负载。
  client: { tool: string };
  // scene is always `coding` — local Claude Code / Codex turns only.
  scene: 'coding';
  clientCursor?: ClientCursor;
  // Unified contract: project/conversation/im may live per-message (message-level
  // wins) OR at top-level as a fallback. Collected messages always carry their own
  // context, so the payload base leaves these absent.
  project?: UploadMessage['project'];
  conversation?: UploadMessage['conversation'];
  messages: UploadMessage[];
}

interface UploadReceipt {
  ok?: boolean;
  uploadId?: string;
  receiptId?: string;
  status?: string;
  received?: number;
  acceptedForProcessing?: number;
  duplicatedAtReceive?: number;
  rejectedAtReceive?: number;
  statusUrl?: string;
  detailUrl?: string;
  errors?: unknown;
}

interface ServerCursorFileState {
  fileKey: string;
  pathHash: string;
  size: number;
  mtimeMs: number;
  fromOffset?: number;
  toOffset: number;
}

interface ServerCursor {
  schemaVersion?: number;
  purpose?: string;
  transactionId?: string;
  baseCursorHash?: string;
  targetCursorHash?: string;
  fileCount?: number;
  messageCount?: number;
  generatedAt?: string;
  files?: ServerCursorFileState[];
}

interface UsageStatusChannel {
  reporter?: string;
  client?: string;
  scene?: string;
  status?: string;
  lastUploadId?: string | null;
  inFlight?: { count?: number; uploadIds?: string[] } | null;
  currentCursor?: ServerCursor | null;
  lastAttemptedCursor?: ServerCursor | null;
  cursorCommitted?: boolean;
}

interface UsageStatusResponse {
  checkedAt?: string;
  channels?: UsageStatusChannel[];
}

interface CollectedMessages {
  messages: UploadMessage[];
  clientCursor: ClientCursor;
}

function readJsonFileSync(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeCloudBaseUrl(value: unknown): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//iu.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withProtocol);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return migrateLegacyCloudBaseUrl(url.toString().replace(/\/+$/u, ''));
  } catch {
    return null;
  }
}

// The complete default cloud URL comes from @shared/constants/cloudConfig.mjs.

function cloudBaseUrlFromHost(host: unknown): string | null {
  const raw = String(host || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//iu.test(raw)) return normalizeCloudBaseUrl(raw);
  try {
    const defaultUrl = new URL(DEFAULT_OPENHERMIT_CLOUD_BASE_URL);
    const defaultPort = defaultUrl.port ? `:${defaultUrl.port}` : '';
    return normalizeCloudBaseUrl(`${defaultUrl.protocol}//${raw}${defaultPort}`);
  } catch {
    return null;
  }
}

function configuredOpenHermitCloudBaseUrl(existingBaseUrl?: unknown): string {
  const home = process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit');
  const settings = readJsonFileSync(path.join(home, 'settings.json'));
  const cloud =
    settings?.cloud && typeof settings.cloud === 'object'
      ? (settings.cloud as Record<string, unknown>)
      : {};
  const taskBus =
    settings?.taskBus && typeof settings.taskBus === 'object'
      ? (settings.taskBus as Record<string, unknown>)
      : {};
  const telemetry =
    taskBus.telemetry && typeof taskBus.telemetry === 'object'
      ? (taskBus.telemetry as Record<string, unknown>)
      : {};
  const conversations =
    telemetry.conversations && typeof telemetry.conversations === 'object'
      ? (telemetry.conversations as Record<string, unknown>)
      : {};
  const auth = readJsonFileSync(path.join(home, 'auth', 'openhermit.json'));
  return (
    normalizeCloudBaseUrl(process.env.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL) ||
    normalizeCloudBaseUrl(process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL) ||
    normalizeCloudBaseUrl(process.env.OPENHERMIT_CLOUD_BASE_URL) ||
    cloudBaseUrlFromHost(process.env.OPENHERMIT_CLOUD_HOST) ||
    normalizeCloudBaseUrl(cloud.baseUrl) ||
    cloudBaseUrlFromHost(cloud.host) ||
    normalizeCloudBaseUrl(auth?.baseUrl) ||
    normalizeCloudBaseUrl(auth?.issuer) ||
    normalizeCloudBaseUrl(existingBaseUrl) ||
    normalizeCloudBaseUrl(conversations.baseUrl) ||
    DEFAULT_OPENHERMIT_CLOUD_BASE_URL
  );
}

function resolveConversationUploadBaseUrl(existingBaseUrl?: unknown): string {
  return configuredOpenHermitCloudBaseUrl(existingBaseUrl);
}

function emptyStatus(
  enabled: boolean,
  endpointConfigured: boolean,
  patch: Partial<ConversationUploadStatus> = {}
): ConversationUploadStatus {
  return {
    enabled,
    endpointConfigured,
    totalDiscovered: 0,
    skippedAlreadyUploaded: 0,
    pending: 0,
    pendingTokens: 0,
    attempted: 0,
    accepted: 0,
    duplicated: 0,
    rejected: 0,
    ...patch,
  };
}

function uploadLogPath(hermitHome: string): string {
  return path.join(hermitHome, 'logs', UPLOAD_LOG_FILE);
}

async function appendUploadLog(
  hermitHome: string,
  message: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    const filePath = uploadLogPath(hermitHome);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await appendFile(
      filePath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), message, ...details })}\n`,
      { encoding: 'utf-8', mode: 0o600 }
    );
  } catch {
    // Logging must never block upload.
  }
}

async function appendScanProgress(
  platform: UploadPlatform,
  filesScanned: number,
  messagesCollected: number
): Promise<void> {
  await appendUploadLog(hermitHome(), 'scan-progress', {
    platform,
    filesScanned,
    messagesCollected,
  });
}

function clientCursorAsServerCursor(cursor: ClientCursor): ServerCursor {
  return {
    schemaVersion: cursor.schemaVersion,
    purpose: cursor.purpose,
    transactionId: cursor.transactionId,
    baseCursorHash: cursor.baseCursorHash,
    targetCursorHash: cursor.targetCursorHash,
    fileCount: cursor.fileCount,
    messageCount: cursor.messageCount,
    generatedAt: cursor.generatedAt,
    files: cursor.files,
  };
}

function uploadLockPath(hermitHome: string): string {
  return path.join(hermitHome, 'telemetry', UPLOAD_LOCK_FILE);
}

/**
 * Clear a leftover upload lock from a previous (crashed/killed/rebooted) run.
 * Safe to call at worker startup so a stale lock from the previous boot is gone
 * before the first scan, instead of only being cleared on the next acquisition
 * attempt. No-op when there is no lock or it belongs to a live process.
 */
export async function sweepStaleUploadLock(home: string): Promise<boolean> {
  return clearStaleUploadLock(uploadLockPath(home));
}

async function clearStaleUploadLock(filePath: string): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const lock = JSON.parse(raw) as { pid?: number; createdAt?: string };
    const pid = Number(lock.pid);
    const ageMs = Date.now() - Date.parse(lock.createdAt || '');
    const staleByAge = Number.isFinite(ageMs) && ageMs > 30 * 60 * 1000;
    let staleByPid = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch {
        staleByPid = true;
      }
    }
    if (!staleByPid && !staleByAge) return false;
    await unlink(filePath).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// Create the lock file, retrying on contention so a manual `usage report` (or
// --full) completes instead of being skipped when the background worker is
// mid-scan. The bg scan holds the lock only briefly between cycles, so waiting
// a short while usually acquires it. Returns true once acquired, false on
// timeout. (Wait read at call time so tests can override via env.)
async function acquireUploadLock(hermitHome: string, filePath: string): Promise<boolean> {
  const deadline = Date.now() + Number(process.env.HERMIT_UPLOAD_LOCK_WAIT_MS ?? '60000');
  let loggedWaiting = false;
  while (Date.now() < deadline) {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(filePath, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
      );
      return true;
    } catch {
      // contention or transient error — fall through to retry
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const stale = await clearStaleUploadLock(filePath);
    if (!stale) {
      if (!loggedWaiting) {
        loggedWaiting = true;
        await appendUploadLog(hermitHome, 'upload-lock-busy-waiting', {
          lockPath: 'telemetry/conversation-message-upload.lock',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return false;
}

export async function withUploadLock<T>(
  hermitHome: string,
  fn: () => Promise<T>
): Promise<T | null> {
  const filePath = uploadLockPath(hermitHome);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const acquired = await acquireUploadLock(hermitHome, filePath);
  if (!acquired) {
    await appendUploadLog(hermitHome, 'upload-lock-busy', {
      lockPath: 'telemetry/conversation-message-upload.lock',
    });
    return null;
  }

  try {
    return await fn();
  } finally {
    await unlink(filePath).catch(() => undefined);
  }
}

function apiUrl(baseUrl: string, apiPath: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/api/v1') && apiPath.startsWith('/api/v1/')) {
    return `${base}${apiPath.slice('/api/v1'.length)}`;
  }
  return `${base}${apiPath}`;
}

function statusUrl(receipt: UploadReceipt): string | null {
  const url = receipt.statusUrl || receipt.detailUrl;
  if (!url)
    return receipt.uploadId
      ? `/api/v1/report/uploads/${encodeURIComponent(receipt.uploadId)}`
      : null;
  return url;
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeRef(prefix: string, value: string): string {
  return `${prefix}-${sha(value).slice(0, 24)}`;
}

function cursorHash(cursor: unknown): string {
  return sha(JSON.stringify(cursor ?? null));
}

function fileKey(filePath: string): string {
  return sha(filePath);
}

function hermitHome(): string {
  // os.homedir() (not process.env.HOME) — HOME is undefined on native Windows,
  // which collapsed this to a relative `.hermit` and broke auth/data resolution
  // for the spawned worker. Matches the other ~12 home-resolution sites.
  return process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit');
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

// Text-less tool-use turns carry no readable text but DO carry an invoked tool
// name. Surfacing that name ("Bash", "Bash, Read") as `content` is far more
// useful to the analytics side than the generic [usage only] placeholder.
function toolNamesFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const names: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (
      (block.type === 'tool_use' || block.type === 'toolCall') &&
      typeof block.name === 'string' &&
      block.name
    ) {
      names.push(block.name);
    }
  }
  return names.join(', ').trim();
}

function usageFromMessage(
  message: Record<string, unknown>
): UploadMessage['message']['usage'] | undefined {
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? usage.input ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? usage.output ?? 0);
  const cacheReadTokens = Number(
    usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cacheRead ?? 0
  );
  const cacheCreationTokens = Number(
    usage.cache_creation_input_tokens ??
      usage.cacheCreationTokens ??
      usage.cacheWriteTokens ??
      usage.cacheWrite ??
      0
  );
  const totalTokens = resolveUsageTotalTokens(usage, {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  });
  if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheCreationTokens && !totalTokens) {
    return undefined;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens };
}

function shouldIncludeOccurredAt(
  occurredAt: string | undefined,
  sinceMs: number,
  untilMs: number
): boolean {
  const occurredMs = typeof occurredAt === 'string' ? Date.parse(occurredAt) : NaN;
  if (!Number.isFinite(occurredMs)) return sinceMs <= 0 && untilMs <= 0;
  if (sinceMs > 0 && occurredMs < sinceMs) return false;
  if (untilMs > 0 && occurredMs >= untilMs) return false;
  return true;
}

function shouldYieldDuringScan(filesScanned: number): boolean {
  return filesScanned > 0 && filesScanned % SCAN_YIELD_FILE_INTERVAL === 0;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createScanProgressReporter(platform: UploadPlatform) {
  let lastReportedAt = 0;
  let lastReportedMessages = -1;
  return async (filesScanned: number, messagesCollected: number): Promise<void> => {
    const now = Date.now();
    const shouldReport =
      filesScanned === 1 ||
      filesScanned % SCAN_PROGRESS_FILE_INTERVAL === 0 ||
      messagesCollected !== lastReportedMessages ||
      now - lastReportedAt >= SCAN_PROGRESS_MIN_INTERVAL_MS;
    if (shouldReport) {
      lastReportedAt = now;
      lastReportedMessages = messagesCollected;
      await appendScanProgress(platform, filesScanned, messagesCollected);
    }
    if (shouldYieldDuringScan(filesScanned)) {
      await yieldToEventLoop();
    }
  };
}

async function* walkJsonl(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent_')) {
      yield full;
    }
  }
}

async function probeAuthOnce(
  baseUrl: string,
  token: string,
  home: string
): Promise<{ reason: string | null; accessExpired: boolean }> {
  const url = apiUrl(baseUrl, '/api/v1/auth/me');
  const res = await authedFetch(home, baseUrl, url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : `HTTP ${res.status}`;
  const accessExpired = body.access_expired === true;
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((scope) => typeof scope === 'string')
    : null;
  const missingUploadScopes = scopes
    ? ['upload:read', 'upload:write'].filter((scope) => !scopes.includes(scope))
    : [];
  await appendUploadLog(home, 'auth-me-checked', {
    url: '/api/v1/auth/me',
    baseUrl,
    ok:
      res.ok && body.authenticated !== false && status === 'ok' && missingUploadScopes.length === 0,
    status,
    error: typeof body.error === 'string' ? body.error : res.ok ? undefined : res.statusText,
    feishuAuthorized: body.feishu_authorized,
    accessExpired,
    scopes,
    missingUploadScopes,
  });
  if (!res.ok || body.authenticated === false || status !== 'ok') {
    return { reason: `授权不可用：${status}`, accessExpired };
  }
  if (missingUploadScopes.length > 0) {
    return { reason: `缺少 ${missingUploadScopes.join('/')} 授权，请重新登录`, accessExpired };
  }
  return { reason: null, accessExpired };
}

async function probeAuth(baseUrl: string, token: string, home: string): Promise<string | null> {
  let result = await probeAuthOnce(baseUrl, token, home);
  // The server may report access_expired as 200 + access_expired:true (not a
  // 401) even when the local expiresAt still looks valid — authedFetch only
  // refreshes on 401. Mirror bin/lib/auth.mjs: refresh and retry /me once.
  if (result.accessExpired) {
    await appendUploadLog(home, 'auth-refresh-attempted', { reason: 'access_expired' });
    const refreshed = await refreshAccessToken(home, baseUrl);
    const nextToken = refreshed?.token?.accessToken;
    if (nextToken) {
      await appendUploadLog(home, 'auth-retry-after-401', {
        endpoint: '/me',
        reason: 'access_expired',
      });
      result = await probeAuthOnce(baseUrl, nextToken, home);
    }
  }
  return result.reason;
}

async function fetchUsageChannel(
  baseUrl: string,
  token: string,
  platform: UploadPlatform,
  home?: string
): Promise<UsageStatusChannel | null> {
  const scene = 'coding';
  const path = `/api/v1/report/usage/status?client=${encodeURIComponent(platform)}&scene=${encodeURIComponent(scene)}`;
  const url = apiUrl(baseUrl, path);
  await (home
    ? appendUploadLog(home, 'usage-status-request', {
        platform,
        scene,
        url: path,
      })
    : Promise.resolve());
  const res = await authedFetch(home ?? hermitHome(), baseUrl, url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const diagnostic = responseDiagnosticFromText(res.status, text, res.statusText);
    await (home
      ? appendUploadLog(home, 'usage-status-response', {
          platform,
          ok: false,
          status: res.status,
          statusText: res.statusText,
          body: sanitizeDiagnosticText(text),
        })
      : Promise.resolve());
    throw new Error(`usage status ${platform} ${diagnostic}`);
  }
  const body = parseJsonObject(text) as UsageStatusResponse;
  // 新协议响应通道维度为 reporter + client + scene（无 source/platform/mode）。
  const channel =
    body.channels?.find(
      (item) => item.reporter === SOURCE && item.client === platform && item.scene === scene
    ) ??
    body.channels?.[0] ??
    null;
  await (home
    ? appendUploadLog(home, 'usage-status-response', {
        platform,
        ok: true,
        status: res.status,
        channelStatus: channel?.status,
        inFlightCount: channel?.inFlight?.count ?? 0,
        hasCurrentCursor: Boolean(channel?.currentCursor),
        cursorHash: channel?.currentCursor?.targetCursorHash,
      })
    : Promise.resolve());
  return channel;
}

function cursorOffsetMap(
  cursor: ServerCursor | null | undefined
): Map<string, ServerCursorFileState> {
  const files = Array.isArray(cursor?.files) ? cursor.files : [];
  return new Map(
    files
      .filter(
        (file): file is ServerCursorFileState =>
          Boolean(file?.fileKey) &&
          Number.isFinite(Number(file.toOffset)) &&
          Number(file.toOffset) >= 0
      )
      .map((file) => [file.fileKey, file])
  );
}

function startOffsetFromServerCursor(
  remoteState: ServerCursorFileState | undefined,
  fileStat: Awaited<ReturnType<typeof stat>>
): number {
  if (!remoteState) return 0;
  const offset = Number(remoteState.toOffset);
  if (!Number.isFinite(offset) || offset < 0 || offset > fileStat.size) return 0;
  if (Number(remoteState.size) > fileStat.size) return 0;
  return offset;
}

function buildClientCursor(
  baseCursor: ServerCursor | null | undefined,
  files: CursorFileRange[],
  messageCount: number,
  generatedAt: string
): ClientCursor {
  const targetShape = {
    schemaVersion: 1,
    purpose: 'local-jsonl-scan-position',
    files: files.map((file) => ({
      fileKey: file.fileKey,
      pathHash: file.pathHash,
      size: file.size,
      mtimeMs: file.mtimeMs,
      toOffset: file.toOffset,
    })),
  };
  return {
    schemaVersion: 1,
    purpose: 'local-jsonl-scan-position',
    transactionId: `tx-${generatedAt.replace(/[^0-9A-Za-z]/g, '')}-${sha(`${generatedAt}:${messageCount}:${files.length}`).slice(0, 12)}`,
    baseCursorHash: cursorHash(baseCursor ?? null),
    targetCursorHash: cursorHash(targetShape),
    fileCount: files.length,
    messageCount,
    generatedAt,
    files,
  };
}

function claudeMessageId(obj: Record<string, unknown>, msg: Record<string, unknown>): string {
  return String(obj.uuid ?? msg.uuid ?? obj.messageId ?? msg.id ?? obj.requestId ?? '');
}

function claudeSessionId(filePath: string, obj: Record<string, unknown>): string {
  return String(obj.sessionId ?? obj.session_id ?? path.basename(filePath, '.jsonl'));
}

function parentMessageRef(parent: unknown): string | null {
  return typeof parent === 'string' && parent ? parent : null;
}

function claudeUploadMessage(
  filePath: string,
  obj: Record<string, unknown>,
  reportedAt: string,
  startedAt: string | undefined
): UploadMessage | null {
  const msg = (obj.message && typeof obj.message === 'object' ? obj.message : obj) as Record<
    string,
    unknown
  >;
  const role = msg.role === 'user' || msg.role === 'assistant' ? msg.role : undefined;
  if (!role) return null;

  const hasText = Boolean(textFromContent(msg.content ?? obj.content));
  const usage = usageFromMessage(msg);
  // Keep a message if it has readable text OR token usage. Tool-use / tool-result
  // turns carry no text but hold the bulk of token usage — dropping them made the
  // server undercount tokens, and the cursor advances past them so they would
  // never be retried. The real text is shipped (full content); text-less tool-use
  // turns report the invoked tool name(s); other text-less turns fall back to the
  // placeholder so the wire field stays populated.
  if (!hasText && !usage) return null;
  const reportedContent =
    textFromContent(msg.content ?? obj.content) ||
    toolNamesFromContent(msg.content ?? obj.content) ||
    REPORTED_CONTENT_PLACEHOLDER;

  const sessionId = claudeSessionId(filePath, obj);
  const messageId = claudeMessageId(obj, msg);
  if (!sessionId || !messageId) return null;

  const projectPath = typeof obj.cwd === 'string' ? obj.cwd : path.dirname(filePath);
  const occurredAt =
    typeof obj.timestamp === 'string'
      ? obj.timestamp
      : typeof msg.timestamp === 'string'
        ? msg.timestamp
        : undefined;
  const eventId = `claudecode:${sessionId}:${messageId}`;
  return {
    kind: 'conversation_message',
    eventId,
    reportedAt,
    project: {
      projectRef: safeRef('project', projectPath),
      name: path.basename(projectPath),
      pathHash: `sha256-${sha(projectPath)}`,
    },
    conversation: {
      conversationId: sessionId,
      sessionRef: `claudecode:${sessionId}`,
      startedAt,
    },
    message: {
      messageRef: messageId,
      parentRef: parentMessageRef(obj.parentUuid ?? obj.parentMessageId),
      role,
      occurredAt,
      modelName: typeof msg.model === 'string' ? msg.model : undefined,
      content: reportedContent,
      contentFormat: 'text',
      usage,
    },
  };
}

async function collectClaudeCodeMessages(
  serverCursor: ServerCursor | null | undefined,
  limit: number,
  generatedAt: string,
  sinceMs = 0,
  untilMs = 0
): Promise<CollectedMessages> {
  const messages: UploadMessage[] = [];
  const files: CursorFileRange[] = [];
  const maxMessages = Math.max(0, limit);
  const offsets = cursorOffsetMap(serverCursor);
  const reportProgress = createScanProgressReporter('claudecode');
  let filesScanned = 0;

  for await (const filePath of walkJsonl(getProjectsBasePath())) {
    if (maxMessages > 0 && messages.length >= maxMessages) break;
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) continue;

    const key = fileKey(filePath);
    const pathHash = `sha256-${sha(filePath)}`;
    const fromOffset = startOffsetFromServerCursor(offsets.get(key), fileStat);
    const scanEndOffset = fileStat.size;
    if (fromOffset >= scanEndOffset) {
      files.push({
        fileKey: key,
        pathHash,
        size: fileStat.size,
        mtimeMs: Math.trunc(fileStat.mtimeMs),
        fromOffset,
        toOffset: scanEndOffset,
      });
      filesScanned += 1;
      await reportProgress(filesScanned, messages.length);
      continue;
    }

    let consumedOffset = fromOffset;
    let startedAt: string | undefined;
    const stream = createReadStream(filePath, {
      encoding: 'utf-8',
      start: fromOffset,
      end: Math.max(fromOffset, scanEndOffset - 1),
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let linesScanned = 0;
    for await (const rawLine of rl) {
      if (maxMessages > 0 && messages.length >= maxMessages) break;
      linesScanned += 1;
      if (linesScanned % SCAN_LINE_YIELD_INTERVAL === 0) await yieldToEventLoop();
      consumedOffset += Buffer.byteLength(rawLine, 'utf-8') + 1;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(rawLine) as Record<string, unknown>;
      } catch {
        continue;
      }
      const rawOccurredAt =
        typeof obj.timestamp === 'string' ? obj.timestamp : objectRecord(obj.message)?.timestamp;
      const occurredAt = typeof rawOccurredAt === 'string' ? rawOccurredAt : undefined;
      if (!shouldIncludeOccurredAt(occurredAt, sinceMs, untilMs)) continue;
      startedAt ||= occurredAt;
      const baseMessage = claudeUploadMessage(filePath, obj, generatedAt, startedAt);
      if (!baseMessage) continue;
      messages.push(baseMessage);
    }

    const toOffset =
      maxMessages > 0 && messages.length >= maxMessages
        ? Math.min(consumedOffset, scanEndOffset)
        : scanEndOffset;
    files.push({
      fileKey: key,
      pathHash,
      size: fileStat.size,
      mtimeMs: Math.trunc(fileStat.mtimeMs),
      fromOffset,
      toOffset,
    });
    filesScanned += 1;
    await reportProgress(filesScanned, messages.length);
  }

  return {
    messages,
    clientCursor: buildClientCursor(serverCursor, files, messages.length, generatedAt),
  };
}

function codexHome(): string {
  // See hermitHome(): os.homedir() for Windows parity.
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

const GENERIC_CODEX_MODEL_LABELS = new Set([
  'openai',
  'azure',
  'azure-openai',
  'codex',
  'chatgpt',
  'anthropic',
  'google',
  'gemini',
]);

function exactCodexModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || GENERIC_CODEX_MODEL_LABELS.has(normalized.toLowerCase())) return undefined;
  return normalized;
}

interface RecoveredCodexContext {
  model?: string;
  projectPath?: string;
  startedAt?: string;
}

async function recoverCodexContextBeforeOffset(
  filePath: string,
  fromOffset: number
): Promise<RecoveredCodexContext> {
  if (fromOffset <= 0) return {};
  const recovered: RecoveredCodexContext = {};
  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    start: 0,
    end: Math.max(0, fromOffset - 1),
  });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const rawLine of rl) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = objectRecord(obj.payload);
    if (!payload) continue;
    if (typeof payload.cwd === 'string' && payload.cwd) recovered.projectPath = payload.cwd;
    if (Array.isArray(payload.workspace_roots)) {
      const firstRoot = payload.workspace_roots.find((root) => typeof root === 'string' && root);
      if (typeof firstRoot === 'string') recovered.projectPath = firstRoot;
    }
    // Real Codex turn_context records keep the discriminator on obj.type and
    // often omit payload.type entirely. Recover every exact payload.model so an
    // incremental scan retains the last model seen before the server cursor.
    recovered.model = exactCodexModel(payload.model) ?? recovered.model;
    if (!recovered.startedAt && typeof payload.started_at === 'string') {
      recovered.startedAt = payload.started_at;
    }
    if (!recovered.startedAt && typeof payload.timestamp === 'string') {
      recovered.startedAt = payload.timestamp;
    }
  }
  return recovered;
}

async function collectCodexMessages(
  serverCursor: ServerCursor | null | undefined,
  limit: number,
  generatedAt: string,
  sinceMs = 0,
  untilMs = 0
): Promise<CollectedMessages> {
  const messages: UploadMessage[] = [];
  const files: CursorFileRange[] = [];
  const maxMessages = Math.max(0, limit);
  const offsets = cursorOffsetMap(serverCursor);
  const reportProgress = createScanProgressReporter('codex');
  let filesScanned = 0;

  for (const root of [
    path.join(codexHome(), 'sessions'),
    path.join(codexHome(), 'archived_sessions'),
  ]) {
    for await (const filePath of walkJsonl(root)) {
      if (maxMessages > 0 && messages.length >= maxMessages) break;
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat?.isFile()) continue;

      const key = fileKey(filePath);
      const pathHash = `sha256-${sha(filePath)}`;
      const remoteState = offsets.get(key);
      const fromOffset = startOffsetFromServerCursor(remoteState, fileStat);
      const scanEndOffset = fileStat.size;
      if (fromOffset >= scanEndOffset) {
        files.push({
          fileKey: key,
          pathHash,
          size: fileStat.size,
          mtimeMs: Math.trunc(fileStat.mtimeMs),
          fromOffset,
          toOffset: scanEndOffset,
        });
        filesScanned += 1;
        await reportProgress(filesScanned, messages.length);
        continue;
      }

      const sessionId = path.basename(filePath, '.jsonl');
      const recoveredContext = await recoverCodexContextBeforeOffset(filePath, fromOffset);
      const fileMessageStart = messages.length;
      let consumedOffset = fromOffset;
      let startedAt: string | undefined = recoveredContext.startedAt;
      let codexProjectPath = recoveredContext.projectPath ?? filePath;
      let codexModel: string | undefined = recoveredContext.model;
      let missingModelAtOffset: number | null = null;
      // Per-session accumulator: cumulative `total_token_usage` snapshots are
      // converted to per-turn deltas so the server never double-counts prior
      // turns when summing `message.usage.totalTokens`. A fresh scan (offset 0)
      // may treat the first cumulative snapshot as the first turn's delta; an
      // incremental continuation cannot, and skips that first record instead.
      const usageAccumulator = new CodexUsageAccumulator({
        assumeStartsFromZero: fromOffset === 0,
      });
      // Builds the shared UploadMessage shell for Codex records. `token_count`
      // rows carry usage but no text; `user_message` / `agent_message` rows carry
      // the real conversation text. `response_item/*` and other record types are
      // skipped at the call sites to avoid duplicating that text + system noise.
      const buildCodexMessage = (args: {
        payload: Record<string, unknown> | null;
        messageId: string;
        occurredAt: string;
        role: 'user' | 'assistant';
        content: string;
        contentFormat: 'text' | 'markdown';
        usage?: UploadMessage['message']['usage'];
      }): UploadMessage => {
        const projectPath = String(args.payload?.cwd ?? codexProjectPath);
        return {
          kind: 'conversation_message',
          eventId: `codex:${sessionId}:${args.messageId}`,
          reportedAt: generatedAt,
          project: {
            projectRef: safeRef('codex-project', projectPath),
            name:
              typeof args.payload?.project === 'string'
                ? args.payload.project
                : path.basename(projectPath) || 'Codex',
            pathHash: `sha256-${sha(projectPath)}`,
          },
          conversation: { conversationId: sessionId, sessionRef: `codex:${sessionId}`, startedAt },
          message: {
            messageRef: args.messageId,
            parentRef: null,
            role: args.role,
            occurredAt: args.occurredAt,
            // Provider labels such as "openai" are not billable model names.
            // Keep the recovered exact model instead of letting a generic label
            // on the current record overwrite it.
            modelName: exactCodexModel(args.payload?.model) ?? codexModel,
            content: args.content,
            contentFormat: args.contentFormat,
            usage: args.usage,
          },
        };
      };
      const stream = createReadStream(filePath, {
        encoding: 'utf-8',
        start: fromOffset,
        end: Math.max(fromOffset, scanEndOffset - 1),
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let linesScanned = 0;
      for await (const rawLine of rl) {
        if (maxMessages > 0 && messages.length >= maxMessages) break;
        linesScanned += 1;
        if (linesScanned % SCAN_LINE_YIELD_INTERVAL === 0) await yieldToEventLoop();
        consumedOffset += Buffer.byteLength(rawLine, 'utf-8') + 1;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
          continue;
        }
        const payload = objectRecord(obj.payload);
        if (payload) {
          if (typeof payload.cwd === 'string' && payload.cwd) codexProjectPath = payload.cwd;
          if (Array.isArray(payload.workspace_roots)) {
            const firstRoot = payload.workspace_roots.find(
              (root) => typeof root === 'string' && root
            );
            if (typeof firstRoot === 'string') codexProjectPath = firstRoot;
          }
          codexModel = exactCodexModel(payload.model) ?? codexModel;
          if (!startedAt && typeof payload.started_at === 'string') startedAt = payload.started_at;
          if (!startedAt && typeof payload.timestamp === 'string') startedAt = payload.timestamp;
        }
        const payloadType = String(payload?.type ?? '');
        if (payloadType === 'token_count') {
          const usage: CodexUsage | null = usageAccumulator.consume(obj);
          // Codex emits heartbeat-like token_count rows with info:null. They do
          // not carry billable usage and therefore do not require model context.
          if (!usage) continue;
          // Exact model is a pricing requirement only for records carrying token
          // usage. Plain user/assistant text remains valid without model metadata.
          if (!codexModel) {
            missingModelAtOffset = consumedOffset;
            break;
          }
          const occurredAt = codexEventTimestamp(obj, generatedAt);
          if (!shouldIncludeOccurredAt(occurredAt, sinceMs, untilMs)) continue;
          startedAt ||= occurredAt;
          const messageId = String(
            obj.id ??
              obj.uuid ??
              payload?.id ??
              payload?.turn_id ??
              `${sessionId}:${consumedOffset}`
          );
          messages.push(
            buildCodexMessage({
              payload,
              messageId,
              occurredAt,
              role: 'assistant',
              content: 'Codex token usage event',
              contentFormat: 'text',
              usage,
            })
          );
        } else if (payloadType === 'user_message' || payloadType === 'agent_message') {
          const text = typeof payload?.message === 'string' ? payload.message : '';
          if (!text) continue;
          const occurredAt = codexEventTimestamp(obj, generatedAt);
          if (!shouldIncludeOccurredAt(occurredAt, sinceMs, untilMs)) continue;
          startedAt ||= occurredAt;
          const messageId = String(
            obj.id ?? obj.uuid ?? payload?.id ?? `${sessionId}:${consumedOffset}`
          );
          messages.push(
            buildCodexMessage({
              payload,
              messageId,
              occurredAt,
              role: payloadType === 'user_message' ? 'user' : 'assistant',
              content: text,
              contentFormat: 'text',
            })
          );
        }
        // response_item/* and other record types are intentionally skipped:
        // their `message` content duplicates the user_message/agent_message rows
        // above, and the rest is system noise with no reporting value.
      }

      if (missingModelAtOffset !== null) {
        messages.splice(fileMessageStart);
        // Keep this file in the target cursor at its previous committed offset.
        // Omitting it would delete the server-side file entry when another file
        // succeeds, causing the quarantined file to restart from offset 0.
        files.push({
          fileKey: key,
          pathHash,
          size: fileStat.size,
          mtimeMs: Math.trunc(fileStat.mtimeMs),
          fromOffset,
          toOffset: fromOffset,
        });
        await appendUploadLog(hermitHome(), 'codex file quarantined: exact model unavailable', {
          fileKey: key,
          pathHash,
          fromOffset,
          blockedAtOffset: missingModelAtOffset,
        });
        filesScanned += 1;
        await reportProgress(filesScanned, messages.length);
        continue;
      }

      const toOffset =
        maxMessages > 0 && messages.length >= maxMessages
          ? Math.min(consumedOffset, scanEndOffset)
          : scanEndOffset;
      files.push({
        fileKey: key,
        pathHash,
        size: fileStat.size,
        mtimeMs: Math.trunc(fileStat.mtimeMs),
        fromOffset,
        toOffset,
      });
      filesScanned += 1;
      await reportProgress(filesScanned, messages.length);
    }
    if (maxMessages > 0 && messages.length >= maxMessages) break;
  }

  return {
    messages,
    clientCursor: buildClientCursor(serverCursor, files, messages.length, generatedAt),
  };
}

function piSessionsRoot(): string {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  return path.join(agentDir, 'sessions');
}

interface PiSessionHeader {
  sessionId: string;
  projectPath: string;
  startedAt?: string;
}

async function readPiSessionHeader(filePath: string): Promise<PiSessionHeader> {
  const fallback: PiSessionHeader = {
    sessionId: path.basename(filePath, '.jsonl'),
    projectPath: path.dirname(filePath),
  };
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer
      .toString('utf-8', 0, bytesRead)
      .split('\n')
      .find((line) => line.trim());
    if (!firstLine) return fallback;
    const header = JSON.parse(firstLine.trim()) as Record<string, unknown>;
    if (header.type !== 'session') return fallback;
    return {
      sessionId: typeof header.id === 'string' && header.id ? header.id : fallback.sessionId,
      projectPath: typeof header.cwd === 'string' && header.cwd ? header.cwd : fallback.projectPath,
      startedAt: typeof header.timestamp === 'string' ? header.timestamp : undefined,
    };
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function piOccurredAt(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  fallback: string
): string {
  if (typeof entry.timestamp === 'string' && entry.timestamp) return entry.timestamp;
  const timestamp = message.timestamp;
  if (typeof timestamp === 'string' && timestamp) return timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    const parsed = new Date(timestamp);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

function piMessageFingerprint(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  role: 'user' | 'assistant',
  occurredAt: string
): string | null {
  const entryId = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!entryId) return null;
  const messageTimestamp = message.timestamp ?? occurredAt;
  return `${entryId}\u0000${String(messageTimestamp)}\u0000${role}`;
}

async function collectPiMessages(
  serverCursor: ServerCursor | null | undefined,
  limit: number,
  generatedAt: string,
  sinceMs = 0,
  untilMs = 0
): Promise<CollectedMessages> {
  const messages: UploadMessage[] = [];
  const files: CursorFileRange[] = [];
  const maxMessages = Math.max(0, limit);
  const offsets = cursorOffsetMap(serverCursor);
  const reportProgress = createScanProgressReporter('pi');
  const filePaths: string[] = [];
  for await (const filePath of walkJsonl(piSessionsRoot())) filePaths.push(filePath);
  filePaths.sort(
    (left, right) =>
      path.basename(left).localeCompare(path.basename(right)) || left.localeCompare(right)
  );
  const seenMessageFingerprints = new Set<string>();
  let filesScanned = 0;

  for (const filePath of filePaths) {
    if (maxMessages > 0 && messages.length >= maxMessages) break;
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) continue;

    const key = fileKey(filePath);
    const pathHash = `sha256-${sha(filePath)}`;
    const fromOffset = startOffsetFromServerCursor(offsets.get(key), fileStat);
    const scanEndOffset = fileStat.size;
    if (fromOffset >= scanEndOffset) {
      files.push({
        fileKey: key,
        pathHash,
        size: fileStat.size,
        mtimeMs: Math.trunc(fileStat.mtimeMs),
        fromOffset,
        toOffset: scanEndOffset,
      });
      filesScanned += 1;
      await reportProgress(filesScanned, messages.length);
      continue;
    }

    const header = await readPiSessionHeader(filePath);
    let consumedOffset = fromOffset;
    const stream = createReadStream(filePath, {
      encoding: 'utf-8',
      start: fromOffset,
      end: Math.max(fromOffset, scanEndOffset - 1),
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let linesScanned = 0;
    for await (const rawLine of rl) {
      if (maxMessages > 0 && messages.length >= maxMessages) break;
      linesScanned += 1;
      if (linesScanned % SCAN_LINE_YIELD_INTERVAL === 0) await yieldToEventLoop();
      const nextOffset = Math.min(
        scanEndOffset,
        consumedOffset + Buffer.byteLength(rawLine, 'utf-8') + 1
      );
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(rawLine) as Record<string, unknown>;
      } catch {
        // Pi appends JSONL while the agent is streaming. Do not advance the
        // cursor past a partial final record; the next scan will retry it.
        if (nextOffset >= scanEndOffset) break;
        consumedOffset = nextOffset;
        continue;
      }
      consumedOffset = nextOffset;
      if (entry.type !== 'message') continue;
      const message = objectRecord(entry.message);
      const role =
        message?.role === 'user' || message?.role === 'assistant' ? message.role : undefined;
      if (!message || !role) continue;
      const occurredAt = piOccurredAt(entry, message, generatedAt);
      const fingerprint = piMessageFingerprint(entry, message, role, occurredAt);
      if (!fingerprint || seenMessageFingerprints.has(fingerprint)) continue;
      seenMessageFingerprints.add(fingerprint);
      if (!shouldIncludeOccurredAt(occurredAt, sinceMs, untilMs)) continue;

      const usage = role === 'assistant' ? usageFromMessage(message) : undefined;
      const content =
        textFromContent(message.content) ||
        toolNamesFromContent(message.content) ||
        (usage ? REPORTED_CONTENT_PLACEHOLDER : '');
      if (!content && !usage) continue;
      const messageRef = String(entry.id);
      messages.push({
        kind: 'conversation_message',
        eventId: `pi:${sha(fingerprint)}`,
        reportedAt: generatedAt,
        project: {
          projectRef: safeRef('pi-project', header.projectPath),
          name: path.basename(header.projectPath) || 'Pi',
          pathHash: `sha256-${sha(header.projectPath)}`,
        },
        conversation: {
          conversationId: header.sessionId,
          sessionRef: `pi:${header.sessionId}`,
          startedAt: header.startedAt,
        },
        message: {
          messageRef,
          parentRef: parentMessageRef(entry.parentId),
          role,
          occurredAt,
          modelName: typeof message.model === 'string' ? message.model : undefined,
          content,
          contentFormat: 'text',
          usage,
        },
      });
    }

    const toOffset =
      maxMessages > 0 && messages.length >= maxMessages
        ? Math.min(consumedOffset, scanEndOffset)
        : consumedOffset;
    files.push({
      fileKey: key,
      pathHash,
      size: fileStat.size,
      mtimeMs: Math.trunc(fileStat.mtimeMs),
      fromOffset,
      toOffset,
    });
    filesScanned += 1;
    await reportProgress(filesScanned, messages.length);
  }

  return {
    messages,
    clientCursor: buildClientCursor(serverCursor, files, messages.length, generatedAt),
  };
}

async function collectMessagesForPlatform(
  platform: UploadPlatform,
  serverCursor: ServerCursor | null | undefined,
  limit: number,
  generatedAt: string,
  sinceMs = 0,
  untilMs = 0
): Promise<CollectedMessages> {
  if (platform === 'codex') {
    return collectCodexMessages(serverCursor, limit, generatedAt, sinceMs, untilMs);
  }
  if (platform === 'pi') {
    return collectPiMessages(serverCursor, limit, generatedAt, sinceMs, untilMs);
  }
  return collectClaudeCodeMessages(serverCursor, limit, generatedAt, sinceMs, untilMs);
}

function sanitizeDiagnosticText(value: unknown): string {
  return String(value ?? '')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[hidden]')
    .replace(
      /(access[_-]?token|refresh[_-]?token|token|secret|password|authorization)(["'\s:=]+)([^\s,"'}]+)/gi,
      '$1$2[hidden]'
    )
    .slice(0, 1200);
}

function sanitizeUploadError(error: unknown): string {
  return sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
}

/**
 * A server that is effectively unavailable: updating, crashed, or unreachable.
 * safeFetch turns transport failures (network/DNS/timeout) into a synthetic
 * HTTP 599, and real server faults arrive as 5xx — both match this. Business
 * errors (422/409) do NOT match: those are per-batch rejections that must stay
 * on the per-batch 3-strike path.
 */
function isServerUnavailableError(error: unknown): boolean {
  return error instanceof Error && /HTTP 5\d\d/.test(error.message);
}

/** Thrown to abort the entire upload run when the server is down. */
class ServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUnavailableError';
  }
}

function responseDiagnosticFromText(status: number, text = '', statusText = ''): string {
  // statusText carries the real cause for synthetic 599s (safeFetch puts the
  // undici cause there: 'fetch failed (ECONNRESET)') and for real server faults
  // — without it a transport failure diagnoses as just "HTTP 599", which tells
  // nobody what actually broke.
  const head = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
  return text ? `${head}: ${sanitizeDiagnosticText(text)}` : head;
}

async function responseDiagnostic(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return responseDiagnosticFromText(res.status, text, res.statusText);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function uploadStatusFromResult(
  receipt: UploadReceipt,
  attempted: number
): ConversationUploadStatus {
  const received = typeof receipt.received === 'number' ? receipt.received : attempted;
  const rejectedAtReceive =
    typeof receipt.rejectedAtReceive === 'number' ? receipt.rejectedAtReceive : 0;
  const accepted =
    typeof receipt.acceptedForProcessing === 'number'
      ? receipt.acceptedForProcessing
      : Math.max(0, received - rejectedAtReceive);
  const status: ConversationUploadStatus = {
    enabled: true,
    endpointConfigured: true,
    attempted,
    accepted,
    duplicated: typeof receipt.duplicatedAtReceive === 'number' ? receipt.duplicatedAtReceive : 0,
    rejected: rejectedAtReceive,
    queued: accepted,
    uploadIds: receipt.uploadId ? [receipt.uploadId] : [],
    lastReceiptId: receipt.receiptId,
    lastStatusUrl: statusUrl(receipt) || undefined,
    lastUploadStatus: receipt.status,
  };
  // Only an intake-level rejection is a real, actionable failure. A non-terminal
  // receipt ('queued') is normal: the server processes asynchronously and reports
  // authoritative counts + the committed cursor via /report/usage/status on the next scan.
  // The interface is the single source of truth — no parallel local accounting.
  if (receipt.ok === false || receipt.errors || rejectedAtReceive > 0) {
    status.lastError = '服务端接收阶段返回错误，已保留待上报状态';
  }
  return status;
}

function batchDelayMs(configured?: number): number {
  const raw = Number(configured ?? process.env.OPENHERMIT_UPLOAD_BATCH_DELAY_MS ?? 1_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1_000;
}

/**
 * Two-tier timestamp floor (ms) for scans:
 *
 * Incremental (periodic daemon): 24 hours.
 *   The 本地 row in the usage dashboard is always capped at 24h.
 *
 * Full rescan (manual `usage report` / `--full`): 168 hours (7 days).
 *   One-shot manual scans should reach back further so the user sees a
 *   meaningful window of data even if the daemon hasn't run recently.
 *
 * The server dedups by eventId, so re-scanning the overlap never double-counts.
 * Set OPENHERMIT_UPLOAD_SINCE_HOURS to 0 to remove the floor (ops escape hatch only).
 */
function hoursToMs(hours: number, referenceMs: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return referenceMs - hours * 3_600_000;
}

function incrementalSinceMs(
  cfg: ConversationUploadConfig | undefined,
  referenceMs: number
): number {
  const hours = Number(
    cfg?.telemetry?.conversations?.uploadSinceHours ??
      process.env.OPENHERMIT_UPLOAD_SINCE_HOURS ??
      24
  );
  return hoursToMs(hours, referenceMs);
}

function fullRescanSinceMs(cfg: ConversationUploadConfig | undefined, referenceMs: number): number {
  const hours = Number(
    cfg?.telemetry?.conversations?.uploadSinceHours ??
      process.env.OPENHERMIT_UPLOAD_SINCE_HOURS ??
      168
  );
  return hoursToMs(hours, referenceMs);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postPayload(
  home: string,
  baseUrl: string,
  endpointPath: string,
  platform: UploadPlatform,
  token: string,
  payload: UploadPayload
): Promise<ConversationUploadStatus> {
  const firstMessage = payload.messages[0];
  const body = JSON.stringify(payload);
  // Idempotency-Key is the body's own fingerprint (sha256). An identical retry
  // (same body) reuses the same key → server returns the original receipt without
  // reprocessing. A different body always yields a different key, so the doc's
  // same-key+different-body 409 can never fire from this client. A full re-scan
  // gets a new generatedAt → new body → new key, so it re-uploads without false
  // conflict (the server still dedups by eventId).
  const idempotencyKey = sha(body);
  await appendUploadLog(home, 'upload-request', {
    endpoint: endpointPath,
    platform,
    schemaVersion: payload.schemaVersion,
    reporter: payload.reporter,
    idempotencyKey,
    messageCount: payload.messages.length,
    hasClientCursor: Boolean(payload.clientCursor),
    cursorHash: payload.clientCursor?.targetCursorHash,
    cursorFileCount: payload.clientCursor?.fileCount,
    cursorMessageCount: payload.clientCursor?.messageCount,
    firstEventId: firstMessage?.eventId,
    firstKind: firstMessage?.kind,
    firstProjectRef: firstMessage?.project?.projectRef,
    hasRequestUploadId:
      Object.prototype.hasOwnProperty.call(payload, 'uploadId') ||
      Object.prototype.hasOwnProperty.call(payload, 'upload_id'),
  });
  const res = await authedFetch(home, baseUrl, apiUrl(baseUrl, endpointPath), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  await appendUploadLog(home, 'upload-response', {
    endpoint: endpointPath,
    platform,
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    body: sanitizeDiagnosticText(text),
  });
  const receipt = parseJsonObject(text) as UploadReceipt;
  if (!res.ok) {
    throw new Error(
      `upload ${endpointPath} ${await responseDiagnostic(new Response(text, { status: res.status, statusText: res.statusText }))}`
    );
  }
  // Receipt-only: the 202 confirms the batch was accepted for processing. The
  // server is cursor-authoritative + eventId-dedup — it commits the cursor on
  // success and reports authoritative counts via /report/usage/status on the next scan.
  // No per-batch terminal-status polling: that fed display counts only and froze
  // the menu for ~an hour on a 199-batch first backfill (and made the worker hold
  // the lock ~an hour per cycle). The interface is the single source of truth.
  return uploadStatusFromResult(receipt, payload.messages.length);
}

// Sum totalTokens across a slice of collected messages. Used to express the
// upload backlog in tokens (its real cost) instead of just a message count —
// pendingTokens mirrors pending (discovered − uploaded) so 待上报 can read in
// tokens. Messages without usage contribute 0.
function sumMessageTokens(messages: UploadMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const t = Number(msg?.message?.usage?.totalTokens);
    if (Number.isFinite(t) && t > 0) total += t;
  }
  return total;
}

function mergeStatuses(statuses: ConversationUploadStatus[]): ConversationUploadStatus {
  return statuses.reduce<ConversationUploadStatus>(
    (acc, item) => ({
      enabled: acc.enabled || item.enabled,
      endpointConfigured: acc.endpointConfigured || item.endpointConfigured,
      totalDiscovered: (acc.totalDiscovered ?? 0) + (item.totalDiscovered ?? 0),
      skippedAlreadyUploaded:
        (acc.skippedAlreadyUploaded ?? 0) + (item.skippedAlreadyUploaded ?? 0),
      pending: (acc.pending ?? 0) + (item.pending ?? 0),
      pendingTokens: (acc.pendingTokens ?? 0) + (item.pendingTokens ?? 0),
      attempted: acc.attempted + item.attempted,
      accepted: acc.accepted + item.accepted,
      duplicated: acc.duplicated + item.duplicated,
      rejected: acc.rejected + item.rejected,
      inserted: (acc.inserted ?? 0) + (item.inserted ?? 0),
      failed: (acc.failed ?? 0) + (item.failed ?? 0),
      queued: (acc.queued ?? 0) + (item.queued ?? 0),
      uploadIds: [...(acc.uploadIds ?? []), ...(item.uploadIds ?? [])],
      lastUploadStatus: item.lastUploadStatus ?? acc.lastUploadStatus,
      lastReceiptId: item.lastReceiptId ?? acc.lastReceiptId,
      lastStatusUrl: item.lastStatusUrl ?? acc.lastStatusUrl,
      lastError: item.lastError ?? acc.lastError,
    }),
    emptyStatus(true, true)
  );
}

function resolveUploadProviders(
  telemetry: ConversationUploadTelemetryConfig | undefined
): UploadPlatform[] {
  const providers = telemetry?.uploadProviders?.length
    ? telemetry.uploadProviders
    : telemetry?.platform
      ? [telemetry.platform]
      : ['claudecode', 'codex', 'pi'];
  return [
    ...new Set(
      providers.filter(
        (provider): provider is UploadPlatform =>
          provider === 'claudecode' || provider === 'codex' || provider === 'pi'
      )
    ),
  ];
}

async function postMessagesInBatches(
  home: string,
  baseUrl: string,
  endpointPath: string,
  platform: UploadPlatform,
  token: string,
  payloadBase: Omit<UploadPayload, 'messages'>,
  messages: UploadMessage[],
  batchSize: number,
  batchDelay: number,
  runTotalMessages: number,
  uploadedBeforeRun: number
): Promise<{
  status: ConversationUploadStatus;
  uploadedCount: number;
  uploadedTokens: number;
  allBatchesSucceeded: boolean;
}> {
  const statuses: ConversationUploadStatus[] = [];
  let uploadedCount = 0;
  let uploadedTokens = 0;
  let hadFailure = false;
  const size = Math.max(1, batchSize);
  const totalBatches = Math.ceil(messages.length / size);
  // Stability over speed: a single transient timeout (HTTP 599) must NOT abort
  // the whole window — that left claudecode stuck retrying the identical batch
  // forever. Skip the failed batch and keep going; only bail after several
  // CONSECUTIVE failures so a genuinely-down server stops fast instead of
  // waiting UPLOAD_TIMEOUT_MS × every batch.
  const MAX_CONSECUTIVE_FAILURES = 3;
  // Network-layer / 5xx = the server is effectively down. Bail the whole run
  // after 2 in a row instead of paying UPLOAD_TIMEOUT_MS per remaining batch.
  // Business errors (422/409) are NOT network failures and stay on the
  // 3-strike MAX_CONSECUTIVE_FAILURES path above.
  const MAX_NETWORK_FAILURES = 2;
  let consecutiveFailures = 0;
  let consecutiveNetworkFailures = 0;

  for (let offset = 0; offset < messages.length; offset += size) {
    const batchIndex = Math.floor(offset / size) + 1;
    const batchMessages = messages.slice(offset, offset + size);
    await appendUploadLog(home, 'upload-batch-start', {
      platform,
      batchIndex,
      totalBatches,
      batchSize: batchMessages.length,
      attemptedBeforeBatch: offset,
      attemptedAfterBatch: Math.min(messages.length, offset + batchMessages.length),
      uploadedBeforeBatch: uploadedBeforeRun + uploadedCount,
      totalMessages: runTotalMessages,
    });

    // Keep the bearer token fresh across a long multi-batch run. The token is
    // captured once before the loop; without this, a run that outlasts the
    // access-token TTL expires mid-batch and the next POST ships an expired
    // token → a permission error that derails the run ("抱着抱着报权限错").
    // Refreshing just before each batch is a no-op unless the token is within
    // the expiry buffer (EXPIRY_BUFFER_MS in OpenHermitAuthClient), so every
    // batch ships a valid token. Fall back to the captured token only if the
    // store can't be read at all.
    const freshToken = await getValidBearerToken(home, baseUrl);
    const batchToken = freshToken ?? token;

    try {
      // A cursor may only commit after every preceding batch in this scan window
      // was accepted. Earlier batches omit it; the final batch also omits it if
      // any prior batch failed. This prevents a later successful batch from
      // advancing past a 422-rejected pricing batch.
      const batchPayload: UploadPayload = {
        ...payloadBase,
        messages: batchMessages,
      };
      if (batchIndex < totalBatches || hadFailure) delete batchPayload.clientCursor;
      const status = await postPayload(
        home,
        baseUrl,
        endpointPath,
        platform,
        batchToken,
        batchPayload
      );
      statuses.push(status);
      // A batch that didn't hard-fail was accepted for processing (the 202
      // receipt). lastError is only set on intake rejection / HTTP error, so its
      // absence means the batch is in flight server-side — count it as sent.
      if (!status.lastError) {
        uploadedCount += batchMessages.length;
        uploadedTokens += sumMessageTokens(batchMessages);
        consecutiveFailures = 0;
        consecutiveNetworkFailures = 0;
      }
      await appendUploadLog(home, 'upload-batch-finished', {
        platform,
        batchIndex,
        totalBatches,
        attempted: status.attempted,
        accepted: status.accepted,
        duplicated: status.duplicated,
        rejected: status.rejected,
        failed: status.failed,
        uploadIds: status.uploadIds,
        lastUploadStatus: status.lastUploadStatus,
        ok: !status.lastError,
        uploadedAfterBatch: uploadedBeforeRun + uploadedCount,
        totalMessages: runTotalMessages,
        lastError: status.lastError,
      });
      if (status.lastError) {
        hadFailure = true;
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      }
      if (batchIndex < totalBatches && batchDelay > 0) await wait(batchDelay);
    } catch (error) {
      hadFailure = true;
      const message = sanitizeUploadError(error);
      await appendUploadLog(home, 'upload-batch-failed', {
        platform,
        batchIndex,
        totalBatches,
        batchSize: batchMessages.length,
        attemptedBeforeFailure: offset,
        attemptedAfterFailure: offset + batchMessages.length,
        uploadedBeforeFailure: uploadedBeforeRun + uploadedCount,
        totalMessages: runTotalMessages,
        lastError: message,
      });
      statuses.push(
        emptyStatus(true, true, {
          attempted: batchMessages.length,
          pending: messages.length,
          lastError: message,
        })
      );
      // Transport failure (safeFetch HTTP 599) or a real 5xx ⇒ the server is
      // down/updating. Bail the whole run after 2 in a row. Business errors
      // (422/409) fall through to the 3-strike path — one bad batch must not
      // abort a backfill that is otherwise making progress.
      if (isServerUnavailableError(error)) {
        consecutiveNetworkFailures += 1;
        if (consecutiveNetworkFailures >= MAX_NETWORK_FAILURES) {
          throw new ServerUnavailableError(message);
        }
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    }
  }

  return {
    status: mergeStatuses(statuses),
    uploadedCount,
    uploadedTokens,
    allBatchesSucceeded: !hadFailure && uploadedCount === messages.length,
  };
}

async function uploadPlatformMessages(
  platform: UploadPlatform,
  channel: UsageStatusChannel | null,
  cfg: ConversationUploadConfig,
  home: string,
  baseUrl: string,
  token: string,
  generatedAt: string
): Promise<ConversationUploadStatus> {
  const fullRescan = process.env.HERMIT_USAGE_FULL_RESCAN === '1';
  // A user-initiated scan (`usage report`, the 扫描一次 menu action, or --full)
  // runs as a --scan-once child with HERMIT_USAGE_FOREGROUND_SCAN=1; the periodic
  // daemon loop does NOT. Only the daemon defers to server backpressure — a
  // foreground scan must push through so a pending backlog actually drains.
  const foreground = process.env.HERMIT_USAGE_FOREGROUND_SCAN === '1';
  const inFlightCount = Number(channel?.inFlight?.count ?? 0);
  const isIncremental = !fullRescan && !foreground;
  const referenceMs = Date.parse(generatedAt);
  const sinceMs = isIncremental
    ? incrementalSinceMs(cfg, referenceMs)
    : fullRescanSinceMs(cfg, referenceMs);
  if (inFlightCount > 0 && !(foreground || fullRescan)) {
    const conversationCfgEarly = cfg.telemetry?.conversations;
    const { messages: pendingMessages } = await collectMessagesForPlatform(
      platform,
      channel?.currentCursor,
      conversationCfgEarly?.batchSize ?? 0,
      generatedAt,
      sinceMs,
      referenceMs
    );
    await appendUploadLog(home, 'server-channel-inflight', {
      platform,
      pending: pendingMessages.length,
      uploadIds: channel?.inFlight?.uploadIds ?? [],
    });
    return emptyStatus(true, true, {
      pending: pendingMessages.length,
      pendingTokens: sumMessageTokens(pendingMessages),
      totalDiscovered: pendingMessages.length,
      lastUploadStatus: channel?.status || 'processing',
      uploadIds: channel?.inFlight?.uploadIds ?? [],
    });
  }
  if (inFlightCount > 0) {
    // Foreground/full scan: don't let an in-flight batch from a prior run block
    // the drain. The server dedupes by eventId, so proceeding absorbs the
    // overlap — without this the channel skips forever while a backlog sits,
    // and 待上报 never drops.
    await appendUploadLog(home, 'server-channel-inflight-foreground', {
      platform,
      uploadIds: channel?.inFlight?.uploadIds ?? [],
    });
  }
  // No cursor must NOT pause the upload. A missing cursor can simply mean this
  // is the channel's FIRST upload (nothing committed yet), or that the
  // server-side cursor commit is not implemented yet. Either way we proceed:
  // collectMessagesForPlatform receives the server cursor when present
  // (incremental) or null (full rescan), and the server dedupes by eventId.
  // Incremental resumes automatically once the server starts committing.

  const conversationCfg = cfg.telemetry?.conversations;
  const uploadBatchSize = Number(
    (conversationCfg as { uploadBatchSize?: number } | undefined)?.uploadBatchSize ??
      process.env.OPENHERMIT_CONVERSATION_UPLOAD_BATCH_SIZE ??
      500
  );
  const uploadBatchDelay = batchDelayMs(conversationCfg?.uploadBatchDelayMs);
  const windowSize = fullRescan
    ? Math.max(1, conversationCfg?.fullRescanWindowSize ?? uploadBatchSize * 2)
    : (conversationCfg?.batchSize ?? 0);

  let cursorForScan: ServerCursor | null | undefined = fullRescan ? null : channel?.currentCursor;
  const statuses: ConversationUploadStatus[] = [];
  let totalDiscovered = 0;
  let totalDiscoveredTokens = 0;
  let totalUploaded = 0;
  let totalUploadedTokens = 0;

  while (true) {
    const { messages, clientCursor } = await collectMessagesForPlatform(
      platform,
      cursorForScan,
      windowSize,
      generatedAt,
      sinceMs,
      referenceMs
    );
    const discoveredTokens = sumMessageTokens(messages);
    totalDiscovered += messages.length;
    totalDiscoveredTokens += discoveredTokens;
    // baseStatus.totalDiscovered is CUMULATIVE across all windows so the progress
    // bar's denominator (scan-collected / batch totalMessages) matches the
    // cumulative uploadedAfterBatch numerator — otherwise a windowed full rescan
    // rendered 消息 617/117 (uploaded > total). pending stays per-window (what
    // this window still owes).
    const baseStatus = {
      totalDiscovered,
      skippedAlreadyUploaded: 0,
      pending: messages.length,
      pendingTokens: discoveredTokens,
    };
    await appendUploadLog(home, 'scan-collected', {
      platform,
      ...baseStatus,
      cursorSource: fullRescan ? 'full-rescan-window' : 'server-usage-status-currentCursor',
      baseCursorHash: clientCursor.baseCursorHash,
      targetCursorHash: clientCursor.targetCursorHash,
    });

    if (!messages.length) {
      await appendUploadLog(home, 'no-incremental-messages', { platform, ...baseStatus });
      break;
    }

    const payloadBase: Omit<UploadPayload, 'messages'> = {
      schemaVersion: 1,
      generatedAt,
      reporter: SOURCE,
      client: { tool: platform },
      scene: 'coding',
      clientCursor,
    };

    await appendUploadLog(home, 'upload-start', {
      platform,
      pending: messages.length,
      uploadBatchSize,
      uploadBatchDelay,
      baseUrl,
    });

    const { status, uploadedCount, uploadedTokens, allBatchesSucceeded } =
      await postMessagesInBatches(
        home,
        baseUrl,
        UPLOAD_ENDPOINT,
        platform,
        token,
        payloadBase,
        messages,
        uploadBatchSize,
        uploadBatchDelay,
        totalDiscovered,
        totalUploaded
      );
    statuses.push(status);
    totalUploaded += uploadedCount;
    totalUploadedTokens += uploadedTokens;

    // A full-rescan window may advance only when every batch succeeded and the
    // final batch carried its cursor. Partial success is retried by eventId on
    // the next run instead of skipping rejected messages.
    if (!fullRescan || messages.length < windowSize || !allBatchesSucceeded) break;
    cursorForScan = clientCursorAsServerCursor(clientCursor);
  }

  const merged = mergeStatuses(statuses);
  const result = {
    ...merged,
    totalDiscovered,
    skippedAlreadyUploaded: 0,
    pending: Math.max(0, totalDiscovered - totalUploaded),
    pendingTokens: Math.max(0, totalDiscoveredTokens - totalUploadedTokens),
  };
  await appendUploadLog(home, 'upload-finished', {
    platform,
    attempted: result.attempted,
    accepted: result.accepted,
    duplicated: result.duplicated,
    rejected: result.rejected,
    failed: result.failed,
    pending: result.pending,
    uploadIds: result.uploadIds,
    lastUploadStatus: result.lastUploadStatus,
    cursorAuthority: 'server',
    lastError: result.lastError,
  });
  return result;
}

function isConversationUploadEnabled(cfg: ConversationUploadConfig): boolean {
  const telemetry = cfg.telemetry;
  const canonical = telemetry?.conversationUploadEnabled;
  const legacy = telemetry?.conversations?.uploadEnabled;
  // Message content is explicit opt-in. A missing setting is always OFF.
  // The canonical field wins whenever present; the legacy nested field is only
  // a migration fallback and must also be explicitly true.
  // This must stay aligned with UsageTelemetryService and bin/lib/uploadState.
  if (typeof canonical === 'boolean') return canonical;
  return legacy === true;
}

async function uploadConversationMessagesLocked(
  cfg: ConversationUploadConfig,
  referenceMs = Date.now()
): Promise<ConversationUploadStatus> {
  const telemetry = cfg.telemetry;
  const conversationCfg = telemetry?.conversations;
  const enabled = isConversationUploadEnabled(cfg);
  const baseUrl = resolveConversationUploadBaseUrl(conversationCfg?.baseUrl);
  if (!enabled) return emptyStatus(false, Boolean(baseUrl));

  const home = hermitHome();
  const providers = resolveUploadProviders(telemetry);
  await appendUploadLog(home, 'scan-start', {
    endpointConfigured: Boolean(baseUrl),
    providers,
    cursorAuthority: 'server-usage-status',
  });

  const token = await getValidBearerToken(home, baseUrl);
  if (!token) {
    await appendUploadLog(home, 'waiting-login', { providers });
    return emptyStatus(true, Boolean(baseUrl), { lastError: '等待登录' });
  }

  const authError = await probeAuth(baseUrl, token, home);
  if (authError) {
    await appendUploadLog(home, 'auth-unavailable', { providers, lastError: authError });
    return emptyStatus(true, Boolean(baseUrl), { lastError: authError });
  }

  const generatedAt = new Date(referenceMs).toISOString();
  const channels = new Map<string, UsageStatusChannel | null>();
  const availableProviders: UploadPlatform[] = [];
  const unavailableStatuses: ConversationUploadStatus[] = [];
  for (const platform of providers) {
    try {
      channels.set(platform, await fetchUsageChannel(baseUrl, token, platform, home));
      availableProviders.push(platform);
    } catch (error) {
      const message = `${platform} 的服务端 /report/usage/status 不可用，本轮只跳过该平台：${sanitizeUploadError(error)}`;
      unavailableStatuses.push(emptyStatus(true, true, { lastError: message }));
      await appendUploadLog(home, 'server-cursor-unavailable', {
        platform,
        lastError: message,
      });
    }
  }
  if (availableProviders.length === 0) return mergeStatuses(unavailableStatuses);

  // Upload each platform channel concurrently: they target independent
  // eventId-dedup namespaces, so there is no contention between them.
  // appendUploadLog uses single-line atomic appendFile, so interleaved channel
  // logs stay line-coherent.
  const results = await Promise.allSettled(
    availableProviders.map((platform) =>
      uploadPlatformMessages(
        platform,
        channels.get(platform) ?? null,
        cfg,
        home,
        baseUrl,
        token,
        generatedAt
      )
    )
  );
  const statuses = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    // Await every provider before releasing the upload lock. Promise.all would
    // return on the first rejection while other channels kept posting in the
    // background, leaking work into the next scan/test and allowing overlap.
    const message = failures
      .map((error) =>
        error instanceof ServerUnavailableError
          ? `服务端不可用，已跳过本次上报：${error.message}`
          : `上报异常：${sanitizeUploadError(error)}`
      )
      .join('；');
    await appendUploadLog(home, 'server-unavailable', { providers, lastError: message });
    statuses.push(emptyStatus(true, true, { lastError: message }));
  }
  return mergeStatuses([...unavailableStatuses, ...statuses]);
}

export async function uploadConversationMessages(
  cfg: ConversationUploadConfig,
  referenceMs = Date.now()
): Promise<ConversationUploadStatus> {
  const telemetry = cfg.telemetry;
  const conversationCfg = telemetry?.conversations;
  const enabled = isConversationUploadEnabled(cfg);
  const baseUrl = resolveConversationUploadBaseUrl(conversationCfg?.baseUrl);
  if (!enabled) return emptyStatus(false, Boolean(baseUrl));
  const home = hermitHome();
  const result = await withUploadLock(home, () =>
    uploadConversationMessagesLocked(cfg, referenceMs)
  );
  return (
    result ??
    emptyStatus(true, Boolean(baseUrl), { lastError: '已有消息上报任务正在运行，本轮已跳过' })
  );
}
