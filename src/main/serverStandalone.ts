import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { markBridgeBinaryCheck, markBridgeLaunch } from './services/system/RuntimeReadiness';
import { createStandaloneServerComposition } from './serverComposition';
import { createHermitConfigStore, createServerEnvironment } from './serverConfig';
import {
  createServerShutdown,
  installServerProcessHandlers,
  type ServerProcessTarget,
} from './serverProcessLifecycle';
import { startStandaloneServerRuntime } from './serverStartup';
import { createWorkbenchServer } from './workbenchServer';

import type { StandaloneServerComposition } from './serverComposition';
import type { ServerEnvironment } from './serverConfig';
import type { WorkbenchServer } from './workbenchServer';

export interface StandaloneServerHandle extends WorkbenchServer {
  removeProcessHandlers(): void;
}

export interface StartStandaloneServerOptions {
  environment?: ServerEnvironment;
  composition?: StandaloneServerComposition;
  processTarget?: ServerProcessTarget;
  installProcessHandlers?: boolean;
  startRuntime?: typeof startStandaloneServerRuntime;
}

export async function startStandaloneServer(
  options: StartStandaloneServerOptions = {}
): Promise<StandaloneServerHandle> {
  process.noDeprecation = true;
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const environment = options.environment ?? createServerEnvironment({ startDir: moduleDirectory });
  const composition =
    options.composition ??
    createStandaloneServerComposition(environment, createHermitConfigStore(environment));
  const server = await createWorkbenchServer(composition.context, {
    environment,
    configStore: composition.configStore,
    getRuntimeConfig: composition.getRuntimeConfig,
    updateRuntimeConfig: composition.updateRuntimeConfig,
    setRestartBridge: composition.setRestartBridge,
  });
  const processTarget = options.processTarget ?? process;
  const startRuntime = options.startRuntime ?? startStandaloneServerRuntime;

  composition.context.lifecycle.startPromise ??= startRuntime({
    app: server.app,
    bridgeLauncher: composition.context.services.bridgeLauncher,
    bridgeClient: composition.context.services.bridgeClient,
    bridge: composition.context.services.bridgeConnection,
    imLiveWatcher: composition.context.services.imLiveWatcher,
    initializeTelemetryFromSettings: server.initializeTelemetryFromSettings,
    ensureGlobalWorkflows: server.ensureGlobalWorkflows,
    markBridgeBinaryCheck,
    markBridgeLaunch,
    processTarget,
    bridgeConfigPath: environment.hermitBridgeConfigFile,
    bridgeLogFile: environment.bridgeLogFile,
    bridgeAutoLaunchTimeoutMs: environment.bridgeAutoLaunchTimeoutMs,
    host: environment.host,
    port: environment.port,
    staticDir: environment.staticDir,
    bridgeBaseUrl: environment.bridgeBaseUrl,
    bridgeWsUrl: environment.bridgeWsUrl,
  }).catch((error) => {
    composition.context.lifecycle.startPromise = null;
    throw error;
  });
  await composition.context.lifecycle.startPromise;

  let removeProcessHandlers: () => void = () => undefined;
  const shutdownProcess = createServerShutdown({
    shutdownWorkbenchServer: server.shutdown,
    processTarget,
    removeProcessHandlers: () => removeProcessHandlers(),
  });
  if (options.installProcessHandlers !== false) {
    removeProcessHandlers = installServerProcessHandlers({
      app: server.app,
      directCliManager: composition.context.services.directCli,
      processTarget,
      shutdown: shutdownProcess,
    });
  }

  return {
    ...server,
    removeProcessHandlers,
  };
}
