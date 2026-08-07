import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerAppConfigRoutes } from '../../../src/main/routes/appConfigRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];
const tempDirs: string[] = [];

async function createHarness() {
  const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentpanel-config-routes-'));
  tempDirs.push(hermitHome);
  const app = Fastify({ logger: false });
  apps.push(app);
  const logger = { warn: vi.fn() };
  const configFile = path.join(hermitHome, 'app-config.json');
  registerAppConfigRoutes(app, { configFile, hermitHome, logger });
  return { app, configFile, hermitHome, logger };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('app config routes', () => {
  it('returns the existing default config contract when no file exists', async () => {
    const { app } = await createHarness();

    const response = await app.inject({ method: 'GET', url: '/api/config' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        notifications: { enabled: true, notifyOnUserInbox: true },
        general: { theme: 'dark', telemetryEnabled: true },
        providerConnections: {
          anthropic: { authMode: 'auto' },
          codex: { preferredAuthMode: 'auto' },
        },
      },
    });
  });

  it('merges one section, preserves defaults, and persists the result', async () => {
    const { app, configFile } = await createHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/config/update',
      payload: {
        section: 'general',
        data: { theme: 'light', agentLanguage: 'zh-CN' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        general: {
          theme: 'light',
          agentLanguage: 'zh-CN',
          launchAtLogin: false,
        },
        notifications: { enabled: true },
      },
    });
    const persisted = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      general: { theme: 'light', agentLanguage: 'zh-CN' },
    });
  });

  it('auto-heals malformed JSON and preserves the triggers response', async () => {
    const { app, configFile, hermitHome, logger } = await createHarness();
    await writeFile(configFile, '{broken', 'utf8');

    const config = await app.inject({ method: 'GET', url: '/api/config' });
    const triggers = await app.inject({ method: 'GET', url: '/api/config/triggers' });

    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({ success: true });
    expect(triggers.json()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const healed = JSON.parse(await readFile(path.join(hermitHome, 'app-config.json'), 'utf8'));
    expect(healed.general.theme).toBe('dark');
  });
});
