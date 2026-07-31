import {
  buildWorkbenchRuntimeEnv,
  resolveLoopbackWorkbenchUrl,
} from './services/agentcli/workbenchRuntimeEnv';

import type { ServerLifecycleState } from './serverContext';
import type { BridgeBinaryState, BridgeLaunchState } from '@shared/types/runtimeReadiness';
import type { FastifyBaseLogger } from 'fastify';

const BRIDGE_BINARY_REMEDIATION = [
  '在终端运行: npm install -g cc-connect',
  '或设置环境变量 CC_CONNECT_MIRROR 指向可用的 GitHub release 代理（如 https://gh-proxy.com/）',
  '安装完成后重启 AgentCLI 工作台',
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
    ensureBinaryReady(options: {
      configPath: string;
      extraArgs: string[];
      signal?: AbortSignal;
    }): Promise<BridgeCommand>;
    ensureRunning(options: {
      client: TBridgeClient;
      configPath: string;
      extraArgs: string[];
      logFile: string;
      timeoutMs: number;
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
    }): Promise<BridgeLaunchResult>;
  };
  bridgeClient: TBridgeClient;
  bridge: { start(): void };
  imLiveWatcher: { start(): void };
  initializeTelemetryFromSettings(): Promise<unknown>;
  ensureGlobalWorkflows(): Promise<unknown>;
  ensureAgentCliShim(): Promise<unknown>;
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
  lifecycle: ServerLifecycleState;
}

export async function startStandaloneServerRuntime<TBridgeClient>({
  app,
  bridgeLauncher,
  bridgeClient,
  bridge,
  imLiveWatcher,
  initializeTelemetryFromSettings,
  ensureGlobalWorkflows,
  ensureAgentCliShim,
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
  lifecycle,
}: StandaloneServerStartupDependencies<TBridgeClient>): Promise<void> {
  try {
    await ensureAgentCliShim();
  } catch (error) {
    app.log.warn({ err: error }, 'AgentCLI Workbench shim provisioning failed');
  }
  // Binary diagnostics and sidecar readiness remain non-blocking for HTTP
  // startup, but share one abort signal and are both lifecycle-owned. The
  // launcher deduplicates their binary preparation so boot never starts two
  // downloads for the same command.
  const startupAbortController = new AbortController();
  lifecycle.startupAbortController = startupAbortController;
  const binaryCheck = bridgeLauncher
    .ensureBinaryReady({
      configPath: bridgeConfigPath,
      extraArgs: ['--force'],
      signal: startupAbortController.signal,
    })
    .then((command) => {
      markBridgeBinaryCheck({ status: 'ok', cmd: command.cmd });
    })
    .catch((error) => {
      if (startupAbortController.signal.aborted) return;
      markBridgeBinaryCheck({
        status: 'degraded',
        reason: error instanceof Error ? error.message : String(error),
        remediation: BRIDGE_BINARY_REMEDIATION,
      });
    })
    .finally(() => {
      lifecycle.backgroundStartupTasks.delete(binaryCheck);
      if (
        lifecycle.startupAbortController === startupAbortController &&
        lifecycle.backgroundStartupTasks.size === 0
      ) {
        lifecycle.startupAbortController = null;
      }
    });
  lifecycle.backgroundStartupTasks.add(binaryCheck);

  const sidecarStartup = bridgeLauncher
    .ensureRunning({
      client: bridgeClient,
      configPath: bridgeConfigPath,
      extraArgs: ['--force'],
      logFile: bridgeLogFile,
      timeoutMs: bridgeAutoLaunchTimeoutMs,
      env: buildWorkbenchRuntimeEnv({ workbenchUrl: resolveLoopbackWorkbenchUrl(host, port) }),
      signal: startupAbortController.signal,
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
      if (startupAbortController.signal.aborted) return;
      app.log.warn({ err: error }, 'hermit-bridge auto-launch skipped');
      markBridgeLaunch({
        status: 'offline',
        reason: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      lifecycle.backgroundStartupTasks.delete(sidecarStartup);
      if (
        lifecycle.startupAbortController === startupAbortController &&
        lifecycle.backgroundStartupTasks.size === 0
      ) {
        lifecycle.startupAbortController = null;
      }
    });
  lifecycle.backgroundStartupTasks.add(sidecarStartup);

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
