/**
 * SessionUsageParser - reads Claude Code, Codex, and Pi JSONL session files and
 * extracts metadata-only usage metrics (tokens, message counts, tool calls).
 *
 * Modeled after CCPal's parse_jsonl() / build_index() from
 * https://github.com/lujinian1982/ccpal
 */

import { createReadStream, realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { getProjectDirNameCandidates, getProjectsBasePath } from '@main/utils/pathDecoder';

import { CodexUsageAccumulator, isCodexTokenCountRecord } from './codexTokenUsage';
import { resolveUsageTotalTokens } from './tokenUsageTotals';

export type UsageProvider = 'claudecode' | 'codex' | 'pi';

export interface UsageProviderMetrics {
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  tokensTotal: number;
}

export interface SessionEntry {
  provider: UsageProvider;
  relPath: string;
  projectPath: string;
  title: string;
  messageCount: number;
  toolCalls: Record<string, number>;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  };
  startTime: string;
  endTime: string;
  fileSize: number;
  mtime: number;
  isWorktree: boolean;
}

export interface UsageAggregate {
  sessions: number;
  messages: number;
  imMessages: number;
  imTotalTokens: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  };
  activeDays: number;
  daily: Record<string, DailyMetrics>;
  hourly: number[];
  projects: ProjectMetricsEntry[];
  events7d: EventEntry[];
  workSecondsByDay: Record<string, number>;
  byProvider: Record<UsageProvider, UsageProviderMetrics>;
}

export interface DailyMetrics {
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  tokensTotal: number;
  workSeconds: number;
}

export interface ProjectMetricsEntry {
  provider: UsageProvider;
  cwd: string;
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
}

export interface EventEntry {
  provider: UsageProvider;
  ts: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  tokensTotal: number;
}

export interface ParseResult {
  sessions: SessionEntry[];
  aggregate: UsageAggregate;
}

const SEG_GAP_MS = 10 * 60 * 1000; // 10 minutes gap threshold
const RECENT_DAYS = 7;
const SCAN_YIELD_FILE_INTERVAL = 25;
const SCAN_LINE_YIELD_INTERVAL = 500;

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function recentWindowStartMs(referenceMs: number): number {
  const reference = new Date(referenceMs);
  return Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate() - (RECENT_DAYS - 1)
  );
}

function recentWindowEndMs(referenceMs: number): number {
  const reference = new Date(referenceMs);
  return Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() + 1);
}

function shouldYieldAfterFile(filesScanned: number): boolean {
  return filesScanned > 0 && filesScanned % SCAN_YIELD_FILE_INTERVAL === 0;
}

function extractFirstUserText(content: unknown): string {
  if (typeof content === 'string') {
    return content.slice(0, 200).trim();
  }
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      return b.text.slice(0, 200).trim();
    }
  }
  return '';
}

function smartTitle(text: string, maxLen = 90): string {
  if (!text) return '';
  let t = text;
  if (t.startsWith('@') && t.includes(' ')) {
    t = t.slice(t.indexOf(' ') + 1).trim();
  }
  let cut = t.length;
  for (const sep of ['\n', '。', '?', '！', '；']) {
    const i = t.indexOf(sep);
    if (5 < i && i < maxLen && i < cut) cut = i;
  }
  return t.slice(0, cut < t.length ? cut : maxLen).trim();
}

function extractToolCalls(content: unknown, counts: Record<string, number>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if ((b.type === 'tool_use' || b.type === 'toolCall') && typeof b.name === 'string') {
      counts[b.name] = (counts[b.name] ?? 0) + 1;
    }
  }
}

function canonicalizeProjectPath(cwd: string): string {
  const raw = String(cwd || '')
    .trim()
    .normalize('NFC');
  if (!raw) return '';

  const expanded =
    raw === '~'
      ? os.homedir()
      : raw.startsWith('~/') || raw.startsWith('~\\')
        ? path.join(os.homedir(), raw.slice(2))
        : raw;
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  const normalized = path.normalize(absolute);

  try {
    return realpathSync.native(normalized);
  } catch {
    return normalized;
  }
}

