import { describe, expect, it, vi } from 'vitest';

import { startStandaloneServerRuntime } from '../../../src/main/serverStartup';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createDependencies() {
  const calls: string[] = [];
  const binaryReady = deferred<{ cmd: string; args: string[] }>();
  const bridgeRunning = deferred<{
    launched: boolean;
    alreadyRunning: boolean;
    pid?: number;
  }>();
  const processTarget = { exit: vi.fn(() => undefined as never) };
  const dependencies = {
    app: {
      listen: vi.fn(async () => {
        calls.push('app.listen');
      }),
      log: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    },
    bridgeLauncher: {
      ensureBinaryReady: vi.fn(() => binaryReady.promise),
      ensureRunning: vi.fn(() => bridgeRunning.promise),
    },
    bridgeClient: { listProjects: vi.fn() },
    bridge: { start: vi.fn(() => calls.push('bridge.start')) },
    imLiveWatcher: { start: vi.fn(() => calls.push('watcher.start')) },
    initializeTelemetryFromSettings: vi.fn(async () => {
      calls.push('telemetry.initialize');
    }),
    ensureGlobalWorkflows: vi.fn(async () => {
      calls.push('workflows.ensure');
    }),
    markBridgeBinaryCheck: vi.fn(),
    markBridgeLaunch: vi.fn(),
    processTarget,
    bridgeConfigPath: '/tmp/config.toml',
    bridgeLogFile: '/tmp/cc-connect.log',
    bridgeAutoLaunchTimeoutMs: 180_000,
    host: '127.0.0.1',
    port: 5680,
    staticDir: '/tmp/dist-renderer',
    bridgeBaseUrl: 'http://127.0.0.1:9820',
    bridgeWsUrl: 'ws://127.0.0.1:9810/bridge/ws',
  };

  return { binaryReady, bridgeRunning, calls, dependencies, processTarget };
}

describe('standalone server startup', () => {
  it('does not block HTTP listen on sidecar readiness promises', async () => {
    const { calls, dependencies } = createDependencies();

    await startStandaloneServerRuntime(dependencies);

    expect(calls).toEqual([
      'bridge.start',
      'watcher.start',
      'telemetry.initialize',
      'workflows.ensure',
      'app.listen',
    ]);
    expect(dependencies.bridgeLauncher.ensureBinaryReady).toHaveBeenCalledWith({
      configPath: '/tmp/config.toml',
      extraArgs: ['--force'],
    });
    expect(dependencies.bridgeLauncher.ensureRunning).toHaveBeenCalledWith({
      client: dependencies.bridgeClient,
      configPath: '/tmp/config.toml',
      extraArgs: ['--force'],
      logFile: '/tmp/cc-connect.log',
      timeoutMs: 180_000,
    });
    expect(dependencies.app.listen).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 5680,
    });
  });

  it('records asynchronous sidecar success and degraded states', async () => {
    const { binaryReady, bridgeRunning, dependencies } = createDependencies();

    await startStandaloneServerRuntime(dependencies);
    binaryReady.resolve({ cmd: 'cc-connect', args: ['--force'] });
    bridgeRunning.resolve({ launched: true, alreadyRunning: false, pid: 42 });
    await Promise.resolve();

    expect(dependencies.markBridgeBinaryCheck).toHaveBeenCalledWith({
      status: 'ok',
      cmd: 'cc-connect',
    });
    expect(dependencies.markBridgeLaunch).toHaveBeenCalledWith({
      status: 'running',
      pid: 42,
    });

    const failure = createDependencies();
    await startStandaloneServerRuntime(failure.dependencies);
    failure.binaryReady.reject(new Error('binary unavailable'));
    failure.bridgeRunning.reject(new Error('bridge offline'));
    await Promise.resolve();
    await Promise.resolve();

    expect(failure.dependencies.markBridgeBinaryCheck).toHaveBeenCalledWith({
      status: 'degraded',
      reason: 'binary unavailable',
      remediation: [
        '在终端运行: npm install -g cc-connect',
        '或设置环境变量 CC_CONNECT_MIRROR 指向可用的 GitHub release 代理（如 https://gh-proxy.com/）',
        '安装完成后重启 AgentCli 工作台',
      ],
    });
    expect(failure.dependencies.markBridgeLaunch).toHaveBeenCalledWith({
      status: 'offline',
      reason: 'bridge offline',
    });
  });

  it('preserves the standalone listen failure exit behavior', async () => {
    const { dependencies, processTarget } = createDependencies();
    const listenError = new Error('port in use');
    dependencies.app.listen.mockRejectedValueOnce(listenError);

    await startStandaloneServerRuntime(dependencies);

    expect(dependencies.app.log.error).toHaveBeenCalledWith(listenError);
    expect(processTarget.exit).toHaveBeenCalledWith(1);
  });
});
