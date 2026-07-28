import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerWorkspaceRoutes } from '../../../src/main/routes/workspaceRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];
const tempDirs: string[] = [];

async function createHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentcli-workspace-routes-'));
  tempDirs.push(root);
  const app = Fastify({ logger: false });
  apps.push(app);
  registerWorkspaceRoutes(app);
  return { app, root };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('workspace routes', () => {
  it('browses visible child directories with the existing envelope', async () => {
    const { app, root } = await createHarness();
    await mkdir(path.join(root, 'visible'));
    await mkdir(path.join(root, '.hidden'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/config/browse-folders',
      payload: { path: root, limit: 10 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        path: root,
        dirs: [path.join(root, 'visible')],
        hasParent: true,
      },
    });
  });

  it('lists workspace files and preserves extension and size fields', async () => {
    const { app, root } = await createHarness();
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'readme.md'), 'hello', 'utf8');

    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/list',
      payload: { dirPath: root },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      path: root,
      files: expect.arrayContaining([
        { name: 'src', isDirectory: true, size: expect.any(Number), ext: '' },
        { name: 'readme.md', isDirectory: false, size: 5, ext: 'md' },
      ]),
      hasParent: true,
    });
  });

  it('returns compatibility error shapes for unreadable paths', async () => {
    const { app, root } = await createHarness();
    const missing = path.join(root, 'missing');

    const browse = await app.inject({
      method: 'POST',
      url: '/api/config/browse-folders',
      payload: { path: missing },
    });
    const workspace = await app.inject({
      method: 'POST',
      url: '/api/workspace/list',
      payload: { dirPath: missing },
    });

    expect(browse.json()).toEqual({ success: false, error: `无法访问目录: ${missing}` });
    expect(workspace.json()).toEqual({
      path: missing,
      files: [],
      hasParent: false,
      error: `无法访问目录: ${missing}`,
    });
  });
});
