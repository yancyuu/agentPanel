import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerBridgeProxyRoutes } from '../../../src/main/routes/bridgeProxyRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createHarness(fetchImpl: typeof fetch) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const getRuntimeConfig = vi.fn(() => ({
    ccBaseUrl: 'http://127.0.0.1:9820/',
    ccToken: 'secret-token',
  }));
  registerBridgeProxyRoutes(app, { fetchImpl, getRuntimeConfig });
  return { app, getRuntimeConfig };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('bridge proxy routes', () => {
  it('preserves aliases, query strings, auth and JSON request bodies', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;
    const { app } = createHarness(fetchImpl);

    const response = await app.inject({
      method: 'POST',
      url: '/api/bridge/projects?refresh=1',
      payload: { name: 'team-a' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9820/api/v1/projects?refresh=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token',
      },
      body: JSON.stringify({ name: 'team-a' }),
    });
  });

  it('returns the existing 502 envelope for network failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const { app } = createHarness(fetchImpl);

    const response = await app.inject({ method: 'GET', url: '/api/cc/status' });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      ok: false,
      error: 'hermit-bridge 不可达: connection refused',
    });
  });

  it('converts non-JSON upstream errors into a stable JSON error', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('<html>not found</html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        })
    ) as unknown as typeof fetch;
    const { app } = createHarness(fetchImpl);

    const response = await app.inject({ method: 'GET', url: '/api/v1/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      ok: false,
      error:
        'hermit-bridge 端点 /missing 返回了非 JSON 响应 (HTTP 404)。' +
        '请检查 hermit-bridge 是否正在运行且支持该端点。',
    });
  });
});
