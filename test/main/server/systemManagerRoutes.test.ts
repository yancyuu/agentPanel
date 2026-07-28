import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSystemManagerRoutes } from '../../../src/main/routes/systemManagerRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const ensureSystemManager = vi.fn(async () => ({
    teamName: 'system-manager',
    displayName: '系统管理员',
  }));
  const ensureAdminLoopInitialized = vi.fn(async () => undefined);
  const systemManagerConfig = {
    getStatus: vi.fn(async () => ({ ready: true })),
    getConfig: vi.fn(async () => ({ selectedWorkDir: '/code/project' })),
    updateConfig: vi.fn(async (patch: { selectedWorkDir?: string }) => ({
      selectedWorkDir: patch.selectedWorkDir ?? '/code/project',
    })),
  };
  const workflowPrompt = {
    list: vi.fn(async (folder: string) => ({ folder, prompts: [], warnings: [] })),
    read: vi.fn(async (folder: string, id: string) => ({ folder, id, content: '# workflow' })),
  };
  const assertTrustedBrowserOrigin = vi.fn();

  registerSystemManagerRoutes(app, {
    ensureSystemManager,
    ensureAdminLoopInitialized,
    systemManagerConfig,
    workflowPrompt,
    assertTrustedBrowserOrigin,
  });

  return {
    app,
    assertTrustedBrowserOrigin,
    ensureAdminLoopInitialized,
    ensureSystemManager,
    systemManagerConfig,
    workflowPrompt,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('system manager routes', () => {
  it('ensures the manager and starts the idempotent admin bootstrap', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/system-manager/ensure',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      teamName: 'system-manager',
      displayName: '系统管理员',
    });
    expect(harness.ensureSystemManager).toHaveBeenCalledTimes(1);
    expect(harness.ensureAdminLoopInitialized).toHaveBeenCalledTimes(1);
  });

  it('preserves status and config read/update contracts', async () => {
    const harness = createHarness();

    const status = await harness.app.inject({
      method: 'GET',
      url: '/api/system-manager/status',
    });
    const config = await harness.app.inject({
      method: 'GET',
      url: '/api/system-manager/config',
    });
    const updated = await harness.app.inject({
      method: 'PUT',
      url: '/api/system-manager/config',
      payload: { selectedWorkDir: '/code/next' },
    });

    expect(status.json()).toEqual({ ready: true });
    expect(config.json()).toEqual({ selectedWorkDir: '/code/project' });
    expect(updated.json()).toEqual({ selectedWorkDir: '/code/next' });
    expect(harness.systemManagerConfig.updateConfig).toHaveBeenCalledWith({
      selectedWorkDir: '/code/next',
    });
  });

  it('uses the configured commands folder for workflow list and read', async () => {
    const harness = createHarness();
    const expectedFolder = path.join('/code/project', '.claude', 'commands');

    const list = await harness.app.inject({
      method: 'POST',
      url: '/api/system-manager/workflows/list',
      payload: {},
    });
    const read = await harness.app.inject({
      method: 'POST',
      url: '/api/system-manager/workflows/read',
      payload: { id: 'daily-summary' },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ folder: expectedFolder, prompts: [], warnings: [] });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      folder: expectedFolder,
      id: 'daily-summary',
      content: '# workflow',
    });
    expect(harness.workflowPrompt.list).toHaveBeenCalledWith(expectedFolder);
    expect(harness.workflowPrompt.read).toHaveBeenCalledWith(expectedFolder, 'daily-summary');
  });

  it('preserves workflow origin and input error status codes', async () => {
    const harness = createHarness();
    harness.assertTrustedBrowserOrigin.mockImplementationOnce(() => {
      throw new Error('Forbidden origin: https://evil.example');
    });
    harness.workflowPrompt.read.mockRejectedValueOnce(new Error('workflow not found'));

    const list = await harness.app.inject({
      method: 'POST',
      url: '/api/system-manager/workflows/list',
      payload: {},
    });
    const read = await harness.app.inject({
      method: 'POST',
      url: '/api/system-manager/workflows/read',
      payload: { folder: '', id: '' },
    });

    expect(list.statusCode).toBe(403);
    expect(list.json()).toEqual({ error: 'Forbidden origin: https://evil.example' });
    expect(read.statusCode).toBe(400);
    expect(read.json()).toEqual({ error: 'workflow not found' });
  });
});
