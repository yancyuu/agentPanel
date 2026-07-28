import type {
  DailyMetrics,
  ParseResult,
  UsageProvider,
  UsageProviderMetrics,
} from './SessionUsageParser';
import type {
  CapabilityTelemetrySummary,
  TeamCapabilityTelemetrySnapshot,
} from '@shared/types/extensions';

export interface UsageCollectionResult {
  computedAt: string;
  referenceMs: number;
  legacyParseResult: ParseResult;
}

export interface UsageTokenMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export interface UserUsageTelemetryRow {
  key: string;
  kind: 'local' | 'unresolved';
  identity: {
    platform: string;
    type: 'person' | 'group' | 'unknown';
    displayName: string;
    userId?: string;
    userName?: string;
    chatId?: string;
    chatName?: string;
    confidence: string;
  };
  teamSlug?: string;
  teamName?: string;
  teamDisplayName?: string;
  projectName?: string;
  bindProject?: string;
  workDir?: string;
  agentType?: string;
  model?: string;
  provider?: string;
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  tokensTotal: number;
  lastActiveAt?: string;
}

export interface UsageUnresolvedSummary {
  sessions: number;
  messages: number;
  tokensTotal: number;
}

export interface UsageTelemetryProjectRow {
  cwd: string;
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
}

export interface UsageTelemetryStatus {
  connected: boolean;
  lastScan: string | null;
  sessions: number;
  messages: number;
  imMessages: number;
  imTokensTotal: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  totalTokens: number;
  // Rolling 7-day local volume — drives the 本地（最近 7 天）row.
  recentMessages: number;
  recentTokensTotal: number;
  recentByProvider: Record<UsageProvider, UsageProviderMetrics>;
  activeDays: number;
  hourly: number[];
  projects: UsageTelemetryProjectRow[];
  workSecondsByDay: Record<string, number>;
  daily: Record<string, DailyMetrics>;
  localUsers: UserUsageTelemetryRow[];
  byProvider: Record<UsageProvider, UsageProviderMetrics>;
  teamCapabilitySnapshots?: TeamCapabilityTelemetrySnapshot[];
  capabilitySummary?: CapabilityTelemetrySummary;
  unresolvedUsage: UsageUnresolvedSummary;
  conversationUpload?: {
    enabled: boolean;
    endpointConfigured: boolean;
    totalDiscovered?: number;
    skippedAlreadyUploaded?: number;
    pending?: number;
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
  };
}
