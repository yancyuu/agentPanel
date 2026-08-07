import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerHermitConfigRoutes } from '../../../src/main/routes/hermitConfigRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

type RuntimeConfig = {
  ccBaseUrl: string;
  ccToken: string;
  ccBridgeUrl: string;
  ccBridgeToken: string;
};

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  let config: RuntimeConfig = {
    ccBaseUrl: 'http://127.0.0.1:9820',
    ccToken: 'secret-token',
    ccBridgeUrl: 'ws://127.0.0.1:9810/bridge/ws',
    ccBridgeToken: 'bridge-token',
  };
  const getConfig = vi.fn(() => config);
  const saveConfig = vi.fn((patch: Partial<RuntimeConfig>) => {
    config = { ...config, ...patch };
    return config;
  });
  const readRaw = vi.fn(() => ({ path: '/tmp/config.json', content: '{"ok":true}\n' }));
  const writeRaw = vi.fn((content: string) => {
    config = JSON.parse(content) as RuntimeConfig;
    return config;
  });
  const updateBridgeClient = vi.fn();
  const updateBridgeConnection = vi.fn();

  registerHermitConfigRoutes(app, {
    getConfig,
    saveConfig,
    readRaw,
    writeRaw,
    updateBridgeClient,
    updateBridgeConnection,
  });
  return {
    app,
    getConfig,
    readRaw,
    saveConfig,
    updateBridgeClient,
    updateBridgeConnection,
    writeRaw,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Hermit runtime config routes', () => {
  it('masks the management token in the read response', async () => {
    const { app } = createHarness();

    const response = await app.inject({ method: 'GET', url: '/api/hermit-config' });

    expect(response.json()).toEqual({
      ok: true,
      data: {
        ccBaseUrl: 'http://127.0.0.1:9820',
        ccToken: 'secr****',
        ccTokenSet: true,
        ccBridgeUrl: 'ws://127.0.0.1:9810/bridge/ws',
      },
    });
  });

  it('normalizes updates and hot-updates both bridge clients', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/hermit-config',
      payload: { ccBaseUrl: '  ', ccToken: ' next-token ', ccBridgeUrl: '  ' },
    });

    expect(response.json()).toEqual({
      ok: true,
      data: { ccBaseUrl: 'http://127.0.0.1:9820', ccTokenSet: true },
    });
    expect(harness.saveConfig).toHaveBeenCalledWith({
      ccBaseUrl: 'http://127.0.0.1:9820',
      ccToken: 'next-token',
      ccBridgeUrl: 'ws://127.0.0.1:9810/bridge/ws',
    });
    expect(harness.updateBridgeClient).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:9820',
      token: 'next-token',
    });
    expect(harness.updateBridgeConnection).toHaveBeenCalledWith({
      bridgeUrl: 'ws://127.0.0.1:9810/bridge/ws',
      bridgeToken: 'bridge-token',
    });
  });

  it('preserves raw read/write and validation envelopes', async () => {
    const harness = createHarness();
    const read = await harness.app.inject({ method: 'GET', url: '/api/hermit-config/raw' });
    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/hermit-config/raw',
      payload: { content: 42 },
    });
    const nextConfig: RuntimeConfig = {
      ccBaseUrl: 'http://localhost:9820',
      ccToken: '',
      ccBridgeUrl: 'ws://localhost:9810/bridge/ws',
      ccBridgeToken: '',
    };
    const written = await harness.app.inject({
      method: 'POST',
      url: '/api/hermit-config/raw',
      payload: { content: JSON.stringify(nextConfig) },
    });

    expect(read.json()).toEqual({
      ok: true,
      data: { path: '/tmp/config.json', content: '{"ok":true}\n' },
    });
    expect(invalid.json()).toEqual({ ok: false, error: 'content 必须是字符串' });
    expect(written.json()).toEqual({
      ok: true,
      data: { ccBaseUrl: 'http://localhost:9820', ccTokenSet: false },
    });
    expect(harness.writeRaw).toHaveBeenCalledWith(JSON.stringify(nextConfig));
  });
});
