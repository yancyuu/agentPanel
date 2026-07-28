import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createServerShutdown,
  installServerProcessHandlers,
  type ServerProcessTarget,
} from '../../../src/main/serverProcessLifecycle';

function createProcessTarget() {
  const emitter = new EventEmitter() as EventEmitter & {
    exit: ReturnType<typeof vi.fn>;
  };
  emitter.exit = vi.fn(() => undefined as never);
  return emitter as unknown as ServerProcessTarget;
}

describe('server process lifecycle', () => {
  it('preserves the current graceful shutdown order and exits successfully', async () => {
    const calls: string[] = [];
    const processTarget = createProcessTarget();
    const shutdown = createServerShutdown({
      app: {
        close: vi.fn(async () => {
          calls.push('app.close');
        }),
        log: { error: vi.fn() },
      },
      listenerDisposers: [vi.fn(() => calls.push('listeners.dispose'))],
      imLiveWatcher: { stop: vi.fn(() => calls.push('watcher.stop')) },
      directCliManager: { shutdown: vi.fn(() => calls.push('direct.shutdown')) },
      bridgeLauncher: { stop: vi.fn(() => calls.push('launcher.stop')) },
      bridge: { dispose: vi.fn(() => calls.push('bridge.dispose')) },
      processTarget,
      closeTimeoutMs: 25,
    });

    await shutdown();

    expect(calls).toEqual([
      'listeners.dispose',
      'watcher.stop',
      'direct.shutdown',
      'launcher.stop',
      'bridge.dispose',
      'app.close',
    ]);
    expect(processTarget.exit).toHaveBeenCalledWith(0);
  });

  it('exits with failure when cleanup rejects', async () => {
    const processTarget = createProcessTarget();
    const shutdown = createServerShutdown({
      app: {
        close: vi.fn(async () => {
          throw new Error('close failed');
        }),
        log: { error: vi.fn() },
      },
      imLiveWatcher: { stop: vi.fn() },
      directCliManager: { shutdown: vi.fn() },
      bridgeLauncher: { stop: vi.fn() },
      bridge: { dispose: vi.fn() },
      processTarget,
      closeTimeoutMs: 25,
    });

    await shutdown();

    expect(processTarget.exit).toHaveBeenCalledWith(1);
  });

  it('registers signal, rejection and synchronous exit handlers', () => {
    const processTarget = createProcessTarget();
    const shutdown = vi.fn(async () => undefined);
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
