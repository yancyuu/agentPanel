import { extensionHandlers } from './ipc/extensions';
import { DirectCliSessionManager } from './services/direct-cli';
import { HermitBridgeClient } from './services/hermitBridge/HermitBridgeClient';
import { HermitBridgeConnection } from './services/hermitBridge/HermitBridgeConnection';
import { HermitBridgeLauncher } from './services/hermitBridge/HermitBridgeLauncher';
import { LoopAssetsScannerService } from './services/loop-assets/LoopAssetsScannerService';
import { ConversationTelemetryService } from './services/session-intelligence/ConversationTelemetryService';
import { defaultImSessionsDir, ImLiveWatcher } from './services/session-intelligence/ImLiveWatcher';
import { LocalSessionScanner } from './services/session-intelligence/LocalSessionScanner';
import { configureUsageTelemetry } from './services/session-intelligence/UsageTelemetryService';
import { HermitCcSettingsService } from './services/settings/HermitCcSettingsService';
import { SystemManagerConfigService } from './services/system-manager/SystemManagerConfigService';
import { WorkflowPromptService } from './services/system-manager/WorkflowPromptService';
import { TeamProvisioningService } from './services/team-management';
import { UpdateService } from './services/UpdateService';
import { createServerContext, createServerRuntimeState } from './serverContext';

import type { HermitConfig, HermitConfigStore, ServerEnvironment } from './serverConfig';
import type { ServerContext } from './serverContext';

export interface StandaloneServerComposition {
  context: ServerContext;
  environment: ServerEnvironment;
  configStore: HermitConfigStore;
  getRuntimeConfig: () => HermitConfig;
  updateRuntimeConfig: (config: HermitConfig) => void;
  setRestartBridge: (restart: () => Promise<void>) => void;
}

export function createStandaloneServerComposition(
  environment: ServerEnvironment,
  configStore: HermitConfigStore
): StandaloneServerComposition {
  const state = createServerRuntimeState();
  let runtimeConfig = configStore.load();
  let restartBridge: () => Promise<void> = async () => {
    throw new Error('workbench server has not initialized bridge restart operations');
  };

  const bridgeClient = new HermitBridgeClient({
    baseUrl: runtimeConfig.ccBaseUrl,
    token: runtimeConfig.ccToken,
    bridgeUrl: runtimeConfig.ccBridgeUrl,
  });
  const bridgeConnection = new HermitBridgeConnection({
    bridgeUrl: runtimeConfig.ccBridgeUrl,
    bridgeToken: runtimeConfig.ccBridgeToken || runtimeConfig.ccToken,
  });
  const bridgeLauncher = new HermitBridgeLauncher();
  const teamProvisioning = new TeamProvisioningService(bridgeClient, bridgeConnection, undefined, {
    restartCcConnect: () => restartBridge(),
  });
  const conversationTelemetry = new ConversationTelemetryService({
    cc: bridgeClient,
    listTeams: () => teamProvisioning.listTeams(),
    readTeamManifest: (teamName) => teamProvisioning.readTeamManifest(teamName),
  });
  configureUsageTelemetry();

  const broadcastSse = (eventName: string, data: unknown): void => {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of state.sseClients) {
      try {
        client.res.write(payload);
      } catch {
        state.sseClients.delete(client);
      }
    }
  };

  const context = createServerContext({
    state,
    services: {
      bridgeClient,
      bridgeConnection,
      bridgeLauncher,
      teamProvisioning,
      systemManagerConfig: new SystemManagerConfigService(),
      workflowPrompt: new WorkflowPromptService(),
      conversationTelemetry,
      localSessionScanner: new LocalSessionScanner(),
      loopAssetsScanner: new LoopAssetsScannerService(),
      directCli: new DirectCliSessionManager(),
      imLiveWatcher: new ImLiveWatcher({
        sessionsDir: defaultImSessionsDir(),
        emit: (workers) => broadcastSse('im-live-workers', workers),
      }),
      ccSettings: new HermitCcSettingsService(environment.hermitSettingsFile),
      update: new UpdateService(),
      extensions: extensionHandlers,
    },
  });

  return {
    context,
    environment,
    configStore,
    getRuntimeConfig: () => runtimeConfig,
    updateRuntimeConfig: (config) => {
      runtimeConfig = config;
    },
    setRestartBridge: (restart) => {
      restartBridge = restart;
    },
  };
}
