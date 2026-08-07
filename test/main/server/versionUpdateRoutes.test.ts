import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerVersionUpdateRoutes } from '../../../src/main/routes/versionUpdateRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createApp() {
  const app = Fastify({ logger: false });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('version and update routes', () => {
  it('returns the package version as an application/json string', async () => {
    const app = createApp();
    registerVersionUpdateRoutes(app, {
      version: '1.2.3',
      updateService: {
        checkForUpdates: vi.fn(),
        applyUpdate: vi.fn(),
      },
    });

    const response = await app.inject({ method: 'GET', url: '/api/version' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toBe('1.2.3');
  });

  it('delegates update checks without reshaping the response', async () => {
    const app = createApp();
    const versionInfo = {
      currentVersion: '1.2.3',
      latestVersion: '1.2.4',
      updateAvailable: true,
    };
    const checkForUpdates = vi.fn(async () => versionInfo);
    registerVersionUpdateRoutes(app, {
      version: '1.2.3',
      updateService: {
        checkForUpdates,
        applyUpdate: vi.fn(),
      },
    });

    const response = await app.inject({ method: 'GET', url: '/api/update/check' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(versionInfo);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('streams update progress with the existing SSE payload format', async () => {
    const app = createApp();
    const applyUpdate = vi.fn(async (onProgress?: (progress: unknown) => void) => {
      onProgress?.({ phase: 'checking', message: 'Checking' });
      onProgress?.({ phase: 'completed', message: 'Done' });
      return true;
    });
    registerVersionUpdateRoutes(app, {
      version: '1.2.3',
      updateService: {
        checkForUpdates: vi.fn(),
        applyUpdate,
      },
    });

    const response = await app.inject({ method: 'POST', url: '/api/update/apply' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain(
      `data: ${JSON.stringify({ phase: 'checking', message: 'Checking' })}`
    );
    expect(response.body).toContain(
      `data: ${JSON.stringify({ phase: 'completed', message: 'Done' })}`
    );
  });
});
