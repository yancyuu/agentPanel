import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerExternalChannelRoutes } from '../../../src/main/routes/externalChannelRoutes';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('external channel routes', () => {
  it('persists cc-connect opt-in atomically and reports a pending app restart', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentpanel-external-channels-'));
    temporaryDirectories.push(root);
    const settingsFile = path.join(root, 'settings.json');
    const app = Fastify();
    registerExternalChannelRoutes(app, { settingsFile, enabledAtStartup: false });

    const update = await app.inject({
      method: 'PUT',
      url: '/api/external-channels/cc-connect',
      payload: { enabled: true },
    });

    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual({
      ok: true,
      data: {
        ccConnect: {
          enabled: true,
          active: false,
          restartRequired: true,
          state: 'restart-required',
        },
      },
    });
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      externalChannels: { ccConnect: { enabled: true } },
    });
    await app.close();
  });

  it('reports a booting bridge as starting and an externally managed bridge as running', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentpanel-external-channels-'));
    temporaryDirectories.push(root);
    const settingsFile = path.join(root, 'settings.json');
    const app = Fastify();
    registerExternalChannelRoutes(app, {
      settingsFile,
      enabledAtStartup: true,
      getRuntimeStatus: () => ({ status: 'degraded', bridgeLaunch: { status: 'starting' } }),
    });
    await app.inject({
      method: 'PUT',
      url: '/api/external-channels/cc-connect',
      payload: { enabled: true },
    });

    expect((await app.inject({ method: 'GET', url: '/api/external-channels' })).json()).toEqual({
      ccConnect: { enabled: true, active: false, restartRequired: false, state: 'starting' },
    });
    await app.close();
  });

  it('distinguishes a running sidecar from a persisted but pending preference', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentpanel-external-channels-'));
    temporaryDirectories.push(root);
    const settingsFile = path.join(root, 'settings.json');
    const app = Fastify();
    registerExternalChannelRoutes(app, {
      settingsFile,
      enabledAtStartup: true,
      // A working externally managed sidecar stays usable even if local binary diagnostics degraded.
      getRuntimeStatus: () => ({ status: 'degraded', bridgeLaunch: { status: 'running' } }),
    });

    await app.inject({
      method: 'PUT',
      url: '/api/external-channels/cc-connect',
      payload: { enabled: true },
    });
    const running = await app.inject({ method: 'GET', url: '/api/external-channels' });
    expect(running.json()).toEqual({
      ccConnect: { enabled: true, active: true, restartRequired: false, state: 'running' },
    });

    const disable = await app.inject({
      method: 'PUT',
      url: '/api/external-channels/cc-connect',
      payload: { enabled: false },
    });
    expect(disable.json()).toMatchObject({
      data: { ccConnect: { enabled: false, active: false, restartRequired: true } },
    });
    await app.close();
  });
});
