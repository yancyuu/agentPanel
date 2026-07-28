import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createServerShutdown,
  createWorkbenchShutdown,
  installServerProcessHandlers,
  type ServerProcessTarget,
} from '../../../src/main/serverProcessLifecycle';
import { HermitBridgeLauncher } from '../../../src/main/services/hermitBridge/HermitBridgeLauncher';

function createProcessTarget() {
  const emitter = new EventEmitter() as EventEmitter & {
    exit: ReturnType<typeof vi.fn>;
  };
  emitter.exit = vi.fn(() => undefined as never);
  return emitter as unknown as ServerProcessTarget;
}

describe('server process lifecycle', () => {
  it('cleans workbench resources once, then lets the standalone wrapper exit', async () => {
    const calls: string[] = [];
    const processTarget = createProcessTarget();
    const lifecycle = {
      listenerDisposers: [vi.fn(() => calls.push('listeners.dispose'))],
      backgroundStartupTasks: new Set<Promise<void>>(),
      startupAbortController: null,
      startPromise: null,
      disposePromise: null,
    };
    const sseResponse = { end: vi.fn(() => calls.push('sse.end')) };
    const sseClients = new Set([{ id: 'sse-1', res: sseResponse }]);
    const shutdownWorkbenchServer = createWorkbenchShutdown({
      app: {
        close: vi.fn(() => {
          calls.push('app.close');
          return Promise.resolve();
        }),
        log: { error: vi.fn() },
      },
      lifecycle,
      sseClients,
      stopTelemetry: vi.fn(() => {
        calls.push('telemetry.stop');
        return Promise.resolve();
      }),
      imLiveWatcher: { stop: vi.fn(() => calls.push('watcher.stop')) },
      directCliManager: {
        shutdown: vi.fn(() => {
          calls.push('direct.shutdown');
        }),
      },
      bridgeLauncher: { stop: vi.fn(() => calls.push('launcher.stop')) },
      bridge: { dispose: vi.fn(() => calls.push('bridge.dispose')) },
      closeTimeoutMs: 25,
    });

    const firstShutdown = shutdownWorkbenchServer();
    const secondShutdown = shutdownWorkbenchServer();
    expect(secondShutdown).toBe(firstShutdown);
    await Promise.all([firstShutdown, secondShutdown]);

    expect(calls).toEqual([
      'app.close',
      'listeners.dispose',
      'watcher.stop',
      'telemetry.stop',
      'sse.end',
      'direct.shutdown',
      'launcher.stop',
      'bridge.dispose',
    ]);
    expect(lifecycle.disposePromise).toBe(firstShutdown);
    expect(sseClients.size).toBe(0);

    const removeProcessHandlers = vi.fn(() => calls.push('process.remove'));
    const shutdown = createServerShutdown({
      shutdownWorkbenchServer,
      processTarget,
      removeProcessHandlers,
    });
    await shutdown();
    expect(calls).toHaveLength(9);
    expect(calls.at(-1)).toBe('process.remove');
    expect(processTarget.exit).toHaveBeenCalledWith(0);
  });

  it('attempts every cleanup and keeps the exit backstop when an early step fails', async () => {
    const calls: string[] = [];
    const processTarget = createProcessTarget();
    const removeProcessHandlers = vi.fn(() => calls.push('process.remove'));
    const shutdownWorkbenchServer = createWorkbenchShutdown({
      app: {
        close: vi.fn(() => {
          calls.push('app.close');
          return Promise.resolve();
        }),
        log: { error: vi.fn() },
      },
      lifecycle: {
        listenerDisposers: [
          vi.fn(() => {
            calls.push('listeners.dispose');
            throw new Error('listener cleanup failed');
          }),
        ],
        backgroundStartupTasks: new Set<Promise<void>>(),
        startupAbortController: null,
        startPromise: null,
        disposePromise: null,
      },
      stopTelemetry: vi.fn(() => {
        calls.push('telemetry.stop');
        return Promise.resolve();
      }),
      imLiveWatcher: { stop: vi.fn(() => calls.push('watcher.stop')) },
      directCliManager: {
        shutdown: vi.fn(() => {
          calls.push('direct.shutdown');
        }),
      },
      bridgeLauncher: { stop: vi.fn(() => calls.push('launcher.stop')) },
      bridge: { dispose: vi.fn(() => calls.push('bridge.dispose')) },
      closeTimeoutMs: 25,
    });
    const shutdown = createServerShutdown({
      shutdownWorkbenchServer,
      processTarget,
      removeProcessHandlers,
    });

    await shutdown();

    expect(calls).toEqual([
      'app.close',
      'listeners.dispose',
      'watcher.stop',
      'telemetry.stop',
      'direct.shutdown',
      'launcher.stop',
      'bridge.dispose',
    ]);
    expect(removeProcessHandlers).not.toHaveBeenCalled();
    expect(processTarget.exit).toHaveBeenCalledWith(1);
  });

  it('starts Fastify close immediately and waits for in-flight requests before dependency cleanup', async () => {
    const calls: string[] = [];
    let finishClose!: () => void;
    const closePending = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const lifecycle = {
      listenerDisposers: [vi.fn(() => calls.push('listeners.dispose'))],
      backgroundStartupTasks: new Set<Promise<void>>(),
      startupAbortController: new AbortController(),
      startPromise: null,
      disposePromise: null,
    };
    const shutdown = createWorkbenchShutdown({
      app: {
        close: vi.fn(() => {
          calls.push('app.close');
          return closePending;
        }),
        log: { error: vi.fn() },
      },
      lifecycle,
      imLiveWatcher: { stop: vi.fn(() => calls.push('watcher.stop')) },
      directCliManager: {
        shutdown: vi.fn(() => {
          calls.push('direct.shutdown');
          return Promise.resolve();
        }),
      },
      bridgeLauncher: { stop: vi.fn(() => calls.push('launcher.stop')) },
      bridge: {},
      closeTimeoutMs: 10_000,
    });

    const shutdownPromise = shutdown();
    await Promise.resolve();
    expect(calls).toEqual(['app.close']);
    expect(lifecycle.startupAbortController).toBeNull();

    finishClose();
    await shutdownPromise;
    expect(calls).toEqual([
      'app.close',
      'listeners.dispose',
      'watcher.stop',
      'direct.shutdown',
      'launcher.stop',
    ]);
  });

  it('aborts and drains a never-settling bridge probe during lifecycle shutdown', async () => {
    const startupAbortController = new AbortController();
    const spawn = vi.fn(() => ({ pid: 42, kill: vi.fn() }));
    const bridgeLauncher = new HermitBridgeLauncher({
      resolveBinary: () => '/fake/cc-connect',
      spawn,
    });
    const startupTask = bridgeLauncher
      .ensureRunning({
        client: { listProjects: () => new Promise(() => undefined) },
        configPath: '/tmp/config.toml',
        signal: startupAbortController.signal,
      })
      .then(() => undefined)
      .catch((error) => {
        if (startupAbortController.signal.aborted) return;
        throw error;
      });
    const lifecycle = {
      listenerDisposers: [],
      backgroundStartupTasks: new Set([startupTask]),
      startupAbortController,
      startPromise: null,
      disposePromise: null,
    };
    const shutdown = createWorkbenchShutdown({
      app: { close: vi.fn(() => Promise.resolve()), log: { error: vi.fn() } },
      lifecycle,
      imLiveWatcher: { stop: vi.fn() },
      directCliManager: { shutdown: vi.fn() },
      bridgeLauncher,
      bridge: {},
    });

    await expect(
      Promise.race([
        shutdown(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('lifecycle shutdown timed out')), 100)
        ),
      ])
    ).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
    expect(lifecycle.backgroundStartupTasks.size).toBe(0);
  });

  it('registers signal, rejection and synchronous exit handlers', () => {
    const processTarget = createProcessTarget();
    const shutdown = vi.fn(() => Promise.resolve());
    const directCliManager = { shutdown: vi.fn() };
    const app = { log: { error: vi.fn() } };

    const removeHandlers = installServerProcessHandlers({
      app,
      directCliManager,
      processTarget,
      shutdown,
    });

    const rejection = new Error('background failure');
    processTarget.emit('unhandledRejection', rejection);
    processTarget.emit('SIGINT');
    processTarget.emit('SIGTERM');
    processTarget.emit('exit');

    expect(app.log.error).toHaveBeenCalledWith(
      { reason: rejection },
      'unhandledRejection (logged, not crashing)'
    );
    expect(shutdown).toHaveBeenCalledTimes(2);
    expect(directCliManager.shutdown).toHaveBeenCalledTimes(1);

    removeHandlers();
    expect(processTarget.listenerCount('SIGINT')).toBe(0);
    expect(processTarget.listenerCount('SIGTERM')).toBe(0);
    expect(processTarget.listenerCount('unhandledRejection')).toBe(0);
    expect(processTarget.listenerCount('exit')).toBe(0);
  });
});
