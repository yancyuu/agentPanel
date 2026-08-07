import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetPiRuntimeStatusCache,
  getPiRuntimeStatus,
  probePiRuntime,
  refreshPiRuntimeStatus,
} from '@main/services/system-manager/PiRuntimeStatus';

const temporaryDirectories: string[] = [];

async function makeRoot(layout: { bundledPi?: boolean; auth?: boolean }): Promise<{
  hermitHome: string;
  piHome: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-runtime-test-'));
  temporaryDirectories.push(root);
  const hermitHome = path.join(root, 'hermit');
  const piHome = path.join(root, 'pi-home');
  if (layout.bundledPi) {
    await fs.mkdir(path.join(hermitHome, 'bin'), { recursive: true });
    await fs.writeFile(path.join(hermitHome, 'bin', 'pi'), '#!/bin/sh\n');
  }
  if (layout.auth) {
    await fs.mkdir(path.join(piHome, 'agent'), { recursive: true });
    await fs.writeFile(path.join(piHome, 'agent', 'auth.json'), '{"skg":{"token":"x"}}');
  }
  return { hermitHome, piHome };
}

afterEach(async () => {
  __resetPiRuntimeStatusCache();
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('probePiRuntime', () => {
  it('内置 shim 存在且已登录时可用', async () => {
    const { hermitHome, piHome } = await makeRoot({ bundledPi: true, auth: true });
    const status = await probePiRuntime({ hermitHome, piHome });

    expect(status.available).toBe(true);
    expect(status.binaryReady).toBe(true);
    expect(status.authReady).toBe(true);
    expect(status.binaryPath).toBe(path.join(hermitHome, 'bin', 'pi'));
    expect(status.missing).toEqual([]);
  });

  it('无内置 shim 时回退 PATH 探测', async () => {
    const { hermitHome, piHome } = await makeRoot({ auth: true });
    const status = await probePiRuntime({
      hermitHome,
      piHome,
      resolveFromPath: vi.fn(async () => '/usr/local/bin/pi'),
    });

    expect(status.available).toBe(true);
    expect(status.binaryPath).toBe('/usr/local/bin/pi');
  });

  it('缺命令行或缺登录配置时不可用并给出中文缺失项', async () => {
    const { hermitHome, piHome } = await makeRoot({});
    const status = await probePiRuntime({
      hermitHome,
      piHome,
      resolveFromPath: vi.fn(async () => null),
    });

    expect(status.available).toBe(false);
    expect(status.binaryReady).toBe(false);
    expect(status.authReady).toBe(false);
    expect(status.missing.join('；')).toContain('未找到 Pi 命令行');
    expect(status.missing.join('；')).toContain('未登录配置');
  });

  it('auth.json 为空对象时视为未配置', async () => {
    const { hermitHome, piHome } = await makeRoot({ bundledPi: true });
    await fs.mkdir(path.join(piHome, 'agent'), { recursive: true });
    await fs.writeFile(path.join(piHome, 'agent', 'auth.json'), '{}');

    const status = await probePiRuntime({ hermitHome, piHome });
    expect(status.available).toBe(false);
    expect(status.authReady).toBe(false);
  });
});

describe('getPiRuntimeStatus 缓存与刷新', () => {
  it('TTL 内复用缓存，refresh 强制重测', async () => {
    const { hermitHome, piHome } = await makeRoot({ bundledPi: true, auth: true });
    const resolveFromPath = vi.fn(async () => null);

    const first = await getPiRuntimeStatus({ hermitHome, piHome, resolveFromPath });
    // 删掉 auth.json，TTL 内仍读到缓存
    await fs.rm(path.join(piHome, 'agent', 'auth.json'));
    const cached = await getPiRuntimeStatus({ hermitHome, piHome, resolveFromPath });
    expect(cached.available).toBe(first.available);

    const refreshed = await refreshPiRuntimeStatus({ hermitHome, piHome, resolveFromPath });
    expect(refreshed.available).toBe(false);
    expect(refreshed.authReady).toBe(false);
  });
});
