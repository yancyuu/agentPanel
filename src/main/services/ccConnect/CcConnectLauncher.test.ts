import { describe, expect, it, vi } from 'vitest';

import {
  buildBridgeArgs,
  CcConnectLauncher,
  resolveBridgeCommand,
  resolveHermitBridgeBinaryName,
  type SpawnedBridge,
  type SpawnFn,
} from './CcConnectLauncher';

function probe(readyAfterCalls: number) {
  let calls = 0;
  return {
    listProjects: vi.fn(async () => {
      calls += 1;
      if (calls < readyAfterCalls) throw new Error('management api not ready');
      return [];
    }),
  };
}

describe('CcConnectLauncher', () => {
  describe('resolveBridgeCommand / buildBridgeArgs', () => {
    it('builds -config <path> + extras', () => {
      expect(buildBridgeArgs({ configPath: '/c.toml', extraArgs: ['--force'] })).toEqual([
        '-config',
        '/c.toml',
        '--force',
      ]);
    });

    it('launches via `node run.js` with -config <path> + extras', () => {
      const { cmd, args } = resolveBridgeCommand(
        { configPath: '/c.toml', extraArgs: ['--force'] },
        () => '/node_modules/cc-connect/run.js'
      );
      // Mirrors the CLI (bin/hermit.mjs): spawn(node, [run.js, -config, ...]).
      expect(cmd).toBe(process.execPath);
      expect(args).toEqual(['/node_modules/cc-connect/run.js', '-config', '/c.toml', '--force']);
    });

    it('maps host platforms to the single cc-connect cross-platform binary', () => {
      expect(resolveHermitBridgeBinaryName('darwin', 'arm64')).toBe('cc-connect');
      expect(resolveHermitBridgeBinaryName('linux', 'x64')).toBe('cc-connect');
      expect(resolveHermitBridgeBinaryName('win32', 'x64')).toBe('cc-connect.exe');
      expect(resolveHermitBridgeBinaryName('win32', 'arm64')).toBe('cc-connect.exe');
    });

    it('throws when the cc-connect runner is absent (no silent fallback)', () => {
      expect(() => resolveBridgeCommand({ configPath: '/c.toml' }, () => null)).toThrow(
        /cc-connect runner not found/
      );
    });
  });

  describe('ensureRunning', () => {
    it('is a no-op when the management API already responds (never double-launches)', async () => {
      const spawn = vi.fn();
      const launcher = new CcConnectLauncher({ spawn });
      const client = probe(1); // ready immediately

      const result = await launcher.ensureRunning({
        client,
        configPath: '/c.toml',
        timeoutMs: 1000,
        pollIntervalMs: 1,
      });

      expect(result).toEqual({ launched: false, alreadyRunning: true });
      expect(spawn).not.toHaveBeenCalled();
    });

    it('spawns once and waits for readiness when nothing is running', async () => {
      const fakeChild: SpawnedBridge = { pid: 4242, kill: vi.fn() };
      const spawn = vi.fn<SpawnFn>(() => fakeChild);
      const launcher = new CcConnectLauncher({
        spawn,
        resolveBinary: () => '/node_modules/cc-connect/run.js',
      });
      const client = probe(2); // initial check fails, first poll succeeds

      const result = await launcher.ensureRunning({
        client,
        configPath: '/c.toml',
        extraArgs: ['--force'],
        timeoutMs: 1000,
        pollIntervalMs: 1,
      });

      expect(result).toEqual({ launched: true, alreadyRunning: false, pid: 4242 });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][0]).toBe(process.execPath);
      expect(spawn.mock.calls[0][1]).toEqual([
        '/node_modules/cc-connect/run.js',
        '-config',
        '/c.toml',
        '--force',
      ]);
    });

    it('rejects when the bridge never becomes ready in time', async () => {
      const spawn = vi.fn<SpawnFn>(() => ({ pid: 99, kill: vi.fn() }));
      const launcher = new CcConnectLauncher({
        spawn,
        resolveBinary: () => '/bin/cc-connect',
      });
      const client = probe(999); // never ready

      await expect(
        launcher.ensureRunning({
          client,
          configPath: '/c.toml',
          timeoutMs: 3,
          pollIntervalMs: 1,
        })
      ).rejects.toThrow(/did not become ready/);
    });
  });

  describe('stop', () => {
    it('is a no-op when nothing was launched', () => {
      const launcher = new CcConnectLauncher({
        spawn: vi.fn(),
        resolveBinary: () => '/bin/cc-connect',
      });
      expect(() => launcher.stop()).not.toThrow();
    });

    it('kills (SIGTERM) a process this launcher started', async () => {
      const kill = vi.fn();
      const spawn = vi.fn<SpawnFn>(() => ({ pid: 7, kill }));
      const launcher = new CcConnectLauncher({ spawn, resolveBinary: () => '/bin/cc-connect' });

      await launcher.ensureRunning({
        client: probe(2),
        configPath: '/c.toml',
        timeoutMs: 1000,
        pollIntervalMs: 1,
      });
      launcher.stop();

      expect(kill).toHaveBeenCalledWith('SIGTERM');
    });
  });
});
