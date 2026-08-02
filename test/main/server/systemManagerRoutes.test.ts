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
  const diagnosticRuns = {
    getCurrent: vi.fn(async () => null),
    start: vi.fn(
      async (input: { actionId: string; title: string; prompt: string; workDir: string }) => ({
        id: 'diag-1',
        ...input,
        status: 'running',
      })
    ),
  };
  const workspaceCleanup = {
    scan: vi.fn(async (selectedWorkDir?: string) => ({
      scannedAt: '2026-01-01T00:00:00.000Z',
      selectedWorkDir,
      candidates: [],
      totalBytes: 0,
      totalItems: 0,
      scannedWorkspaces: 1,
      warnings: [],
    })),
    clean: vi.fn(async (ids: string[], selectedWorkDir?: string) => ({
      removedIds: ids,
      selectedWorkDir,
    })),
  };
  const workflowPrompt = {
    list: vi.fn(async (folder: string) => ({ folder, prompts: [], warnings: [] })),
    read: vi.fn(async (folder: string, id: string) => ({ folder, id, content: '# workflow' })),
  };
  const assertTrustedBrowserOrigin = vi.fn();
  const piReady: import('../../../src/main/services/system-manager/PiRuntimeStatus').PiRuntimeStatus =
    {
      available: true,
      binaryReady: true,
      authReady: true,
      missing: [],
      checkedAt: '2026-01-01T00:00:00.000Z',
    };
  const getPiRuntimeStatus = vi.fn(async () => piReady);
  const refreshPiRuntimeStatus = vi.fn(async () => piReady);

  registerSystemManagerRoutes(app, {
    ensureSystemManager,
    ensureAdminLoopInitialized,
    systemManagerConfig,
    diagnosticRuns,
    workspaceCleanup,
    workflowPrompt,
    assertTrustedBrowserOrigin,
    getPiRuntimeStatus,
    refreshPiRuntimeStatus,
  });

  return {
    app,
    assertTrustedBrowserOrigin,
    ensureAdminLoopInitialized,
    ensureSystemManager,
    systemManagerConfig,
    diagnosticRuns,
    workspaceCleanup,
    workflowPrompt,
    getPiRuntimeStatus,
    refreshPiRuntimeStatus,
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

  it('persists and starts diagnostic runs through dedicated endpoints', async () => {
    const harness = createHarness();

    const current = await harness.app.inject({
      method: 'GET',
      url: '/api/system-manager/diagnostics/current',
    });
    const started = await harness.app.inject({
      method: 'POST',
      url: '/api/system-manager/diagnostics/run',
      payload: {
        actionId: 'task-health',
        title: '任务积压检查',
        prompt: '只读检查任务积压',
      },
    });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toBeNull();
    expect(started.statusCode).toBe(202);
    expect(harness.diagnosticRuns.start).toHaveBeenCalledWith({
      actionId: 'task-health',
      title: '任务积压检查',
      prompt: '只读检查任务积压',
      workDir: '/code/project',
    });
  });

  it('exposes the pi runtime probe and blocks diagnostics when pi is unavailable', async () => {
    const harness = createHarness();

    const runtime = await harness.app.inject({
      method: 'GET',
      url: '/api/system-manager/diagnostics/runtime',
    });
    expect(runtime.statusCode).toBe(200);
    expect(runtime.json()).toMatchObject({ available: true, binaryReady: true, authReady: true });

    const refreshed = await harness.app.inject({
      method: 'GET',
      url: '/api/system-manager/diagnostics/runtime?refresh=1',
    });
    expect(refreshed.statusCode).toBe(200);
    expect(harness.refreshPiRuntimeStatus).toHaveBeenCalled();

    harness.getPiRuntimeStatus.mockResolvedValue({
      available: false,
      binaryReady: false,
      authReady: false,
      missing: ['未找到 Pi 命令行'],
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const blocked = await harness.app.inject({
      method: 'POST',
      url: '/api/system-manager/diagnostics/run',
      payload: {
        actionId: 'task-health',
        title: '任务积压检查',
        prompt: '只读检查任务积压',
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: 'pi_runtime_missing',
    });
    expect(blocked.json().error).toContain('需先配置 Pi 运行时');
    expect(blocked.json().error).toContain('未找到 Pi 命令行');
    expect(harness.diagnosticRuns.start).not.toHaveBeenCalled();
  });

  it('scans and cleans only through the dedicated cleanup service', async () => {
    const harness = createHarness();

    const scan = await harness.app.inject({
      method: 'GET',
      url: '/api/system-manager/cleanup/scan',
    });
    const clean = await harness.app.inject({
      method: 'POST',
      url: '/api/system-manager/cleanup',
      payload: { ids: ['candidate-1', 'candidate-2'] },
    });

    expect(scan.statusCode).toBe(200);
    expect(harness.workspaceCleanup.scan).toHaveBeenCalledWith('/code/project');
    expect(clean.statusCode).toBe(200);
    expect(harness.assertTrustedBrowserOrigin).toHaveBeenCalled();
    expect(harness.workspaceCleanup.clean).toHaveBeenCalledWith(
      ['candidate-1', 'candidate-2'],
      '/code/project'
    );
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