function normalizeCwd(cwd: string): { normalized: string; isWorktree: boolean } {
  if (!cwd) return { normalized: cwd, isWorktree: false };
  const canonical = canonicalizeProjectPath(cwd);
  const parts = canonical.split(path.sep);
  const idx = parts.indexOf('.claude');
  const isWorktree = idx >= 0 && idx + 1 < parts.length && parts[idx + 1] === 'worktrees';
  const normalized = isWorktree ? parts.slice(0, idx).join(path.sep) || path.sep : canonical;
  return { normalized, isWorktree };
}

interface ParsedSession {
  provider: UsageProvider;
  title: string;
  projectPath: string;
  isWorktree: boolean;
  messageCount: number;
  imMessageCount: number;
  imTotalTokens: number;
  toolCalls: Record<string, number>;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  };
  startTime: string;
  endTime: string;
  dailyTokens: Record<string, DailyMetrics>;
  hourly: number[];
  events: EventEntry[];
}

async function parseJsonl(
  filePath: string,
  provider: UsageProvider = 'claudecode',
  seenMessageKeys?: Set<string>
): Promise<ParsedSession | null> {
  let messageCount = 0;
  let imMessageCount = 0;
  let imTotalTokens = 0;
  let title = '';
  let rawCwd = '';
  let isWorktree = false;
  const toolCalls: Record<string, number> = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  let startTime = '';
  let endTime = '';
  const dailyTokens: Record<string, DailyMetrics> = {};
  const hourly: number[] = new Array(24).fill(0);
  const events: EventEntry[] = [];

  const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });

  let linesScanned = 0;
  for await (const rawLine of rl) {
    linesScanned += 1;
    if (linesScanned % SCAN_LINE_YIELD_INTERVAL === 0) await yieldToEventLoop();
    const line = rawLine.trim();
    if (!line) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (!rawCwd && typeof obj.cwd === 'string') {
      rawCwd = obj.cwd;
      isWorktree = normalizeCwd(rawCwd).isWorktree;
    }

    const msg = obj.message as Record<string, unknown> | undefined;
    let role: string | undefined;
    let content: unknown;
    let usage: Record<string, unknown> | undefined;
    let ts: string | undefined;

    if (msg && typeof msg === 'object') {
      role = msg.role as string | undefined;
      content = msg.content;
      usage = msg.usage as Record<string, unknown> | undefined;
      ts = (obj.timestamp ?? msg.timestamp) as string | undefined;
    } else if (obj.type === 'user' || obj.type === 'assistant') {
      role = obj.type as string;
      content = obj.content;
      usage = obj.usage as Record<string, unknown> | undefined;
      ts = obj.timestamp as string | undefined;
    }

    if (!role || !ts) continue;

    if (provider === 'pi' && seenMessageKeys) {
      const entryId = typeof obj.id === 'string' ? obj.id : '';
      const messageTimestamp = msg?.timestamp ?? ts;
      if (entryId) {
        const messageKey = `${entryId}\u0000${String(messageTimestamp)}\u0000${role}`;
        if (seenMessageKeys.has(messageKey)) continue;
        seenMessageKeys.add(messageKey);
      }
    }

    messageCount++;
    // IM attribution: a record carrying an `im` object originated from the
    // hermit-bridge IM channel (飞书 etc.). Tallied in the local scan so the
    // plain/IM split is visible without depending on the server-gated upload.
    if (obj.im && typeof obj.im === 'object') imMessageCount++;

    if (role === 'user' && !title && content) {
      title = smartTitle(extractFirstUserText(content));
    }

    if (role === 'assistant' && content) {
      extractToolCalls(content, toolCalls);
    }

    if (role === 'assistant' && usage && typeof usage === 'object') {
      const inp = Number(usage.input_tokens ?? usage.inputTokens ?? usage.input ?? 0) || 0;
      const out = Number(usage.output_tokens ?? usage.outputTokens ?? usage.output ?? 0) || 0;
      const cread =
        Number(usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cacheRead ?? 0) || 0;
      const ccreate =
        Number(
          usage.cache_creation_input_tokens ??
            usage.cacheCreationTokens ??
            usage.cacheWriteTokens ??
            usage.cacheWrite ??
            0
        ) || 0;
      const total = resolveUsageTotalTokens(usage, {
        inputTokens: inp,
        outputTokens: out,
        cacheReadTokens: cread,
        cacheCreationTokens: ccreate,
      });

      tokens.input += inp;
      tokens.output += out;
      tokens.cacheRead += cread;
      tokens.cacheCreation += ccreate;
      tokens.total += total;
      if (obj.im && typeof obj.im === 'object') imTotalTokens += total;

      // Daily aggregation
      const day = ts.slice(0, 10);
      if (day.length === 10) {
        const d = (dailyTokens[day] ??= {
          sessions: 0,
          messages: 0,
          tokensIn: 0,
          tokensOut: 0,
          cacheRead: 0,
          cacheCreation: 0,
          tokensTotal: 0,
          workSeconds: 0,
        });
        d.messages++;
        d.tokensIn += inp;
        d.tokensOut += out;
        d.cacheRead += cread;
        d.cacheCreation += ccreate;
        d.tokensTotal += total;
      }

      // Hourly distribution
      const hour = Number(ts.slice(11, 13));
      if (hour >= 0 && hour < 24) {
        hourly[hour]++;
      }

      // Events for work seconds calculation
      const tsUnix = Date.parse(ts) / 1000;
      if (!isNaN(tsUnix)) {
        events.push({
          provider,
          ts: tsUnix,
          tokensIn: inp,
          tokensOut: out,
          cacheRead: cread,
          cacheCreation: ccreate,
          tokensTotal: total,
        });
      }
    }

    if (!startTime) startTime = ts;
    endTime = ts;
  }

  if (messageCount === 0) return null;

  return {
    provider,
    title,
    projectPath: normalizeCwd(rawCwd).normalized,
    isWorktree,
    messageCount,
    imMessageCount,
    imTotalTokens,
    toolCalls,
    tokens,
    startTime,
    endTime,
    dailyTokens,
    hourly,
    events,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function piSessionsRoot(): string {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  return path.join(agentDir, 'sessions');
}

async function parseCodexJsonl(filePath: string): Promise<ParsedSession | null> {
  let rawCwd = '';
  let model = '';
  let messageCount = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  let startTime = '';
  let endTime = '';
  const dailyTokens: Record<string, DailyMetrics> = {};
  const hourly: number[] = new Array(24).fill(0);
  const events: EventEntry[] = [];
  const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });
  let linesScanned = 0;
  // Per-session accumulator: converts cumulative `total_token_usage` snapshots
  // into per-turn deltas so the local total never double-counts prior turns.
  const usageAccumulator = new CodexUsageAccumulator({ assumeStartsFromZero: true });
  for await (const rawLine of rl) {
    linesScanned += 1;
    if (linesScanned % SCAN_LINE_YIELD_INTERVAL === 0) await yieldToEventLoop();
    const line = rawLine.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = objectRecord(obj.payload);
    if (payload) {
      if (typeof payload.cwd === 'string' && payload.cwd) rawCwd = payload.cwd;
      if (!rawCwd && Array.isArray(payload.workspace_roots)) {
        const firstRoot = payload.workspace_roots.find((root) => typeof root === 'string' && root);
        if (typeof firstRoot === 'string') rawCwd = firstRoot;
      }
      if (typeof payload.model === 'string' && payload.model) model = payload.model;
      if (!model && typeof payload.model_provider === 'string' && payload.model_provider)
        model = payload.model_provider;
    }
    if (!isCodexTokenCountRecord(obj)) continue;
    const usage = usageAccumulator.consume(obj);
    if (!usage) continue;
    const ts =
      typeof obj.timestamp === 'string'
        ? obj.timestamp
        : typeof payload?.timestamp === 'string'
          ? payload.timestamp
          : '';
    if (!ts) continue;

    messageCount++;
    tokens.input += usage.inputTokens;
    tokens.output += usage.outputTokens;
    tokens.cacheRead += usage.cacheReadTokens;
    tokens.cacheCreation += usage.cacheCreationTokens;
    tokens.total += usage.totalTokens;

    const day = ts.slice(0, 10);
    if (day.length === 10) {
      const d = (dailyTokens[day] ??= {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
        workSeconds: 0,
      });
      d.messages++;
      d.tokensIn += usage.inputTokens;
      d.tokensOut += usage.outputTokens;
      d.cacheRead += usage.cacheReadTokens;
      d.cacheCreation += usage.cacheCreationTokens;
      d.tokensTotal += usage.totalTokens;
    }
    const hour = Number(ts.slice(11, 13));
    if (hour >= 0 && hour < 24) hourly[hour]++;
    const tsUnix = Date.parse(ts) / 1000;
    if (!isNaN(tsUnix))
      events.push({
        provider: 'codex',
        ts: tsUnix,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheCreation: usage.cacheCreationTokens,
        tokensTotal: usage.totalTokens,
      });
    if (!startTime) startTime = ts;
    endTime = ts;
  }

  if (messageCount === 0) return null;
  const projectPath = normalizeCwd(rawCwd || path.dirname(filePath)).normalized;
  return {
    provider: 'codex',
    title: model ? `Codex ${model}` : 'Codex token usage',
    projectPath,
    isWorktree: false,
    messageCount,
    imMessageCount: 0,
    imTotalTokens: 0,
    toolCalls: {},
    tokens,
    startTime,
    endTime,
    dailyTokens,
    hourly,
    events,
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
    if (entry.isDirectory()) {
      yield* walkJsonl(full);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield full;
    }
  }
}

