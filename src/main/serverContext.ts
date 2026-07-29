import type { DirectCliSessionManager } from './services/direct-cli';
import type { HermitBridgeClient } from './services/hermitBridge/HermitBridgeClient';
import type { HermitBridgeConnection } from './services/hermitBridge/HermitBridgeConnection';
import type { HermitBridgeLauncher } from './services/hermitBridge/HermitBridgeLauncher';
import type { LoopAssetsScannerService } from './services/loop-assets/LoopAssetsScannerService';
import type { ConversationTelemetryService } from './services/session-intelligence/ConversationTelemetryService';
import type { ImLiveWatcher } from './services/session-intelligence/ImLiveWatcher';
import type { LocalSessionScanner } from './services/session-intelligence/LocalSessionScanner';
import type { ProjectUsageStats } from './services/session-intelligence/SessionUsageParser';
import type { HermitCcSettingsService } from './services/settings/HermitCcSettingsService';
import type { SystemManagerConfigService } from './services/system-manager/SystemManagerConfigService';
import type { WorkflowPromptService } from './services/system-manager/WorkflowPromptService';
import type { TeamProvisioningService } from './services/team-management';
import type { UpdateService } from './services/UpdateService';
import type { ToolApprovalSettings } from '@shared/types/team';
import type { ServerResponse } from 'node:http';

export interface SseClient {
  res: ServerResponse;
  id: string;
}

export interface DirectCliRoute {
  teamName: string;
  /** `from` persisted on assistant replies: team name for lead, member name for DM. */
  from: string;
  to: string;
  /** Latest product inbox thread associated with this runtime session. */
  conversationId?: string;
  /** Per-turn thread routing prevents concurrent replies from crossing mail threads. */
  conversationIdByMessageId?: Record<string, string>;
}

export interface PendingPermissionApproval {
  sessionKey: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

export interface BridgeSessionTeamCacheEntry {
  teamName: string;
  expiresAt: number;
}

export interface TeamStatsCacheEntry {
  expiresAt: number;
  value: ProjectUsageStats | null;
  promise?: Promise<ProjectUsageStats | null>;
}

export interface InMemoryScheduleRun {
  id: string;
  scheduleId: string;
  teamName: string;
  status:
    | 'pending'
    | 'warming_up'
    | 'warm'
    | 'running'
    | 'completed'
    | 'failed'
    | 'failed_interrupted'
    | 'cancelled';
  scheduledFor: string;
  startedAt: string;
  warmUpCompletedAt?: string;
  executionStartedAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  error?: string;
  retryCount: number;
  summary?: string;
}

export interface ScheduleRunLog {
  stdout: string;
  stderr: string;
}

export interface ServerRuntimeState {
  sseClients: Set<SseClient>;
  directCliRoutes: Map<string, DirectCliRoute>;
  toolApprovalSettingsByName: Map<string, ToolApprovalSettings>;
  permissionSessionByRequestId: Map<string, PendingPermissionApproval>;
  bridgeSessionTeamCache: Map<string, BridgeSessionTeamCacheEntry>;
  teamStatsCache: Map<string, TeamStatsCacheEntry>;
  scheduleRunsById: Map<string, InMemoryScheduleRun[]>;
  scheduleRunLogsByKey: Map<string, ScheduleRunLog>;
}

export interface ServerServices {
  bridgeClient: HermitBridgeClient;
  bridgeConnection: HermitBridgeConnection;
  bridgeLauncher: HermitBridgeLauncher;
  teamProvisioning: TeamProvisioningService;
  systemManagerConfig: SystemManagerConfigService;
  workflowPrompt: WorkflowPromptService;
  conversationTelemetry: ConversationTelemetryService;
  localSessionScanner: LocalSessionScanner;
  loopAssetsScanner: LoopAssetsScannerService;
  directCli: DirectCliSessionManager;
  imLiveWatcher: ImLiveWatcher;
  ccSettings: HermitCcSettingsService;
  update: UpdateService;
  extensions: typeof import('./ipc/extensions').extensionHandlers;
}

export interface ServerLifecycleState {
  listenerDisposers: (() => void)[];
  backgroundStartupTasks: Set<Promise<void>>;
  startupAbortController: AbortController | null;
  startPromise: Promise<void> | null;
  disposePromise: Promise<void> | null;
}

export interface ServerContext {
  services: ServerServices;
  state: ServerRuntimeState;
  lifecycle: ServerLifecycleState;
}

export function createServerRuntimeState(): ServerRuntimeState {
  return {
    sseClients: new Set(),
    directCliRoutes: new Map(),
    toolApprovalSettingsByName: new Map(),
    permissionSessionByRequestId: new Map(),
    bridgeSessionTeamCache: new Map(),
    teamStatsCache: new Map(),
    scheduleRunsById: new Map(),
    scheduleRunLogsByKey: new Map(),
  };
}

export function createServerContext({
  services,
  state = createServerRuntimeState(),
}: {
  services: ServerServices;
  state?: ServerRuntimeState;
}): ServerContext {
  return {
    services,
    state,
    lifecycle: {
      listenerDisposers: [],
      backgroundStartupTasks: new Set(),
      startupAbortController: null,
      startPromise: null,
      disposePromise: null,
    },
  };
}
