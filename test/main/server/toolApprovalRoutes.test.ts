import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerRuntimeState } from '../../../src/main/serverContext';
import { registerToolApprovalRoutes } from '../../../src/main/routes/toolApprovalRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];
const tempDirs: string[] = [];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const state = createServerRuntimeState();
  const respondPermission = vi.fn();
  const logger = { warn: vi.fn() };
  registerToolApprovalRoutes(app, { state, respondPermission, logger });
  return { app, logger, respondPermission, state };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('tool approval routes', () => {
  it('validates request IDs and removes completed pending approvals', async () => {
    const harness = createHarness();
    harness.state.permissionSessionByRequestId.set('request-1', {
      sessionKey: 'team-a:lead',
    });

    const missing = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tool-approval/respond',
      payload: {},
    });
    const allowed = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tool-approval/respond',
      payload: { requestId: 'request-1', allow: true },
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ ok: false, error: 'requestId required' });
    expect(allowed.json()).toEqual({ ok: true });
    expect(harness.respondPermission).toHaveBeenCalledWith(
      'team-a:lead',
      'request-1',
      true,
      undefined,
      undefined
    );
    expect(harness.state.permissionSessionByRequestId.has('request-1')).toBe(false);
  });

  it('builds AskUserQuestion updatedInput from JSON answers', async () => {
    const harness = createHarness();
    harness.state.permissionSessionByRequestId.set('request-2', {
      sessionKey: 'team-a:lead',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Proceed?' }] },
    });

    await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tool-approval/respond',
      payload: {
        requestId: 'request-2',
        allow: true,
        message: JSON.stringify({ 'Proceed?': 'Yes' }),
      },
    });

    expect(harness.respondPermission).toHaveBeenCalledWith(
      'team-a:lead',
      'request-2',
      true,
      JSON.stringify({ 'Proceed?': 'Yes' }),
      {
        questions: [{ question: 'Proceed?' }],
        answers: { 'Proceed?': 'Yes' },
      }
    );
  });

  it('merges per-team settings with defaults', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tool-approval/settings',
      payload: { autoAllowFileEdits: true, timeoutSeconds: 45 },
    });

    expect(response.json()).toEqual({ ok: true });
    expect(harness.state.toolApprovalSettingsByName.get('team-a')).toEqual({
      autoAllowAll: true,
      autoAllowFileEdits: true,
      autoAllowSafeBash: false,
      timeoutAction: 'allow',
      timeoutSeconds: 45,
    });
  });

  it('preserves best-effort file preview and CLI validation responses', async () => {
    const harness = createHarness();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentpanel-approval-'));
    tempDirs.push(directory);
    const filePath = path.join(directory, 'file.txt');
    await writeFile(filePath, 'preview', 'utf8');

    const preview = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/tool-approval/read-file',
      payload: { filePath },
    });
    const missing = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/tool-approval/read-file',
      payload: { filePath: path.join(directory, 'missing.txt') },
    });
    const validation = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/validate-cli-args',
    });

    expect(preview.json()).toEqual({ content: 'preview' });
    expect(missing.json()).toEqual({ content: '' });
    expect(validation.json()).toEqual({ valid: true, args: [], errors: [] });
  });
});
