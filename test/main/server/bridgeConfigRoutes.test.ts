import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerBridgeConfigRoutes } from '../../../src/main/routes/bridgeConfigRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

const INITIAL_TOML = `data_dir = "/tmp/data"
language = "zh"
idle_timeout_mins = 30

[management]
enabled = true
port = 9820
token = "management-secret"

[bridge]
enabled = true
port = 9810
token = "bridge-secret"

[log]
level = "info"

[display]
thinking_messages = true
tool_messages = true
`;

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  let raw = INITIAL_TOML;
  const readRaw = vi.fn(() => ({ path: '/tmp/config.toml', content: raw }));
  const writeRaw = vi.fn(async (content: string) => {
    raw = content;
  });
  registerBridgeConfigRoutes(app, { readRaw, writeRaw });
  return { app, getRaw: () => raw, readRaw, writeRaw };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('bridge config routes', () => {
  it('preserves canonical and legacy aliases with masked structured tokens', async () => {
    const harness = createHarness();

    const canonical = await harness.app.inject({
      method: 'GET',
      url: '/api/hermit-bridge-config',
    });
    const legacy = await harness.app.inject({ method: 'GET', url: '/api/cc-config' });

    const expected = {
      ok: true,
      data: {
        data_dir: '/tmp/data',
        language: 'zh',
        idle_timeout_mins: 30,
        management_enabled: true,
        management_port: 9820,
        management_token: 'mana****',
        bridge_enabled: true,
        bridge_port: 9810,
        bridge_token: 'brid****',
        log_level: 'info',
        display_thinking: true,
        display_tool: true,
      },
    };
    expect(canonical.json()).toEqual(expected);
    expect(legacy.json()).toEqual(expected);
  });

  it('updates structured TOML and reports restart-sensitive changes', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/hermit-bridge-config',
      payload: {
        language: 'en',
        management_port: 9920,
        display_thinking: false,
      },
    });

    expect(response.json()).toEqual({ ok: true, data: { needsRestart: true } });
    expect(harness.getRaw()).toContain('language = "en"');
    expect(harness.getRaw()).toContain('port = 9920');
    expect(harness.getRaw()).toContain('thinking_messages = false');
    expect(harness.writeRaw).toHaveBeenCalledTimes(1);
  });

  it('preserves raw aliases and content validation', async () => {
    const harness = createHarness();

    const read = await harness.app.inject({ method: 'GET', url: '/api/cc-config/raw' });
    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/hermit-bridge-config/raw',
      payload: { content: 42 },
    });
    const written = await harness.app.inject({
      method: 'POST',
      url: '/api/cc-config/raw',
      payload: { content: 'language = "ja"\n' },
    });

    expect(read.json()).toEqual({
      ok: true,
      data: { path: '/tmp/config.toml', content: INITIAL_TOML },
    });
    expect(invalid.json()).toEqual({ ok: false, error: 'content 必须是字符串' });
    expect(written.json()).toEqual({ ok: true });
    expect(harness.getRaw()).toBe('language = "ja"\n');
  });
});
