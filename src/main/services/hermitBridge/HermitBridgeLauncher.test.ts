import { describe, expect, it, vi } from 'vitest';

import { HermitBridgeLauncher } from './HermitBridgeLauncher';

function deferred<T>(): {
  promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T): void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

async function expectPromptAbort(promise: Promise<unknown>): Promise<void> {
  await expect(
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('abort did not settle promptly')), 100)
      ),
    ])
  ).rejects.toMatchObject({ name: 'AbortError' });
}

describe('HermitBridgeLauncher cancellation', () => {
  it('promptly rejects a readiness probe that never settles and never spawns', async () => {
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

    await expectPromptAbort(ensuring);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent binary diagnostics and launch preparation', async () => {
    const binaryReady = deferred<{
      binaryPath: string;
      version: string;
      newlyDownloaded: boolean;
    } | null>();
    const ensureBinary = vi.fn(() => binaryReady.promise);
    const launcher = new HermitBridgeLauncher({
      resolveBinary: () => null,
      ensureBinary,
    });
    const options = { configPath: '/tmp/config.toml', extraArgs: ['--force'] };

    const first = launcher.ensureBinaryReady(options);
    const second = launcher.ensureBinaryReady(options);
    expect(ensureBinary).toHaveBeenCalledOnce();
    binaryReady.resolve({
      binaryPath: '/fake/downloaded-cc-connect',
      version: '1.0.0',
      newlyDownloaded: true,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { cmd: '/fake/downloaded-cc-connect', args: ['-config', '/tmp/config.toml', '--force'] },
      { cmd: '/fake/downloaded-cc-connect', args: ['-config', '/tmp/config.toml', '--force'] },
    ]);
  });

  it('promptly rejects slow binary preparation and cannot spawn after it later resolves', async () => {
    const binaryReady = deferred<{
      binaryPath: string;
      version: string;
      newlyDownloaded: boolean;
    } | null>();
    const spawn = vi.fn(() => ({ pid: 42, kill: vi.fn() }));
    const launcher = new HermitBridgeLauncher({
      spawn,
      resolveBinary: () => null,
      ensureBinary: () => binaryReady.promise,
    });
    const controller = new AbortController();

    const ensuring = launcher.ensureRunning({
      client: { listProjects: vi.fn(() => Promise.reject(new Error('offline'))) },
      configPath: '/tmp/config.toml',
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expectPromptAbort(ensuring);
    binaryReady.resolve({
      binaryPath: '/fake/downloaded-cc-connect',
      version: '1.0.0',
      newlyDownloaded: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('aborts a hanging post-spawn readiness probe and stops the owned child', async () => {
    const readyProbe = deferred<unknown>();
    const kill = vi.fn();
    const spawn = vi.fn(() => ({ pid: 42, kill }));
    const listProjects = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => readyProbe.promise);
    const launcher = new HermitBridgeLauncher({
      spawn,
      resolveBinary: () => '/fake/cc-connect',
    });
    const controller = new AbortController();

    const ensuring = launcher.ensureRunning({
      client: { listProjects },
      configPath: '/tmp/config.toml',
      pollIntervalMs: 1,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    controller.abort();

    await expectPromptAbort(ensuring);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });
});
