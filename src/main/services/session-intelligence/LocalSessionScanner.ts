/**
 * LocalSessionScanner — scans local JSONL session files for a team's workDir
 * and returns lightweight summaries + on-demand message detail with pagination.
 *
 * Replaces the cc-connect dependency for team session listing/detail.
 * Reuses patterns from SessionUsageParser (walkJsonl, streaming parse, stat caching).
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { getProjectDirNameCandidates, getProjectsBasePath } from '@main/utils/pathDecoder';

import { resolveUsageTotalTokens } from './tokenUsageTotals';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalSessionSummary {
  id: string;
  title: string;
  projectId: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  model: string;
  active: boolean;
  live: boolean;
  startTime: string | null;
  endTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface LocalSessionDetail {
  id: string;
  name: string;
  sessionKey: string;
  agentType: string;
  active: boolean;
  live: boolean;
  historyCount: number;
  createdAt: string;
  updatedAt: string;
  platform: string;
  history: LocalSessionMessage[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SummaryCacheEntry {
  size: number;
  mtimeMs: number;
  summary: LocalSessionSummary;
}

interface PartialSummary {
  title: string;
  model: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  startTime: string | null;
  endTime: string | null;
  lastRole: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const SUMMARY_SCAN_LINES = 200; // Read first N lines for lightweight summary

// ---------------------------------------------------------------------------
// Helpers (adapted from SessionUsageParser & ConversationTelemetryService)
// ---------------------------------------------------------------------------

/**
 * Extract readable text from any content block type.
 * Handles: text, thinking, tool_use, tool_result, image.
 * Mirrors ConversationTelemetryService.extractText().
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      parts.push('[Thinking omitted]');
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      parts.push(`[Tool: ${b.name}${toolInputSummary(b.name, b.input)}]`);
    } else if (b.type === 'tool_result') {
      const nested = b.content;
      if (typeof nested === 'string') parts.push(nested);
      else if (Array.isArray(nested)) parts.push(extractText(nested));
    } else if (b.type === 'image') {
      parts.push('[Image]');
    }
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Produce a short human-readable summary of a tool_use input.
 * e.g. "Read /src/main/server.ts", "Edit /src/main/server.ts", "Bash pnpm test"
 */
function toolInputSummary(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;

  // Common patterns by tool name
  const fileKey = inp.file_path ?? inp.filePath ?? inp.path;
  const cmdKey = inp.command ?? inp.description;

  if (typeof fileKey === 'string') {
    // Show only the last 2 path segments to keep it short
    const short = fileKey.split('/').slice(-2).join('/');
    return ` ${short}`;
  }
  if (typeof cmdKey === 'string') {
    return ` ${cmdKey.slice(0, 80)}`;
  }

  // Generic: show first string-valued field
  for (const value of Object.values(inp)) {
    if (typeof value === 'string' && value.length > 0) {
      return ` ${value.slice(0, 80)}`;
    }
  }
  return '';
}

function extractFirstUserText(content: unknown): string {
  const text = extractText(content);
  return text.slice(0, 200).trim();
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
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.jsonl') &&
      !entry.name.startsWith('agent_')
    ) {
      yield full;
    }
  }
}

/**
 * Quickly scan the first N lines of a JSONL file to extract a lightweight summary.
 * This avoids parsing the entire file for the session list.
 */
async function scanSummaryLines(
  filePath: string,
  sessionId: string,
  projectId: string
): Promise<PartialSummary | null> {
  const result: PartialSummary = {
    title: '',
    model: '',
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    startTime: null,
    endTime: null,
    lastRole: '',
  };

  let lineCount = 0;

  const rl = createInterface({
    input: createReadStream(filePath, 'utf-8'),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    lineCount++;
    if (lineCount > SUMMARY_SCAN_LINES) break;

    const line = rawLine.trim();
    if (!line) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
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

    result.messageCount++;
    if (!result.startTime) result.startTime = ts;
    result.endTime = ts;
    result.lastRole = role;

    if (role === 'user') {
      result.userMessageCount++;
      if (!result.title && content) {
        result.title = smartTitle(extractFirstUserText(content));
      }
    } else if (role === 'assistant') {
      result.assistantMessageCount++;

      // Extract model
      if (!result.model) {
        const model = msg?.model ?? obj.model;
        if (typeof model === 'string' && model) {
          result.model = model;
        }
      }

      // Accumulate token usage
      if (usage && typeof usage === 'object') {
        result.inputTokens += Number(usage.input_tokens ?? 0) || 0;
        result.outputTokens += Number(usage.output_tokens ?? 0) || 0;
        result.cacheReadTokens += Number(usage.cache_read_input_tokens ?? 0) || 0;
        result.cacheCreationTokens += Number(usage.cache_creation_input_tokens ?? 0) || 0;
        result.totalTokens += resolveUsageTotalTokens(usage, {
          inputTokens: Number(usage.input_tokens ?? 0) || 0,
          outputTokens: Number(usage.output_tokens ?? 0) || 0,
          cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0) || 0,
          cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0) || 0,
        });
      }
    }
  }

  if (result.messageCount === 0) return null;
  return result;
}

