import type { FastifyBaseLogger } from 'fastify';

import type { BridgeBinaryState, BridgeLaunchState } from '@shared/types/runtimeReadiness';

const BRIDGE_BINARY_REMEDIATION = [
  '在终端运行: npm install -g cc-connect',
  '或设置环境变量 CC_CONNECT_MIRROR 指向可用的 GitHub release 代理（如 https://gh-proxy.com/）',
  '安装完成后重启 AgentCli 工作台',
];

interface StartupServerApp {
  listen(options: { host: string; port: number }): Promise<unknown>;
  log: Pick<FastifyBaseLogger, 'error' | 'info' | 'warn'>;
}

interface BridgeCommand {
  cmd: string;
  args: string[];
}

interface BridgeLaunchResult {
  launched: boolean;
  alreadyRunning: boolean;
  pid?: number;
}

interface StandaloneServerStartupDependencies<TBridgeClient> {
  app: StartupServerApp;
  bridgeLauncher: {
    ensureBinaryReady(options: { configPath: string; extraArgs: string[] }): Promise<BridgeCommand>;
    ensureRunning(options: {
      client: TBridgeClient;
      configPath: string;
      extraArgs: string[];
      logFile: string;
      timeoutMs: number;
    }): Promise<BridgeLaunchResult>;
  };
  bridgeClient: TBridgeClient;
  bridge: { start(): void };
  imLiveWatcher: { start(): void };
  initializeTelemetryFromSettings(): Promise<unknown>;
  ensureGlobalWorkflows(): Promise<unknown>;
  markBridgeBinaryCheck(state: BridgeBinaryState): void;
  markBridgeLaunch(state: BridgeLaunchState): void;
  processTarget: Pick<NodeJS.Process, 'exit'>;
  bridgeConfigPath: string;
  bridgeLogFile: string;
  bridgeAutoLaunchTimeoutMs: number;
  host: string;
  port: number;
  staticDir: string;
  bridgeBaseUrl: string;
  bridgeWsUrl: string;
}

export async function startStandaloneServerRuntime<TBridgeClient>({
  app,
  bridgeLauncher,
  bridgeClient,
  bridge,
  imLiveWatcher,
  initializeTelemetryFromSettings,
  ensureGlobalWorkflows,
  markBridgeBinaryCheck,
  markBridgeLaunch,
  processTarget,
  bridgeConfigPath,
  bridgeLogFile,
  bridgeAutoLaunchTimeoutMs,
  host,
  port,
  staticDir,
  bridgeBaseUrl,
  bridgeWsUrl,
}: StandaloneServerStartupDependencies<TBridgeClient>): Promise<void> {
  bridgeLauncher
    .ensureBinaryReady({
      configPath: bridgeConfigPath,
      extraArgs: ['--force'],
    })
    .then((command) => {
      markBridgeBinaryCheck({ status: 'ok', cmd: command.cmd });
    })
    .catch((error) => {
      markBridgeBinaryCheck({
        status: 'degraded',
        reason: error instanceof Error ? error.message : String(error),
        remediation: BRIDGE_BINARY_REMEDIATION,
      });
    });

  // Sidecar readiness remains fire-and-forget: a cold or unavailable bridge
  // must not delay the loopback HTTP server from exposing its readiness API.
  bridgeLauncher
    .ensureRunning({
      client: bridgeClient,
      configPath: bridgeConfigPath,
      extraArgs: ['--force'],
      logFile: bridgeLogFile,
      timeoutMs: bridgeAutoLaunchTimeoutMs,
    })
    .then((result) => {
      if (result.launched) {
        app.log.info({ pid: result.pid }, 'launched hermit-bridge sidecar');
        markBridgeLaunch({ status: 'running', pid: result.pid });
      } else {
        app.log.info('hermit-bridge already running — skipping auto-launch');
        markBridgeLaunch({ status: 'running' });
      }
    })
    .catch((error) => {
      app.log.warn({ err: error }, 'hermit-bridge auto-launch skipped');
      markBridgeLaunch({
        status: 'offline',
        reason: error instanceof Error ? error.message : String(error),
      });
    });

  bridge.start();
  imLiveWatcher.start();
  await initializeTelemetryFromSettings();
  await ensureGlobalWorkflows();

  try {
    await app.listen({ host, port });
    app.log.info(`hermit-bridge:        ${bridgeBaseUrl}`);
    app.log.info(`bridge:               ${bridgeWsUrl}`);
    app.log.info(`static:               ${staticDir}`);
  } catch (error) {
    app.log.error(error);
    processTarget.exit(1);
  }
}
