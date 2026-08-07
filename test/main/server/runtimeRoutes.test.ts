import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerRuntimeRoutes } from '../../../src/main/routes/runtimeRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const dependencies = {
    getStatus: vi.fn(async () => ({ connected: true })),
    getRuntimeReadiness: vi.fn(() => ({ status: 'ok' })),
    readEffectiveSettings: vi.fn(async () => ({ attachment_send: 'on' })),
    patchLocalSettings: vi.fn(async (patch: Record<string, unknown>) => ({
      localOnly: true,
      ...patch,
    })),
    patchRemoteSettings: vi.fn(async (patch: Record<string, unknown>) => ({
      remoteOnly: true,
      ...patch,
    })),
    defaultSettings: { attachment_send: 'on', permission_mode: 'default' },
    restartBridge: vi.fn(async () => undefined),
    reloadBridge: vi.fn(async () => undefined),
    logger: { warn: vi.fn() },
  };
  registerRuntimeRoutes(app, dependencies);
  return { app, dependencies };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('runtime health and settings routes', () => {
  it('preserves status, readiness and effective settings envelopes', async () => {
    const { app } = createHarness();

    const status = await app.inject({ method: 'GET', url: '/api/status' });
    const readiness = await app.inject({ method: 'GET', url: '/api/v1/system/readiness' });
    const settings = await app.inject({ method: 'GET', url: '/api/cc-settings' });

    expect(status.json()).toEqual({ ok: true, data: { connected: true } });
    expect(readiness.json()).toEqual({ ok: true, data: { status: 'ok' } });
    expect(settings.json()).toEqual({ ok: true, data: { attachment_send: 'on' } });
  });

  it('merges defaults, remote settings and local settings on patch', async () => {
    const { app, dependencies } = createHarness();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/cc-settings',
      payload: { permission_mode: 'acceptEdits' },
    });

    expect(response.json()).toEqual({
      ok: true,
      data: {
        attachment_send: 'on',
        permission_mode: 'acceptEdits',
        remoteOnly: true,
        localOnly: true,
      },
    });
    expect(dependencies.patchRemoteSettings).toHaveBeenCalledWith({
      permission_mode: 'acceptEdits',
    });
    expect(dependencies.patchLocalSettings).toHaveBeenCalledWith({
      permission_mode: 'acceptEdits',
    });
  });

  it('keeps locally saved settings when the remote patch fails', async () => {
    const { app, dependencies } = createHarness();
    dependencies.patchRemoteSettings.mockRejectedValueOnce(new Error('offline'));

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/cc-settings',
      payload: { attachment_send: 'off' },
    });

    expect(response.json()).toEqual({
      ok: true,
      data: {
        attachment_send: 'off',
        permission_mode: 'default',
        localOnly: true,
      },
    });
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'cc-connect settings patch failed; saved AgentPanel settings locally'
    );
  });

  it('preserves restart, reload and status error envelopes', async () => {
    const { app, dependencies } = createHarness();
    dependencies.getStatus.mockRejectedValueOnce(new Error('status failed'));
    dependencies.restartBridge.mockRejectedValueOnce(new Error('restart failed'));
    dependencies.reloadBridge.mockRejectedValueOnce(new Error('reload failed'));

    const status = await app.inject({ method: 'GET', url: '/api/status' });
    const restart = await app.inject({ method: 'POST', url: '/api/cc-restart' });
    const reload = await app.inject({ method: 'POST', url: '/api/cc-reload' });

    expect(status.json()).toEqual({ ok: false, error: 'status failed' });
    expect(restart.json()).toEqual({ ok: false, error: 'restart failed' });
    expect(reload.json()).toEqual({ ok: false, error: 'reload failed' });
  });
});
