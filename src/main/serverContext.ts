import type { ServerResponse } from 'node:http';

import type { ToolApprovalSettings } from '@shared/types/team';

import type { DirectCliSessionManager } from './services/direct-cli';
import type { HermitBridgeClient } from './services/hermitBridge/HermitBridgeClient';
import type { HermitBridgeConnection } from './services/hermitBridge/HermitBridgeConnection';
import type { HermitBridgeLauncher } from './services/hermitBridge/HermitBridgeLauncher';
import type { LoopAssetsScannerService } from './services/loop-assets/LoopAssetsScannerService';
import type { ConversationTelemetryService } from './services/session-intelligence/ConversationTelemetryService';
import type { ImLiveWatcher } from './services/session-intelligence/ImLiveWatcher';
import type { LocalSessionScanner } from './services/session-intelligence/LocalSessionScanner';
import type { HermitCcSettingsService } from './services/settings/HermitCcSettingsService';
import type { SystemManagerConfigService } from './services/system-manager/SystemManagerConfigService';
import type { WorkflowPromptService } from './services/system-manager/WorkflowPromptService';
import type { TeamProvisioningService } from './services/team-management';
import type { UpdateService } from './services/UpdateService';

export interface SseClient {
  res: ServerResponse;
  id: string;
}

export interface DirectCliRoute {
  teamName: string;
  /** `from` persisted on assistant replies: team name for lead, member name for DM. */
  from: string;
  to: string;
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

export interface ServerRuntimeState {
  sseClients: Set<SseClient>;
  directCliRoutes: Map<string, DirectCliRoute>;
  toolApprovalSettingsByName: Map<string, ToolApprovalSettings>;
  permissionSessionByRequestId: Map<string, PendingPermissionApproval>;
  bridgeSessionTeamCache: Map<string, BridgeSessionTeamCacheEntry>;
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
}

export interface ServerLifecycleState {
  listenerDisposers: Array<() => void>;
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
      startPromise: null,
      disposePromise: null,
    },
  };
}
