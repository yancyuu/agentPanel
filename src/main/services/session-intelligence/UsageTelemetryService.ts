/**
 * UsageTelemetryService - scans local Claude Code JSONL sessions as the single
 * usage telemetry source. The service intentionally stays local-only: it does
 * not upload usage, conversation messages, or capability snapshots.
 */

import { uploadConversationMessages } from './ConversationMessageUploadService';
import { SessionUsageCollector } from './SessionUsageCollector';

import type { SessionEntry, UsageAggregate, UsageProviderMetrics } from './SessionUsageParser';
import type {
  UsageCollectionResult,
  UsageTelemetryStatus,
  UserUsageTelemetryRow,
} from './usageTypes';
import type { ConversationTelemetryRow } from '@shared/types/api';
import type { TelemetryConfig } from '@shared/types/team';

export type UsageTelemetryScanPhase = 'idle' | 'scanning' | 'done' | 'error';

export interface UsageTelemetryRuntimeStatus {
  running: boolean;
  phase: UsageTelemetryScanPhase;
  startedAt: string | null;
  updatedAt: string | null;
  lastError: string | null;
}

let scanInterval: ReturnType<typeof setInterval> | null = null;
let lastLocalScan: UsageTelemetryStatus | null = null;
let scanRuntime: UsageTelemetryRuntimeStatus = {
  running: false,
  phase: 'idle',
  startedAt: null,
  updatedAt: null,
  lastError: null,
};
let collector: SessionUsageCollector | null = null;

function getCollector(): SessionUsageCollector {
  collector ??= new SessionUsageCollector();
  return collector;
}

function emptyUnresolvedUsage() {
  return { sessions: 0, messages: 0, tokensTotal: 0 };
}

