import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerWorkbenchNotFoundHandler } from '../../../src/main/routes/notFoundHandler';
import { createServerRuntimeState } from '../../../src/main/serverContext';

const apps: Array<ReturnType<typeof Fastify>> = [];
const tempDirs: string[] = [];

async function createHarness() {
  const staticDir = await mkdtemp(path.join(os.tmpdir(), 'agentpanel-not-found-'));
  tempDirs.push(staticDir);
  await writeFile(path.join(staticDir, 'index.html'), '<main>SPA</main>', 'utf8');
  const app = Fastify({ logger: false });
  apps.push(app);
  const openSseFallback = vi.fn((_request, reply) => reply.code(200).send('fallback'));
  registerWorkbenchNotFoundHandler(app, {
    staticDir,
    state: createServerRuntimeState(),
    openSseFallback,
  });
  return { app, openSseFallback, staticDir };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('workbench not-found handler', () => {
  it('serves the SPA shell only for extensionless browser routes', async () => {
    const { app } = await createHarness();

    const spa = await app.inject({ method: 'GET', url: '/dashboard' });
    const asset = await app.inject({ method: 'GET', url: '/missing.js' });

    expect(spa.statusCode).toBe(200);
    expect(spa.headers['content-type']).toContain('text/html');
    expect(spa.body).toBe('<main>SPA</main>');
    expect(asset.statusCode).toBe(404);
    expect(asset.body).toBe('not found');
  });

  it('preserves generic API compatibility fallbacks', async () => {
    const { app } = await createHarness();

    const getResponse = await app.inject({ method: 'GET', url: '/api/unknown' });
    const postResponse = await app.inject({ method: 'POST', url: '/api/unknown' });

    expect(getResponse.json()).toEqual([]);
    expect(postResponse.json()).toEqual({ ok: true });
  });

  it('delegates legacy SSE-shaped paths before generic API fallback', async () => {
    const { app, openSseFallback } = await createHarness();

    const response = await app.inject({ method: 'GET', url: '/api/team/a/events' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('fallback');
    expect(openSseFallback).toHaveBeenCalledTimes(1);
  });
});
