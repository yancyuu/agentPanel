import { describe, expect, it, vi } from 'vitest';

import { HermitBridgeLauncher } from './HermitBridgeLauncher';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('HermitBridgeLauncher cancellation', () => {
  it('does not spawn when shutdown aborts a delayed initial readiness probe', async () => {
    const probe = deferred<unknown>();
    const spawn = vi.fn(() => ({ pid: 42, kill: vi.fn() }));
    const launcher = new HermitBridgeLauncher({
      spawn,
      resolveBinary: () => '/fake/cc-connect',
    });
    const controller = new AbortController();

    const ensuring = launcher.ensureRunning({
      client: { listProjects: () => probe.promise },
      configPath: '/tmp/config.toml',
      signal: controller.signal,
    });
    controller.abort();
    probe.resolve([]);

    await expect(ensuring).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