// ---------------------------------------------------------------------------
// LocalSessionScanner class
// ---------------------------------------------------------------------------

export class LocalSessionScanner {
  private summaryCache = new Map<string, SummaryCacheEntry>();
  private sessionPathByWorkDirAndId = new Map<string, string>();

  private sessionPathKey(workDir: string, sessionId: string): string {
    return `${workDir}\0${sessionId}`;
  }

  /**
   * Resolve possible JSONL directories for a given workDir.
   * workDir is usually the absolute filesystem path (e.g., "/Users/name/project").
   * The JSONL files live at ~/.claude/projects/{encoded-workDir}/, but Claude
   * installations can use portable/legacy encodings, so reuse path candidates.
   */
  private async resolveJsonlDirs(workDir: string): Promise<string[]> {
    const projectsBase = getProjectsBasePath();
    const candidateNames = getProjectDirNameCandidates(workDir).filter(
      (candidate) => !path.isAbsolute(candidate)
    );
    const candidateDirs = Array.from(
      new Set(candidateNames.map((candidate) => path.join(projectsBase, candidate)))
    );

    const existing: string[] = [];
    for (const dir of candidateDirs) {
      try {
        if ((await stat(dir)).isDirectory()) existing.push(dir);
      } catch {
        // ignore missing candidate dirs
      }
    }

    return existing.length > 0 ? existing : candidateDirs.slice(0, 1);
  }

  private async findSessionFile(
    workDir: string,
    sessionId: string
  ): Promise<{ filePath: string; fileStat: Awaited<ReturnType<typeof stat>> } | null> {
    const indexedPath = this.sessionPathByWorkDirAndId.get(this.sessionPathKey(workDir, sessionId));
    if (indexedPath) {
      try {
        return { filePath: indexedPath, fileStat: await stat(indexedPath) };
      } catch {
        this.sessionPathByWorkDirAndId.delete(this.sessionPathKey(workDir, sessionId));
      }
    }

    const jsonlDirs = await this.resolveJsonlDirs(workDir);
    for (const jsonlDir of jsonlDirs) {
      const directPath = path.join(jsonlDir, `${sessionId}.jsonl`);
      try {
        const fileStat = await stat(directPath);
        this.sessionPathByWorkDirAndId.set(this.sessionPathKey(workDir, sessionId), directPath);
        return { filePath: directPath, fileStat };
      } catch {
        // fall through to recursive lookup
      }
    }

    for (const jsonlDir of jsonlDirs) {
      for await (const candidatePath of walkJsonl(jsonlDir)) {
        if (path.basename(candidatePath, '.jsonl') !== sessionId) continue;
        try {
          const fileStat = await stat(candidatePath);
          this.sessionPathByWorkDirAndId.set(
            this.sessionPathKey(workDir, sessionId),
            candidatePath
          );
          return { filePath: candidatePath, fileStat };
        } catch {
          // stale file from the directory walk; keep searching
        }
      }
    }

    return null;
  }

