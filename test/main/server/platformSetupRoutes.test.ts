import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerPlatformSetupRoutes } from '../../../src/main/routes/platformSetupRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createHarness(fetchImpl: typeof fetch) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const dependencies = {
    getRuntimeConfig: vi.fn(() => ({
      ccBaseUrl: 'http://127.0.0.1:9820',
      ccToken: 'token',
    })),
    fetchImpl,
    persistPlatformMetadata: vi.fn(async () => undefined),
    restartBridge: vi.fn(async () => undefined),
    getProject: vi.fn(async () => ({ agent_type: 'codex', work_dir: '/code/team-a' })),
    createProject: vi.fn(async () => ({ restart_required: true, name: 'team-a' })),
  };
  registerPlatformSetupRoutes(app, dependencies);
  return { app, dependencies };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('platform setup routes', () => {
  it('proxies begin and poll requests with management auth', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;
    const harness = createHarness(fetchImpl);

    await harness.app.inject({
      method: 'POST',
      url: '/api/setup/feishu/begin',
      payload: { project: 'team-a' },
    });
    await harness.app.inject({
      method: 'POST',
      url: '/api/setup/weixin/poll',
      payload: { session_id: 'session-1' },
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:9820/api/v1/setup/feishu/begin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ project: 'team-a' }),
      }
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:9820/api/v1/setup/weixin/poll',
      expect.any(Object)
    );
  });

  it('persists routing metadata and handles restart after a successful save', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { project: 'team-a', restart_required: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;
    const harness = createHarness(fetchImpl);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/setup/feishu/save',
      payload: {
        project: 'team-a',
        platform_type: 'feishu',
        chat_id: 'chat-1',
      },
    });

    expect(response.json()).toEqual({
      data: {
        project: 'team-a',
        restart_required: false,
        restart_handled: true,
      },
    });
    expect(harness.dependencies.persistPlatformMetadata).toHaveBeenCalledWith(
      'team-a',
      'feishu',
      expect.objectContaining({ chat_id: 'chat-1' })
    );
    expect(harness.dependencies.restartBridge).toHaveBeenCalledTimes(1);
  });

  it('preserves upstream save status errors without restart', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'invalid auth' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;
    const harness = createHarness(fetchImpl);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/setup/weixin/save',
      payload: { project: 'team-a' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'invalid auth' });
    expect(harness.dependencies.restartBridge).not.toHaveBeenCalled();
  });

  it('preserves generic add-platform defaults and restart handling', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const harness = createHarness(fetchImpl);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/projects/team-a/add-platform',
      payload: { type: 'feishu', options: { app_id: 'app-1' } },
    });

    expect(harness.dependencies.createProject).toHaveBeenCalledWith(
      'team-a',
      'codex',
      '/code/team-a',
      'feishu',
      { app_id: 'app-1' }
    );
    expect(response.json()).toEqual({
      ok: true,
      data: {
        restart_required: false,
        restart_handled: true,
        name: 'team-a',
      },
    });
  });
});
