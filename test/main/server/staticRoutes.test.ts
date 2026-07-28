import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerStaticRoutes } from '../../../src/main/routes/staticRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('static routes', () => {
  it('returns the existing build instruction when renderer assets are missing', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const missing = path.join(os.tmpdir(), `missing-renderer-${Date.now()}`);
    await registerStaticRoutes(app, { staticDir: missing });

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain(`UI not built. Run: pnpm build:web (output → ${missing})`);
  });

  it('serves built renderer assets when the static directory exists', async () => {
    const staticDir = await mkdtemp(path.join(os.tmpdir(), 'agentcli-static-routes-'));
    tempDirs.push(staticDir);
    await writeFile(path.join(staticDir, 'index.html'), '<main>Workbench</main>', 'utf8');
    const app = Fastify({ logger: false });
    apps.push(app);
    await registerStaticRoutes(app, { staticDir });

    const response = await app.inject({ method: 'GET', url: '/index.html' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<main>Workbench</main>');
  });
});