function projectNameForPath(projectPath: string): string | undefined {
  return projectPath ? projectPath.split('/').filter(Boolean).at(-1) : undefined;
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

export function localUserRowsFromSessions(sessions: SessionEntry[]): UserUsageTelemetryRow[] {
  // One row per (provider × projectPath) identity, NOT per session file. Every
  // identity field is derived from projectPath, so sessions that share provider +
  // projectPath are the same logical "local user" and must be folded together.
  // The previous per-session map keyed on relPath (which embeds the session uuid),
  // so status.json grew without bound — one row per .jsonl — and every 10-min scan
  // re-serialised/re-read megabytes. Group key is stable and uuid-free.
  const grouped = new Map<string, UserUsageTelemetryRow>();
  for (const session of sessions) {
    if (!(session.tokens.total > 0 || session.messageCount > 0)) continue;
    const groupKey = `local:${session.provider}:${session.projectPath}`;
    const lastActiveAt = session.endTime || session.startTime || undefined;
    const existing = grouped.get(groupKey);
    if (existing) {
      existing.sessions += 1;
      existing.messages += session.messageCount;
      existing.tokensIn += session.tokens.input;
      existing.tokensOut += session.tokens.output;
      existing.cacheRead += session.tokens.cacheRead;
      existing.cacheCreation += session.tokens.cacheCreation;
      existing.tokensTotal += session.tokens.total;
      if (lastActiveAt && (!existing.lastActiveAt || lastActiveAt > existing.lastActiveAt)) {
        existing.lastActiveAt = lastActiveAt;
      }
      continue;
    }
    grouped.set(groupKey, {
      key: groupKey,
      kind: 'local' as const,
      identity: {
        platform: 'local',
        type: 'person' as const,
        displayName:
          projectNameForPath(session.projectPath) ||
          (session.provider === 'codex' ? 'Local Codex' : 'Local Claude Code'),
        confidence: `${session.provider}-jsonl`,
      },
      provider: session.provider,
      projectName: projectNameForPath(session.projectPath),
      workDir: session.projectPath || undefined,
      sessions: 1,
      messages: session.messageCount,
      tokensIn: session.tokens.input,
      tokensOut: session.tokens.output,
      cacheRead: session.tokens.cacheRead,
      cacheCreation: session.tokens.cacheCreation,
      tokensTotal: session.tokens.total,
      lastActiveAt,
    });
  }
  return [...grouped.values()];
}

function statusFromCollection(collection: UsageCollectionResult): UsageTelemetryStatus {
  const aggregate: UsageAggregate = collection.legacyParseResult.aggregate;

  // The parser already applied the 7-day window using a single reference
  // timestamp (the same instant as collection.computedAt), so events7d is
  // the definitive recent-window set. Summing here avoids a second Date.now()
  // that would drift the boundary relative to the scan.
  let recentMessages = 0;
  let recentTokensTotal = 0;
  const recentByProvider = {
    claudecode: emptyProviderMetrics(),
    codex: emptyProviderMetrics(),
  };
  for (const event of aggregate.events7d) {
    recentMessages += 1;
    recentTokensTotal += event.tokensTotal;
    const providerMetrics = recentByProvider[event.provider];
    providerMetrics.messages += 1;
    providerMetrics.tokensIn += event.tokensIn;
    providerMetrics.tokensOut += event.tokensOut;
    providerMetrics.cacheRead += event.cacheRead;
    providerMetrics.cacheCreation += event.cacheCreation;
    providerMetrics.tokensTotal += event.tokensTotal;
  }

  return {
    connected: false,
    lastScan: collection.computedAt,
    sessions: aggregate.sessions,
    messages: aggregate.messages,
    imMessages: aggregate.imMessages,
    imTokensTotal: aggregate.imTotalTokens,
    tokensIn: aggregate.tokens.input,
    tokensOut: aggregate.tokens.output,
    cacheRead: aggregate.tokens.cacheRead,
    cacheCreation: aggregate.tokens.cacheCreation,
    totalTokens: aggregate.tokens.total,
    recentMessages,
    recentTokensTotal,
    recentByProvider,
    activeDays: aggregate.activeDays,
    hourly: aggregate.hourly,
    projects: aggregate.projects,
    workSecondsByDay: aggregate.workSecondsByDay,
    daily: aggregate.daily,
    localUsers: localUserRowsFromSessions(collection.legacyParseResult.sessions),
    byProvider: aggregate.byProvider,
    unresolvedUsage: emptyUnresolvedUsage(),
  };
}

function setScanRuntime(patch: Partial<UsageTelemetryRuntimeStatus>): void {
  scanRuntime = {
    ...scanRuntime,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeScanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(token|secret|password|authorization)=([^\s]+)/gi, '$1=[hidden]');
}

async function doScan(cfg?: TelemetryConfig): Promise<UsageTelemetryStatus | null> {
  const startedAt = new Date().toISOString();
  scanRuntime = {
    running: true,
    phase: 'scanning',
    startedAt,
    updatedAt: startedAt,
    lastError: null,
  };

  try {
    const collection = await getCollector().collect();
    lastLocalScan = statusFromCollection(collection);
    // Conversation content is explicit opt-in. A fresh install must never upload
    // message bodies merely because a remote connection or broad upload scope exists.
    // Keep this aligned with ConversationMessageUploadService and uploadState.mjs.
    const telemetryCfg = cfg?.telemetry;
    const canonicalUpload = telemetryCfg?.conversationUploadEnabled;
    const legacyUpload = telemetryCfg?.conversations?.uploadEnabled;
    const conversationUploadOn = canonicalUpload === true || legacyUpload === true;
    if (cfg && conversationUploadOn) {
      try {
        lastLocalScan.conversationUpload = await uploadConversationMessages(
          cfg,
          collection.referenceMs
        );
      } catch (error) {
        lastLocalScan.conversationUpload = {
          enabled: true,
          endpointConfigured: true,
          totalDiscovered: 0,
          skippedAlreadyUploaded: 0,
          pending: 0,
          attempted: 0,
          accepted: 0,
          duplicated: 0,
          rejected: 0,
          lastError: sanitizeScanError(error),
        };
      }
    }
    setScanRuntime({ running: false, phase: 'done' });
    return lastLocalScan;
  } catch (error) {
    setScanRuntime({ running: false, phase: 'error', lastError: sanitizeScanError(error) });
    throw error;
  }
}

export async function scanTelemetryOnce(
  cfg?: TelemetryConfig
): Promise<UsageTelemetryStatus | null> {
  return doScan(cfg);
}

export function configureUsageTelemetry(
  _options: {
    loadConversations?: () => Promise<ConversationTelemetryRow[]>;
    loadConversationMessages?: () => Promise<ConversationTelemetryRow[]>;
  } = {}
): void {
  collector = new SessionUsageCollector();
}

export async function startTelemetry(cfg: TelemetryConfig): Promise<void> {
  await stopTelemetry();
  if (!cfg.telemetry?.enabled) return;

  await doScan(cfg);
  scanInterval = setInterval(
    async () => {
      try {
        await doScan(cfg);
      } catch (err) {
        console.error('[UsageTelemetry] scan failed:', err);
      }
    },
    10 * 60 * 1000
  );
}

export async function stopTelemetry(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
}

export async function triggerScan(cfg: TelemetryConfig): Promise<UsageTelemetryStatus | null> {
  if (!cfg.telemetry?.enabled) return null;
  return doScan(cfg);
}

export function isTelemetryRunning(): boolean {
  return scanInterval !== null;
}

export function getTelemetryRuntimeStatus(): UsageTelemetryRuntimeStatus {
  return scanRuntime;
}

export async function getTelemetryStatus(): Promise<UsageTelemetryStatus | null> {
  return lastLocalScan;
}

export type { ConversationTelemetryRow, UsageTelemetryStatus };