  /**
   * Scan all JSONL session files for a team's workDir and return lightweight summaries.
   * Uses file stat caching to skip unchanged files on subsequent calls.
   */
  async scanSummaries(workDir: string, projectId: string): Promise<LocalSessionSummary[]> {
    const jsonlDirs = await this.resolveJsonlDirs(workDir);
    const summaries: LocalSessionSummary[] = [];
    const now = Date.now();

    for (const jsonlDir of jsonlDirs) {
      for await (const filePath of walkJsonl(jsonlDir)) {
        let fileStat;
        try {
          fileStat = await stat(filePath);
        } catch {
          continue;
        }

        const sessionId = path.basename(filePath, '.jsonl');
        this.sessionPathByWorkDirAndId.set(this.sessionPathKey(workDir, sessionId), filePath);

        // Check cache
        const cached = this.summaryCache.get(filePath);
        if (cached?.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
          summaries.push(cached.summary);
          continue;
        }

        const partial = await scanSummaryLines(filePath, sessionId, projectId);
        if (!partial) continue;

        const mtimeMs = fileStat.mtimeMs;
        const active = now - mtimeMs < ACTIVE_THRESHOLD_MS;
        const live = active && partial.lastRole === 'assistant';

        // For a more accurate messageCount and token totals, we need the full file.
        // But the first SUMMARY_SCAN_LINES is a good approximation for the list view.
        // We'll mark the count as approximate if we stopped early.
        const summary: LocalSessionSummary = {
          id: sessionId,
          title: partial.title || sessionId,
          projectId,
          messageCount: partial.messageCount,
          userMessageCount: partial.userMessageCount,
          assistantMessageCount: partial.assistantMessageCount,
          inputTokens: partial.inputTokens,
          outputTokens: partial.outputTokens,
          cacheReadTokens: partial.cacheReadTokens,
          cacheCreationTokens: partial.cacheCreationTokens,
          totalTokens: partial.totalTokens,
          model: partial.model,
          active,
          live,
          startTime: partial.startTime,
          endTime: partial.endTime,
          createdAt: fileStat.birthtime?.toISOString() ?? new Date(mtimeMs).toISOString(),
          updatedAt: new Date(mtimeMs).toISOString(),
        };

        this.summaryCache.set(filePath, {
          size: fileStat.size,
          mtimeMs,
          summary,
        });

        summaries.push(summary);
      }
    }

    // Sort by endTime descending (most recent first)
    summaries.sort((a, b) => {
      const ta = a.endTime ? Date.parse(a.endTime) : 0;
      const tb = b.endTime ? Date.parse(b.endTime) : 0;
      return tb - ta;
    });

    return summaries;
  }

  /**
   * Read a single session's detail with paginated message history.
   * Messages are returned in chronological order.
   * offset=0, limit=200 returns the first 200 messages.
   * offset=200, limit=200 returns messages 201-400.
   */
  async readSessionDetail(
    workDir: string,
    sessionId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<LocalSessionDetail | null> {
    const resolvedFile = await this.findSessionFile(workDir, sessionId);
    if (!resolvedFile) return null;
    const { filePath, fileStat } = resolvedFile;

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 200;

    const messages: LocalSessionMessage[] = [];
    let totalMessages = 0;
    let model = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let totalTokens = 0;
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    const rl = createInterface({
      input: createReadStream(filePath, 'utf-8'),
      crlfDelay: Infinity,
    });

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
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
      if (role !== 'user' && role !== 'assistant') continue;

      totalMessages++;

      if (!firstTs) firstTs = ts;
      lastTs = ts;

      // Extract model from first assistant message
      if (role === 'assistant' && !model) {
        const m = msg?.model ?? obj.model;
        if (typeof m === 'string' && m) model = m;
      }

      // Accumulate tokens
      if (role === 'assistant' && usage && typeof usage === 'object') {
        inputTokens += Number(usage.input_tokens ?? 0) || 0;
        outputTokens += Number(usage.output_tokens ?? 0) || 0;
        cacheReadTokens += Number(usage.cache_read_input_tokens ?? 0) || 0;
        cacheCreationTokens += Number(usage.cache_creation_input_tokens ?? 0) || 0;
        totalTokens += resolveUsageTotalTokens(usage, {
          inputTokens: Number(usage.input_tokens ?? 0) || 0,
          outputTokens: Number(usage.output_tokens ?? 0) || 0,
          cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0) || 0,
          cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0) || 0,
        });
      }

      // Collect messages within the page range
      if (totalMessages > offset && messages.length < limit) {
        messages.push({
          role: role,
          content: extractText(content),
          timestamp: ts,
        });
      }
    }

    if (totalMessages === 0) return null;

    const now = Date.now();
    const mtimeMs = Number(fileStat.mtimeMs);
    const active = now - mtimeMs < ACTIVE_THRESHOLD_MS;

    return {
      id: sessionId,
      name: '',
      sessionKey: sessionId,
      agentType: '',
      active,
      live: active,
      historyCount: totalMessages,
      createdAt: fileStat.birthtime?.toISOString() ?? new Date(mtimeMs).toISOString(),
      updatedAt: new Date(mtimeMs).toISOString(),
      platform: 'local',
      history: messages,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens,
    };
  }

  /**
   * Clear the summary cache. Useful for testing or forced refresh.
   */
  clearCache(): void {
    this.summaryCache.clear();
    this.sessionPathByWorkDirAndId.clear();
  }
}
