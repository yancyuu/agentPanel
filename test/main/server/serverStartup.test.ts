import { describe, expect, it, vi } from 'vitest';

import type { ServerLifecycleState } from '../../../src/main/serverContext';
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
  const lifecycle: ServerLifecycleState = {
    listenerDisposers: [],
    backgroundStartupTasks: new Set<Promise<void>>(),
    startupAbortController: null,
    startPromise: null,
    disposePromise: null,
  };
  const dependencies = {
    app: {
      listen: vi.fn(() => {
        calls.push('app.listen');
        return Promise.resolve();
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
    initializeTelemetryFromSettings: vi.fn(() => {
      calls.push('telemetry.initialize');
      return Promise.resolve();
    }),
    ensureGlobalWorkflows: vi.fn(() => {
      calls.push('workflows.ensure');
      return Promise.resolve();
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
    lifecycle,
  };

  return { binaryReady, bridgeRunning, calls, dependencies, lifecycle, processTarget };
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
      signal: expect.any(AbortSignal),
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

  it('tracks sidecar startup and lets shutdown abort it before a delayed spawn', async () => {
    const { dependencies, lifecycle } = createDependencies();
    let spawned = false;
    dependencies.bridgeLauncher.ensureRunning = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('cancelled');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
          setTimeout(() => {
            if (signal?.aborted) return;
            spawned = true;
            resolve({ launched: true, alreadyRunning: false, pid: 42 });
          }, 25);
        })
    );

    await startStandaloneServerRuntime(dependencies);
    expect(lifecycle.backgroundStartupTasks.size).toBe(1);
    lifecycle.startupAbortController?.abort();
    await Promise.allSettled(Array.from(lifecycle.backgroundStartupTasks));

    expect(spawned).toBe(false);
    expect(lifecycle.backgroundStartupTasks.size).toBe(0);
    expect(dependencies.markBridgeLaunch).not.toHaveBeenCalled();
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
