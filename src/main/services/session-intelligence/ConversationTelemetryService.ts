import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { getProjectsBasePath } from '@main/utils/pathDecoder';

import {
  ConversationIdentityResolver,
  type ResolvedConversationIdentity,
} from './ConversationIdentityResolver';
import { resolveUsageTotalTokens } from './tokenUsageTotals';

import type { TeamManifest } from '../team-management/TeamWorkspaceService';
import type { ConversationIdentityRecord } from './ConversationIdentityStore';
import type { HermitBridgeClient } from '@main/services/hermitBridge/HermitBridgeClient';
import type {
  ConversationTelemetryExportFormat,
  ConversationTelemetryExportResponse,
  ConversationTelemetryMessage,
  ConversationTelemetryQuery,
  ConversationTelemetryResponse,
  ConversationTelemetryRow,
} from '@shared/types/api';

interface ClaudeSessionSummary {
  sessionId: string;
  relPath: string;
  filePath: string;
  projectPath?: string;
  startTime?: string;
  endTime?: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolResultCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  assistantTurnsWithUsage: number;
  models: Record<string, number>;
  toolCalls: Record<string, number>;
  messages: ConversationTelemetryMessage[];
}

interface CachedClaudeSession {
  size: number;
  mtimeMs: number;
  parsed: ClaudeSessionSummary;
}

interface ConversationTelemetryServiceOptions {
  cc: HermitBridgeClient;
  listTeams: () => Promise<TeamManifest[]>;
  readTeamManifest: (teamName: string) => Promise<TeamManifest>;
  identityResolver?: ConversationIdentityResolver;
}

interface ConversationProject {
  slug: string;
  displayName: string;
  bindProject: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100_000;

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

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
      parts.push(`[Tool: ${b.name}]`);
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

function countToolCalls(content: unknown, counts: Record<string, number>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      counts[b.name] = (counts[b.name] ?? 0) + 1;
    }
  }
}