function calcWorkSeconds(events: EventEntry[]): Record<string, number> {
  // Group events by day
  const byDay: Record<string, number[]> = {};
  for (const ev of events) {
    const day = new Date(ev.ts * 1000).toISOString().slice(0, 10);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(ev.ts);
  }

  const workSeconds: Record<string, number> = {};
  for (const [day, tsList] of Object.entries(byDay)) {
    if (tsList.length === 0) continue;
    tsList.sort((a, b) => a - b);

    let total = 0;
    let segStart = tsList[0];
    let last = tsList[0];

    for (const t of tsList.slice(1)) {
      if (t - last > SEG_GAP_MS / 1000) {
        total += last - segStart;
        segStart = t;
      }
      last = t;
    }
    total += last - segStart;

    // Minimum 60 seconds if there are events but total is 0
    if (total === 0 && tsList.length > 0) {
      total = 60;
    }

    workSeconds[day] = Math.round(total);
  }

  return workSeconds;
}

export interface ProjectUsageStats {
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  totalTokens: number;
  durationMs: number;
}

/**
 * Full-file usage stats for one work directory.
 * Full-file stats are used by the digital worker list to avoid the old first-200-line
 * approximation. Callers decide whether their displayed total includes cache tokens.
 */
export async function scanProjectStats(workDir: string): Promise<ProjectUsageStats | null> {
  if (!workDir) return null;

  const projectsRoot = getProjectsBasePath();
  const jsonlDirs = Array.from(
    new Set(
      getProjectDirNameCandidates(workDir)
        .filter((candidate) => !path.isAbsolute(candidate))
        .map((candidate) => path.join(projectsRoot, candidate))
    )
  );
  const normalizedWorkDir = normalizeCwd(workDir).normalized;
  const stats: ProjectUsageStats = {
    sessions: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheCreation: 0,
    totalTokens: 0,
    durationMs: 0,
  };
  let earliest = '';
  let latest = '';

  for (const jsonlDir of jsonlDirs) {
    let filesScanned = 0;
    for await (const filePath of walkJsonl(jsonlDir)) {
      filesScanned += 1;
      if (shouldYieldAfterFile(filesScanned)) await yieldToEventLoop();
      const parsed = await parseJsonl(filePath);
      if (!parsed) continue;
      if (parsed.projectPath && parsed.projectPath !== normalizedWorkDir) continue;

      stats.sessions++;
      stats.messages += parsed.messageCount;
      stats.tokensIn += parsed.tokens.input;
      stats.tokensOut += parsed.tokens.output;
      stats.cacheRead += parsed.tokens.cacheRead;
      stats.cacheCreation += parsed.tokens.cacheCreation;
      stats.totalTokens += parsed.tokens.total;
      if (parsed.startTime && (!earliest || parsed.startTime < earliest))
        earliest = parsed.startTime;
      if (parsed.endTime && (!latest || parsed.endTime > latest)) latest = parsed.endTime;
    }
  }

  if (stats.sessions === 0) return null;
  if (earliest && latest) {
    stats.durationMs = Math.max(0, Date.parse(latest) - Date.parse(earliest));
  }
  return stats;
}