function csvEscape(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function formatDateForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
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

export class ConversationTelemetryService {
  private readonly cc: HermitBridgeClient;
  private readonly listTeams: () => Promise<TeamManifest[]>;
  private readonly readTeamManifest: (teamName: string) => Promise<TeamManifest>;
  private readonly identityResolver: ConversationIdentityResolver;
  private readonly claudeCache = new Map<string, CachedClaudeSession>();

  constructor(options: ConversationTelemetryServiceOptions) {
    this.cc = options.cc;
    this.listTeams = options.listTeams;
    this.readTeamManifest = options.readTeamManifest;
    this.identityResolver = options.identityResolver ?? new ConversationIdentityResolver();
  }

  async getConversations(
    query: ConversationTelemetryQuery = {}
  ): Promise<ConversationTelemetryResponse> {
    const includeContent = query.includeContent ?? 'none';
    const limit = Math.min(
      Math.max(Number(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    const platforms = String(query.platform ?? '')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);

    const [claudeIndex, projects] = await Promise.all([
      this.buildClaudeIndex(),
      this.resolveConversationProjects(query.teamName),
    ]);
    const identities = await this.identityResolver.readIdentityRecords();
    const rows: ConversationTelemetryRow[] = [];

    // Track which claude session IDs were already matched by cc-connect
    const matchedClaudeSessionIds = new Set<string>();

    for (const team of projects) {
      const projectName = team.bindProject || team.slug;
      let sessions;
      try {
        sessions = await this.cc.listSessions(projectName);
      } catch {
        continue;
      }

      const deduped = this.dedupeSessions(sessions);
      for (const session of deduped) {
        if (
          platforms.length > 0 &&
          !platforms.includes(String(session.platform ?? '').toLowerCase())
        ) {
          continue;
        }

        this.identityResolver.observeCcSession(identities, {
          teamName: team.slug,
          projectName,
          platform: session.platform,
          sessionKey: session.session_key,
          ccSessionId: session.id,
          userName: session.user_name,
          chatName: session.chat_name,
          createdAt: session.created_at,
          updatedAt: session.updated_at,
        });

        const row = await this.buildRow(team, projectName, session, identities, claudeIndex, {
          includeContent,
          includeToolResults: query.includeToolResults !== false,
          includeSystemMessages: query.includeSystemMessages !== false,
        });
        if (row.session.claudeSessionId) {
          matchedClaudeSessionIds.add(row.session.claudeSessionId);
        }
        if (!this.matchesQuery(row, query)) continue;
        rows.push(row);
      }
    }

    // Include local-only JSONL sessions not tracked by cc-connect
    for (const [sessionId, summaries] of claudeIndex) {
      if (matchedClaudeSessionIds.has(sessionId)) continue;
      for (const summary of summaries) {
        const row = this.buildLocalRow(sessionId, summary, {
          includeContent,
          includeToolResults: query.includeToolResults !== false,
          includeSystemMessages: query.includeSystemMessages !== false,
        });
        if (!this.matchesQuery(row, query)) continue;
        rows.push(row);
      }
    }

    await this.identityResolver.writeIdentityRecords(identities);

    const isRunning = (row: ConversationTelemetryRow): boolean =>
      row.session.live === true || row.session.active === true;
    rows.sort((a, b) => {
      const runningDiff = Number(isRunning(b)) - Number(isRunning(a));
      if (runningDiff !== 0) return runningDiff;
      const aTime = a.session.updatedAt ?? a.session.endTime ?? '';
      const bTime = b.session.updatedAt ?? b.session.endTime ?? '';
      return bTime.localeCompare(aTime);
    });

    const paged = rows.slice(offset, offset + limit);
    const totalTokens = rows.reduce((sum, row) => sum + row.usage.totalTokens, 0);
    const runningConversations = rows.filter(isRunning).length;
    const missingIdentityIds = rows.filter((row) => !row.identity.id).length;
    const unmatchedSessions = rows.filter((row) => row.session.matchStatus !== 'matched').length;

    return {
      rows: paged,
      nextOffset: offset + limit < rows.length ? offset + limit : undefined,
      computedAt: new Date().toISOString(),
      summary: {
        conversations: rows.length,
        runningConversations,
        missingIdentityIds,
        unmatchedSessions,
        totalTokens,
      },
    };
  }

  async getConversationDetail(
    sessionId: string,
    query: ConversationTelemetryQuery = {}
  ): Promise<ConversationTelemetryRow | null> {
    const response = await this.getConversations({
      ...query,
      includeContent: 'full',
      limit: MAX_LIMIT,
      offset: 0,
    });
    return (
      response.rows.find(
        (row) =>
          row.session.ccSessionId === sessionId ||
          row.session.sessionKey === sessionId ||
          row.session.claudeSessionId === sessionId
      ) ?? null
    );
  }

  async exportConversations(
    format: ConversationTelemetryExportFormat,
    query: ConversationTelemetryQuery = {}
  ): Promise<ConversationTelemetryExportResponse> {
    const includeContent = query.includeContent ?? (format === 'csv' ? 'full' : 'full');
    const response = await this.getConversations({
      ...query,
      includeContent,
      limit: query.limit ?? MAX_LIMIT,
      offset: query.offset ?? 0,
    });
    const stamp = formatDateForFilename();

    if (format === 'json') {
      return {
        filename: `conversation-telemetry-${stamp}.json`,
        mimeType: 'application/json;charset=utf-8',
        content: JSON.stringify(response, null, 2),
      };
    }

    if (format === 'markdown') {
      return {
        filename: `conversation-telemetry-${stamp}.md`,
        mimeType: 'text/markdown;charset=utf-8',
        content: this.toMarkdown(response.rows),
      };
    }

    if (format === 'plaintext') {
      return {
        filename: `conversation-telemetry-${stamp}.txt`,
        mimeType: 'text/plain;charset=utf-8',
        content: this.toPlainText(response.rows),
      };
    }

    return {
      filename: `conversation-telemetry-${stamp}.csv`,
      mimeType: 'text/csv;charset=utf-8',
      content: this.toCsv(response.rows),
    };
  }

  private async resolveConversationProjects(teamName?: string): Promise<ConversationProject[]> {
    const localTeams = await this.listTeams().catch(() => []);
    const byProject = new Map<string, ConversationProject>();

    for (const team of localTeams) {
      byProject.set(team.bindProject || team.slug, {
        slug: team.slug,
        displayName: team.displayName,
        bindProject: team.bindProject || team.slug,
      });
    }

    if (teamName?.trim()) {
      const requested = teamName.trim();
      try {
        const team = await this.readTeamManifest(requested);
        return [
          {
            slug: team.slug,
            displayName: team.displayName,
            bindProject: team.bindProject || team.slug,
          },
        ];
      } catch {
        return [
          byProject.get(requested) ?? {
            slug: requested,
            displayName: requested,
            bindProject: requested,
          },
        ];
      }
    }

    try {
      const ccProjects = await this.cc.listProjects();
      for (const project of ccProjects) {
        if (!byProject.has(project.name)) {
          byProject.set(project.name, {
            slug: project.name,
            displayName: project.name,
            bindProject: project.name,
          });
        }
      }
    } catch {
      // Local team projects remain enough for a best-effort telemetry view.
    }

    return [...byProject.values()];
  }

  private dedupeSessions<
    T extends {
      session_key: string;
      updated_at: string;
      active: boolean;
      live: boolean;
      history_count: number;
    },
  >(sessions: T[]): T[] {
    const byKey = new Map<string, T>();
    const score = (session: T): number => {
      const updatedAt = Date.parse(session.updated_at);
      return (
        (session.live ? 1_000_000_000_000_000 : 0) +
        (session.active ? 1_000_000_000_000 : 0) +
        (session.history_count ?? 0) * 1_000_000 +
        (Number.isFinite(updatedAt) ? updatedAt / 1_000_000 : 0)
      );
    };
    for (const session of sessions) {
      const existing = byKey.get(session.session_key);
      if (!existing || score(session) > score(existing)) byKey.set(session.session_key, session);
    }
    return [...byKey.values()];
  }

  private async buildRow(
    team: ConversationProject,
    projectName: string,
    session: {
      id: string;
      name: string;
      session_key: string;
      active: boolean;
      live: boolean;
      history_count: number;
      created_at: string;
      updated_at: string;
      last_message: { role: string; content: string; timestamp: string } | null;
      platform: string;
      user_name?: string;
      chat_name?: string;
    },
    identities: Map<string, ConversationIdentityRecord>,
    claudeIndex: Map<string, ClaudeSessionSummary[]>,
    options: {
      includeContent: 'none' | 'summary' | 'full';
      includeToolResults: boolean;
      includeSystemMessages: boolean;
    }
  ): Promise<ConversationTelemetryRow> {
    const detail = await this.safeGetSessionDetail(projectName, session.id);
    const agentSessionId = normalizeOptional(detail?.agent_session_id);
    const matches = agentSessionId ? (claudeIndex.get(agentSessionId) ?? []) : [];
    const matchStatus = !agentSessionId
      ? 'missing-agent-session-id'
      : matches.length === 0
        ? 'jsonl-not-found'
        : matches.length > 1
          ? 'ambiguous'
          : 'matched';
    const matched = matchStatus === 'matched' ? matches[0] : undefined;
    const resolvedIdentity = this.identityResolver.resolve(identities, {
      teamName: team.slug,
      projectName,
      sessionKey: session.session_key,
      ccSessionId: session.id,
      platform: session.platform,
      sessionName: session.name,
      userName: session.user_name,
      chatName: session.chat_name,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    });

    const messages = this.filterMessages(matched?.messages ?? [], options);
    const userMessages = messages.filter(
      (message) => message.role === 'user' && message.content.trim()
    );
    const firstUserMessage = userMessages[0];
    const lastUserMessage = userMessages[userMessages.length - 1];
    const lastMessage = [...messages].reverse().find((message) => message.content.trim());
    const totalTokens = matched
      ? matched.inputTokens +
        matched.outputTokens +
        matched.cacheReadTokens +
        matched.cacheCreationTokens
      : 0;

    return {
      teamName: team.slug,
      teamDisplayName: team.displayName,
      projectName,
      session: {
        ccSessionId: session.id,
        sessionKey: session.session_key,
        agentSessionId,
        claudeSessionId: matched?.sessionId,
        projectPath: matched?.projectPath,
        jsonlRelPath: matched?.relPath,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        startTime: matched?.startTime,
        endTime: matched?.endTime,
        active: session.active,
        live: session.live,
        matchStatus,
      },
      identity: this.toApiIdentity(resolvedIdentity),
      content: {
        messageCount: matched?.messageCount ?? session.history_count ?? 0,
        userMessageCount: matched?.userMessageCount ?? 0,
        assistantMessageCount: matched?.assistantMessageCount ?? 0,
        toolResultCount: matched?.toolResultCount ?? 0,
        firstUserMessage: firstUserMessage?.content,
        firstUserMessageAt: firstUserMessage?.timestamp,
        lastUserMessage: lastUserMessage?.content,
        lastUserMessageAt: lastUserMessage?.timestamp,
        lastMessageRole: lastMessage?.role,
        lastMessageContent: lastMessage?.content,
        lastMessageAt: lastMessage?.timestamp,
        text: options.includeContent === 'none' ? undefined : this.summarizeMessages(messages),
        messages: options.includeContent === 'full' ? messages : undefined,
      },
      usage: {
        inputTokens: matched?.inputTokens ?? 0,
        outputTokens: matched?.outputTokens ?? 0,
        cacheReadTokens: matched?.cacheReadTokens ?? 0,
        cacheCreationTokens: matched?.cacheCreationTokens ?? 0,
        totalTokens,
        assistantTurnsWithUsage: matched?.assistantTurnsWithUsage ?? 0,
        models: matched?.models ?? {},
        toolCalls: matched?.toolCalls ?? {},
        usageSource: matched ? 'claude-jsonl' : 'missing',
      },
    };
  }

  /** Build a row from local JSONL data only — no cc-connect session. */
  private buildLocalRow(
    sessionId: string,
    summary: ClaudeSessionSummary,
    options: {
      includeContent: 'none' | 'summary' | 'full';
      includeToolResults: boolean;
      includeSystemMessages: boolean;
    }
  ): ConversationTelemetryRow {
    const messages = this.filterMessages(summary.messages, options);
    const userMessages = messages.filter(
      (message) => message.role === 'user' && message.content.trim()
    );
    const firstUserMessage = userMessages[0];
    const lastUserMessage = userMessages[userMessages.length - 1];
    const lastMessage = [...messages].reverse().find((message) => message.content.trim());
    const totalTokens =
      summary.inputTokens +
      summary.outputTokens +
      summary.cacheReadTokens +
      summary.cacheCreationTokens;

    return {
      teamName: '',
      teamDisplayName: '本地会话',
      projectName: '',
      session: {
        ccSessionId: undefined,
        sessionKey: sessionId,
        agentSessionId: undefined,
        claudeSessionId: sessionId,
        projectPath: summary.projectPath,
        jsonlRelPath: summary.relPath,
        createdAt: summary.startTime,
        updatedAt: summary.endTime,
        startTime: summary.startTime,
        endTime: summary.endTime,
        active: false,
        live: false,
        matchStatus: 'local-only',
      },
      identity: {
        platform: 'local',
        type: 'person',
        id: undefined,
        userId: undefined,
        chatId: undefined,
        displayName: summary.projectPath
          ? path.basename(summary.projectPath)
          : sessionId.slice(0, 12),
        userName: undefined,
        chatName: undefined,
        confidence: 'session-key-only',
      },
      content: {
        messageCount: summary.messageCount,
        userMessageCount: summary.userMessageCount,
        assistantMessageCount: summary.assistantMessageCount,
        toolResultCount: summary.toolResultCount,
        firstUserMessage: firstUserMessage?.content,
        firstUserMessageAt: firstUserMessage?.timestamp,
        lastUserMessage: lastUserMessage?.content,
        lastUserMessageAt: lastUserMessage?.timestamp,
        lastMessageRole: lastMessage?.role,
        lastMessageContent: lastMessage?.content,
        lastMessageAt: lastMessage?.timestamp,
        text: options.includeContent === 'none' ? undefined : this.summarizeMessages(messages),
        messages: options.includeContent === 'full' ? messages : undefined,
      },
      usage: {
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        cacheReadTokens: summary.cacheReadTokens,
        cacheCreationTokens: summary.cacheCreationTokens,
        totalTokens,
        assistantTurnsWithUsage: summary.assistantTurnsWithUsage,
        models: summary.models,
        toolCalls: summary.toolCalls,
        usageSource: 'claude-jsonl',
      },
    };
  }

  private async safeGetSessionDetail(projectName: string, sessionId: string) {
    try {
      return await this.cc.getSession(projectName, sessionId, 1);
    } catch {
      return null;
    }
  }

  private matchesQuery(row: ConversationTelemetryRow, query: ConversationTelemetryQuery): boolean {
    if (query.identityType && row.identity.type !== query.identityType) return false;
    if (query.identityId && row.identity.id !== query.identityId) return false;
    if (query.from) {
      const t = Date.parse(row.session.updatedAt ?? row.session.endTime ?? '');
      if (Number.isFinite(t) && t < Date.parse(query.from)) return false;
    }
    if (query.to) {
      const t = Date.parse(row.session.updatedAt ?? row.session.endTime ?? '');
      if (Number.isFinite(t) && t > Date.parse(query.to)) return false;
    }
    return true;
  }

  private async buildClaudeIndex(): Promise<Map<string, ClaudeSessionSummary[]>> {
    const root = getProjectsBasePath();
    const index = new Map<string, ClaudeSessionSummary[]>();

    for await (const filePath of walkJsonl(root)) {
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }

      const cached = this.claudeCache.get(filePath);
      const parsed =
        cached?.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs
          ? cached.parsed
          : await this.parseClaudeJsonl(root, filePath);
      if (cached?.size !== fileStat.size || cached.mtimeMs !== fileStat.mtimeMs) {
        this.claudeCache.set(filePath, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, parsed });
      }

      const bucket = index.get(parsed.sessionId) ?? [];
      bucket.push(parsed);
      index.set(parsed.sessionId, bucket);
    }

    return index;
  }

  private async parseClaudeJsonl(root: string, filePath: string): Promise<ClaudeSessionSummary> {
    const sessionId = path.basename(filePath, '.jsonl');
    const relPath = path.relative(root, filePath);
    const messages: ConversationTelemetryMessage[] = [];
    const models: Record<string, number> = {};
    const toolCalls: Record<string, number> = {};
    let projectPath: string | undefined;
    let startTime: string | undefined;
    let endTime: string | undefined;
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let toolResultCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let assistantTurnsWithUsage = 0;

    const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (!projectPath && typeof obj.cwd === 'string') projectPath = obj.cwd;

      const msg = obj.message as Record<string, unknown> | undefined;
      const rawRole =
        typeof msg?.role === 'string'
          ? msg.role
          : typeof obj.type === 'string'
            ? obj.type
            : undefined;
      if (!rawRole || !['user', 'assistant', 'system'].includes(rawRole)) continue;

      const content = msg && 'content' in msg ? msg.content : obj.content;
      const isToolResultMessage =
        rawRole === 'user' &&
        Array.isArray(content) &&
        content.some(
          (block) =>
            block &&
            typeof block === 'object' &&
            (block as Record<string, unknown>).type === 'tool_result'
        );
      const role: ConversationTelemetryMessage['role'] = isToolResultMessage
        ? 'tool'
        : (rawRole as ConversationTelemetryMessage['role']);
      const timestamp = normalizeOptional(obj.timestamp) ?? normalizeOptional(msg?.timestamp);
      const usage = msg?.usage as Record<string, unknown> | undefined;
      const model = normalizeOptional(msg?.model);
      const text = extractText(content);

      if (role === 'user') userMessageCount++;
      if (role === 'assistant') {
        assistantMessageCount++;
        countToolCalls(content, toolCalls);
        if (model) models[model] = (models[model] ?? 0) + 1;
      }
      if (Array.isArray(content)) {
        toolResultCount += content.filter(
          (block) =>
            block &&
            typeof block === 'object' &&
            (block as Record<string, unknown>).type === 'tool_result'
        ).length;
      }

      let messageUsage: ConversationTelemetryMessage['usage'];
      if (role === 'assistant' && usage) {
        const input = toNumber(usage.input_tokens ?? usage.prompt_tokens);
        const output = toNumber(usage.output_tokens ?? usage.completion_tokens);
        const cacheRead = toNumber(
          usage.cache_read_input_tokens ??
            (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
            (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens
        );
        const cacheCreation = toNumber(usage.cache_creation_input_tokens);
        const total = resolveUsageTotalTokens(usage, {
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
        });
        messageUsage = {
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
          totalTokens: total,
        };
        inputTokens += input;
        outputTokens += output;
        cacheReadTokens += cacheRead;
        cacheCreationTokens += cacheCreation;
        assistantTurnsWithUsage++;
      }

      if (timestamp) {
        if (!startTime) startTime = timestamp;
        endTime = timestamp;
      }

      messages.push({
        role: role,
        timestamp,
        content: text,
        uuid: normalizeOptional(obj.uuid),
        parentUuid: normalizeOptional(obj.parentUuid) ?? null,
        model,
        requestId: normalizeOptional(obj.requestId),
        usage: messageUsage,
        isMeta: obj.isMeta === true,
      });
    }

    return {
      sessionId,
      relPath,
      filePath,
      projectPath,
      startTime,
      endTime,
      messageCount: messages.length,
      userMessageCount,
      assistantMessageCount,
      toolResultCount,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      assistantTurnsWithUsage,
      models,
      toolCalls,
      messages,
    };
  }

  private filterMessages(
    messages: ConversationTelemetryMessage[],
    options: { includeToolResults: boolean; includeSystemMessages: boolean }
  ): ConversationTelemetryMessage[] {
    return messages.filter((message) => {
      if (!options.includeSystemMessages && message.role === 'system') return false;
      if (!options.includeToolResults && message.role === 'tool') return false;
      return true;
    });
  }

  private summarizeMessages(messages: ConversationTelemetryMessage[]): string {
    return messages
      .filter((message) => message.content.trim())
      .slice(0, 20)
      .map((message) => `[${message.timestamp ?? '-'}] ${message.role}: ${message.content}`)
      .join('\n\n');
  }

  private toApiIdentity(
    identity: ResolvedConversationIdentity
  ): ConversationTelemetryRow['identity'] {
    return {
      platform: identity.platform,
      type: identity.type,
      id: identity.id,
      userId: identity.userId,
      chatId: identity.chatId,
      displayName: identity.displayName,
      userName: identity.userName,
      chatName: identity.chatName,
      confidence: identity.confidence,
    };
  }

  private toCsv(rows: ConversationTelemetryRow[]): string {
    const headers = [
      'teamName',
      'teamDisplayName',
      'projectName',
      'ccSessionId',
      'sessionName',
      'sessionKey',
      'agentSessionId',
      'claudeSessionId',
      'platform',
      'identityType',
      'identityId',
      'displayName',
      'userName',
      'chatName',
      'messageRole',
      'messageTimestamp',
      'messageContent',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheCreationTokens',
      'totalTokens',
      'usageSource',
      'matchStatus',
      'createdAt',
      'updatedAt',
    ];

    const lines = [headers.map(csvEscape).join(',')];
    for (const row of rows) {
      const messages = row.content.messages?.length
        ? row.content.messages.filter((message) => message.content.trim())
        : [
            {
              role: row.content.lastMessageRole ?? 'unknown',
              timestamp: row.content.lastMessageAt,
              content:
                row.content.lastMessageContent ??
                row.content.lastUserMessage ??
                row.content.firstUserMessage ??
                '',
              usage: undefined,
            } satisfies ConversationTelemetryMessage,
          ];

      for (const message of messages) {
        lines.push(
          [
            row.teamName,
            row.teamDisplayName,
            row.projectName,
            row.session.ccSessionId,
            row.identity.displayName,
            row.session.sessionKey,
            row.session.agentSessionId,
            row.session.claudeSessionId,
            row.identity.platform,
            row.identity.type,
            row.identity.id,
            row.identity.displayName,
            row.identity.userName,
            row.identity.chatName,
            message.role,
            message.timestamp,
            message.content,
            message.usage?.inputTokens ?? '',
            message.usage?.outputTokens ?? '',
            message.usage?.cacheReadTokens ?? '',
            message.usage?.cacheCreationTokens ?? '',
            message.usage?.totalTokens ?? '',
            row.usage.usageSource,
            row.session.matchStatus,
            row.session.createdAt,
            row.session.updatedAt,
          ]
            .map(csvEscape)
            .join(',')
        );
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private toMarkdown(rows: ConversationTelemetryRow[]): string {
    const parts = ['# Conversation Telemetry Export', ''];
    for (const row of rows) {
      parts.push(`## ${row.identity.displayName}`);
      parts.push('');
      parts.push(`- Team: ${row.teamDisplayName} (${row.teamName})`);
      parts.push(`- Session: ${row.session.sessionKey}`);
      parts.push(`- Platform: ${row.identity.platform}`);
      parts.push(`- Identity: ${row.identity.type} / ${row.identity.confidence}`);
      if (row.identity.userName) parts.push(`- User: ${row.identity.userName}`);
      if (row.identity.chatName) parts.push(`- Chat: ${row.identity.chatName}`);
      parts.push(`- Match: ${row.session.matchStatus}`);
      parts.push(
        `- Tokens: total ${row.usage.totalTokens} / input ${row.usage.inputTokens} / output ${row.usage.outputTokens} / cache read ${row.usage.cacheReadTokens} / cache creation ${row.usage.cacheCreationTokens}`
      );
      if (row.content.firstUserMessage) {
        parts.push(`- First question: ${row.content.firstUserMessage}`);
      }
      if (
        row.content.lastUserMessage &&
        row.content.lastUserMessage !== row.content.firstUserMessage
      ) {
        parts.push(`- Last question: ${row.content.lastUserMessage}`);
      }
      parts.push('');
      if (row.content.messages?.length) {
        parts.push('### Transcript', '');
        for (const message of row.content.messages) {
          if (!message.content.trim()) continue;
          parts.push(`**${message.role}** ${message.timestamp ?? ''}`.trim());
          parts.push('');
          parts.push(message.content);
          parts.push('');
        }
      }
    }
    return parts.join('\n');
  }

  private toPlainText(rows: ConversationTelemetryRow[]): string {
    return rows
      .map((row) => {
        const header = [
          `Conversation: ${row.identity.displayName}`,
          `Team: ${row.teamDisplayName} (${row.teamName})`,
          `Session: ${row.session.sessionKey}`,
          `Platform: ${row.identity.platform}`,
          row.identity.userName ? `User: ${row.identity.userName}` : undefined,
          row.identity.chatName ? `Chat: ${row.identity.chatName}` : undefined,
          `Match: ${row.session.matchStatus}`,
          `Tokens: total ${row.usage.totalTokens} / input ${row.usage.inputTokens} / output ${row.usage.outputTokens} / cache read ${row.usage.cacheReadTokens} / cache creation ${row.usage.cacheCreationTokens}`,
          row.content.firstUserMessage
            ? `First question: ${row.content.firstUserMessage}`
            : undefined,
          row.content.lastUserMessage &&
          row.content.lastUserMessage !== row.content.firstUserMessage
            ? `Last question: ${row.content.lastUserMessage}`
            : undefined,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n');
        const transcript =
          row.content.messages
            ?.filter((message) => message.content.trim())
            .map((message) => `[${message.timestamp ?? '-'}] ${message.role}\n${message.content}`)
            .join('\n\n') ?? '';
        return `${header}\n\n${transcript}`.trim();
      })
      .join('\n\n---\n\n');
  }
}

export function shouldIncludeContent(value: unknown): 'none' | 'summary' | 'full' {
  if (value === 'full' || value === 'summary') return value;
  if (parseBoolean(value)) return 'full';
  return 'none';
}