function emptyProviderMetrics(): UsageProviderMetrics {
  return {
    sessions: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheCreation: 0,
    tokensTotal: 0,
  };
}

function addProviderMetrics(
  aggregate: UsageAggregate,
  provider: UsageProvider,
  parsed: ParsedSession
): void {
  const metrics = aggregate.byProvider[provider];
  metrics.sessions++;
  metrics.messages += parsed.messageCount;
  metrics.tokensIn += parsed.tokens.input;
  metrics.tokensOut += parsed.tokens.output;
  metrics.cacheRead += parsed.tokens.cacheRead;
  metrics.cacheCreation += parsed.tokens.cacheCreation;
  metrics.tokensTotal += parsed.tokens.total;
}

// Per-file parse cache. The telemetry worker re-runs scanSessions every
// interval (5min default) and session JSONLs are effectively append-only, so
// re-parsing ~1GB of unchanged files every tick is pure waste — it was the
// source of the periodic ~10s full-core spikes ("一卡一卡"). Keyed by
// path+size+mtime; a grown/touched file is re-parsed, a deleted one simply
// never appears in the walk. In-memory only: the long-lived worker keeps it
// warm across ticks, one-shot scans are unaffected.
const parseJsonlCache = new Map<
  string,
  { size: number; mtimeMs: number; parsed: ParsedSession | null }
>();

async function parseJsonlCached(
  filePath: string,
  fileStat: { size: number; mtimeMs: number }
): Promise<ParsedSession | null> {
  const hit = parseJsonlCache.get(filePath);
  if (hit?.size === fileStat.size && hit.mtimeMs === fileStat.mtimeMs) return hit.parsed;
  const parsed = await parseJsonl(filePath);
  // Bound memory: dev machines accumulate thousands of session files over time.
  if (parseJsonlCache.size >= 10_000) parseJsonlCache.clear();
  parseJsonlCache.set(filePath, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, parsed });
  return parsed;
}

export async function scanSessions(referenceMs = Date.now()): Promise<ParseResult> {
  const sessions: SessionEntry[] = [];
  const aggregate: UsageAggregate = {
    sessions: 0,
    messages: 0,
    imMessages: 0,
    imTotalTokens: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
    activeDays: 0,
    daily: {},
    hourly: new Array(24).fill(0),
    projects: [],
    events7d: [],
    workSecondsByDay: {},
    byProvider: {
      claudecode: emptyProviderMetrics(),
      codex: emptyProviderMetrics(),
      pi: emptyProviderMetrics(),
    },
  };

  const activeDaySet = new Set<string>();
  const allEvents: EventEntry[] = [];
  const projectMap: Record<string, ProjectMetricsEntry> = {};
  const projectsRoot = getProjectsBasePath();
  let claudeFilesScanned = 0;
  for await (const filePath of walkJsonl(projectsRoot)) {
    claudeFilesScanned += 1;
    if (shouldYieldAfterFile(claudeFilesScanned)) await yieldToEventLoop();
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }

    const parsed = await parseJsonlCached(filePath, fileStat);
    if (!parsed) continue;

    const relPath = path.relative(projectsRoot, filePath);
    sessions.push({
      provider: parsed.provider,
      relPath,
      projectPath: parsed.projectPath,
      title: parsed.title,
      messageCount: parsed.messageCount,
      toolCalls: parsed.toolCalls,
      tokens: parsed.tokens,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      fileSize: fileStat.size,
      mtime: fileStat.mtimeMs,
      isWorktree: parsed.isWorktree,
    });

    aggregate.sessions++;
    aggregate.messages += parsed.messageCount;
    aggregate.imMessages += parsed.imMessageCount;
    aggregate.imTotalTokens += parsed.imTotalTokens;
    aggregate.tokens.input += parsed.tokens.input;
    aggregate.tokens.output += parsed.tokens.output;
    aggregate.tokens.cacheRead += parsed.tokens.cacheRead;
    aggregate.tokens.cacheCreation += parsed.tokens.cacheCreation;
    aggregate.tokens.total += parsed.tokens.total;
    addProviderMetrics(aggregate, parsed.provider, parsed);

    // Hourly
    for (let h = 0; h < 24; h++) {
      aggregate.hourly[h] += parsed.hourly[h];
    }

    // Events
    allEvents.push(...parsed.events);

    // Daily
    for (const [day, m] of Object.entries(parsed.dailyTokens)) {
      activeDaySet.add(day);
      const d = (aggregate.daily[day] ??= {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
        workSeconds: 0,
      });
      d.sessions++;
      d.messages += m.messages;
      d.tokensIn += m.tokensIn;
      d.tokensOut += m.tokensOut;
      d.cacheRead += m.cacheRead;
      d.cacheCreation += m.cacheCreation;
      d.tokensTotal += m.tokensTotal;
    }

    // Projects
    const proj = parsed.projectPath || '(untracked)';
    const projectKey = `${parsed.provider}:${proj}`;
    if (!projectMap[projectKey]) {
      projectMap[projectKey] = {
        provider: parsed.provider,
        cwd: proj,
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensTotal: 0,
      };
    }
    const p = projectMap[projectKey];
    p.sessions++;
    p.messages += parsed.messageCount;
    p.tokensIn += parsed.tokens.input;
    p.tokensOut += parsed.tokens.output;
    p.tokensTotal += parsed.tokens.total;
  }

  const codexRoot = codexHome();
  for (const root of [
    path.join(codexRoot, 'sessions'),
    path.join(codexRoot, 'archived_sessions'),
  ]) {
    let codexFilesScanned = 0;
    for await (const filePath of walkJsonl(root)) {
      codexFilesScanned += 1;
      if (shouldYieldAfterFile(codexFilesScanned)) await yieldToEventLoop();
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }
      const parsed = await parseCodexJsonl(filePath);
      if (!parsed) continue;
      sessions.push({
        provider: 'codex',
        relPath: `codex:${path.relative(codexRoot, filePath)}`,
        projectPath: parsed.projectPath,
        title: parsed.title,
        messageCount: parsed.messageCount,
        toolCalls: parsed.toolCalls,
        tokens: parsed.tokens,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        fileSize: fileStat.size,
        mtime: fileStat.mtimeMs,
        isWorktree: parsed.isWorktree,
      });
      aggregate.sessions++;
      aggregate.messages += parsed.messageCount;
      aggregate.tokens.input += parsed.tokens.input;
      aggregate.tokens.output += parsed.tokens.output;
      aggregate.tokens.cacheRead += parsed.tokens.cacheRead;
      aggregate.tokens.cacheCreation += parsed.tokens.cacheCreation;
      aggregate.tokens.total += parsed.tokens.total;
      addProviderMetrics(aggregate, 'codex', parsed);
      for (let h = 0; h < 24; h++) aggregate.hourly[h] += parsed.hourly[h];
      allEvents.push(...parsed.events);
      for (const [day, m] of Object.entries(parsed.dailyTokens)) {
        activeDaySet.add(day);
        const d = (aggregate.daily[day] ??= {
          sessions: 0,
          messages: 0,
          tokensIn: 0,
          tokensOut: 0,
          cacheRead: 0,
          cacheCreation: 0,
          tokensTotal: 0,
          workSeconds: 0,
        });
        d.sessions++;
        d.messages += m.messages;
        d.tokensIn += m.tokensIn;
        d.tokensOut += m.tokensOut;
        d.cacheRead += m.cacheRead;
        d.cacheCreation += m.cacheCreation;
        d.tokensTotal += m.tokensTotal;
      }
      const proj = parsed.projectPath || '(untracked)';
      const projectKey = `codex:${proj}`;
      if (!projectMap[projectKey]) {
        projectMap[projectKey] = {
          provider: 'codex',
          cwd: proj,
          sessions: 0,
          messages: 0,
          tokensIn: 0,
          tokensOut: 0,
          tokensTotal: 0,
        };
      }
      const p = projectMap[projectKey];
      p.sessions++;
      p.messages += parsed.messageCount;
      p.tokensIn += parsed.tokens.input;
      p.tokensOut += parsed.tokens.output;
      p.tokensTotal += parsed.tokens.total;
    }
  }

  const piRoot = piSessionsRoot();
  const piFiles: string[] = [];
  for await (const filePath of walkJsonl(piRoot)) piFiles.push(filePath);
  // Pi clone/fork sessions copy prior entries verbatim into a newer JSONL file.
  // Scan chronologically so the original record owns attribution and copied
  // entries can be ignored by the shared semantic message key.
  piFiles.sort(
    (left, right) =>
      path.basename(left).localeCompare(path.basename(right)) || left.localeCompare(right)
  );
  const seenPiMessageKeys = new Set<string>();
  let piFilesScanned = 0;
  for (const filePath of piFiles) {
    piFilesScanned += 1;
    if (shouldYieldAfterFile(piFilesScanned)) await yieldToEventLoop();
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }
    const parsed = await parseJsonl(filePath, 'pi', seenPiMessageKeys);
    if (!parsed) continue;
    sessions.push({
      provider: 'pi',
      relPath: `pi:${path.relative(piRoot, filePath)}`,
      projectPath: parsed.projectPath,
      title: parsed.title,
      messageCount: parsed.messageCount,
      toolCalls: parsed.toolCalls,
      tokens: parsed.tokens,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      fileSize: fileStat.size,
      mtime: fileStat.mtimeMs,
      isWorktree: parsed.isWorktree,
    });
    aggregate.sessions++;
    aggregate.messages += parsed.messageCount;
    aggregate.tokens.input += parsed.tokens.input;
    aggregate.tokens.output += parsed.tokens.output;
    aggregate.tokens.cacheRead += parsed.tokens.cacheRead;
    aggregate.tokens.cacheCreation += parsed.tokens.cacheCreation;
    aggregate.tokens.total += parsed.tokens.total;
    addProviderMetrics(aggregate, 'pi', parsed);
    for (let h = 0; h < 24; h++) aggregate.hourly[h] += parsed.hourly[h];
    allEvents.push(...parsed.events);
    for (const [day, metrics] of Object.entries(parsed.dailyTokens)) {
      activeDaySet.add(day);
      const daily = (aggregate.daily[day] ??= {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
        workSeconds: 0,
      });
      daily.sessions++;
      daily.messages += metrics.messages;
      daily.tokensIn += metrics.tokensIn;
      daily.tokensOut += metrics.tokensOut;
      daily.cacheRead += metrics.cacheRead;
      daily.cacheCreation += metrics.cacheCreation;
      daily.tokensTotal += metrics.tokensTotal;
    }
    const projectPath = parsed.projectPath || '(untracked)';
    const projectKey = `pi:${projectPath}`;
    if (!projectMap[projectKey]) {
      projectMap[projectKey] = {
        provider: 'pi',
        cwd: projectPath,
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensTotal: 0,
      };
    }
    const projectMetrics = projectMap[projectKey];
    projectMetrics.sessions++;
    projectMetrics.messages += parsed.messageCount;
    projectMetrics.tokensIn += parsed.tokens.input;
    projectMetrics.tokensOut += parsed.tokens.output;
    projectMetrics.tokensTotal += parsed.tokens.total;
  }

  // Work seconds per day
  aggregate.workSecondsByDay = calcWorkSeconds(allEvents);
  for (const [day, secs] of Object.entries(aggregate.workSecondsByDay)) {
    if (aggregate.daily[day]) {
      aggregate.daily[day].workSeconds = secs;
    }
  }

  // Recent 7-day window aligned with the server UI's date-bucket filter:
  // include the UTC date containing the scan reference plus the previous six UTC
  // dates, and end at the next UTC midnight. The server filters on
  // message.occurredAt in this date range; using the same half-open bucket keeps
  // the local “最近 7 天” row comparable to the remote dashboard.
  const windowEnd = recentWindowEndMs(referenceMs) / 1000;
  const cutoff = recentWindowStartMs(referenceMs) / 1000;
  aggregate.events7d = allEvents
    .filter((e) => e.ts >= cutoff && e.ts < windowEnd)
    .sort((a, b) => a.ts - b.ts);

  aggregate.activeDays = activeDaySet.size;

  // Projects sorted by messages descending
  aggregate.projects = Object.values(projectMap).sort((a, b) => b.messages - a.messages);

  sessions.sort((a, b) => b.endTime.localeCompare(a.endTime));

  return { sessions, aggregate };
}
