/* eslint-disable @typescript-eslint/require-await -- async test doubles implement Promise-returning route dependencies. */

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamRuntimeOperations,
  registerTeamRuntimeRoutes,
} from '../../../src/main/routes/teamRuntimeRoutes';
import type {
  GroupMessage,
  Task,
  TeamManifest,
} from '../../../src/main/services/team-management/TeamWorkspaceService';

const apps: ReturnType<typeof Fastify>[] = [];
type RouteDependencies = Parameters<typeof registerTeamRuntimeRoutes>[1];
type OperationDependencies = Parameters<typeof createTeamRuntimeOperations>[0];

function manifest(overrides: Partial<TeamManifest> = {}): TeamManifest {
  return {
    schemaVersion: 2,
    slug: 'team-a',
    displayName: 'Team A',
    bindProject: 'project-a',
    harness: 'claudecode',
    workDir: '/manifest/work',
    rootPath: '/hermit/team-a',
    createdAt: '2026-01-01',
    ...overrides,
  };
}

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const teamProvisioning = {
    updateTeam: vi.fn(async () => manifest({ collaboration: true })),
    readTeamManifest: vi.fn(async () => manifest()),
    readTeamManifestByProject: vi.fn(async () => manifest()),
    readTasks: vi.fn(async (): Promise<Task[]> => []),
    readMessages: vi.fn(async (): Promise<GroupMessage[]> => []),
  };
  const bridgeClient = {
    getProject: vi.fn(async () => ({
      name: 'project-a',
      agent_type: 'claudecode',
      work_dir: '/bridge/work',
      platforms: [{ type: 'bridge', connected: true }],
    })),
    updateProject: vi.fn(async () => ({ message: 'updated', restart_required: false })),
    createProject: vi.fn(async () => ({ message: 'created', restart_required: true })),
    deleteProject: vi.fn(async () => ({ message: 'deleted', restart_required: false })),
  };
  const directCliManager = {
    getSessionId: vi.fn((): string | undefined => undefined),
    send: vi.fn(async () => undefined),
    runOneShot: vi.fn(async () => undefined),
  };
  const directCliRoutes = new Map<string, { teamName: string; from: string; to: string }>();
  const restartBridge = vi.fn(async () => undefined);
  const ensureSystemManager = vi.fn(async () => undefined);
  const operationDependencies = {
    teamProvisioning,
    bridgeClient,
    directCliManager,
    directCliRoutes,
    restartBridge,
    ensureSystemManager,
    workbenchUrl: 'http://127.0.0.1:5681',
    logger: app.log,
  } as unknown as OperationDependencies;
  const operations = createTeamRuntimeOperations(operationDependencies);
  const loopAssetsScanner = {
    scanTeam: vi.fn(async (input: unknown) => ({ teamName: 'team-a', input })),
  };
  const dependencies = {
    teamProvisioning,
    bridgeClient,
    directCliManager,
    loopAssetsScanner,
    operations,
    resolveProjectName: vi.fn(async () => 'project-a'),
    restartBridge,
    reply500: (error: unknown) => ({ ok: false, error: String(error) }),
  } as unknown as RouteDependencies;
  registerTeamRuntimeRoutes(app, dependencies);
  return {
    app,
    dependencies,
    teamProvisioning,
    bridgeClient,
    directCliManager,
    directCliRoutes,
    restartBridge,
    operations,
    loopAssetsScanner,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('team runtime operations and routes', () => {
  it('prefers manifest work dirs and rejects bridge placeholder paths', async () => {
    const harness = createHarness();
    expect(await harness.operations.resolveDirectCliWorkDir('team-a')).toBe('/manifest/work');

    harness.teamProvisioning.readTeamManifestByProject.mockResolvedValueOnce(
      manifest({ workDir: '' })
    );
    harness.bridgeClient.getProject.mockResolvedValueOnce({
      name: 'project-a',
      agent_type: 'claudecode',
      work_dir: '/path/to/your/project',
      platforms: [],
    });
    expect(await harness.operations.resolveDirectCliWorkDir('team-a')).toBe('');
  });

  it('reconciles stale project work dirs and creates/restarts missing projects', async () => {
    const harness = createHarness();
    harness.bridgeClient.getProject
      .mockResolvedValueOnce({
        name: 'project-a',
        agent_type: 'claudecode',
        work_dir: '/stale/work',
        platforms: [{ type: 'bridge', connected: true }],
      })
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValueOnce({
        name: 'project-a',
        agent_type: 'claudecode',
        work_dir: '/manifest/work',
        platforms: [{ type: 'bridge', connected: true }],
      });

    const reconciled = await harness.operations.ensureLoopSessionProjectReady('team-a');
    expect(reconciled.isOnline).toBe(true);
    expect(harness.bridgeClient.updateProject).toHaveBeenCalledWith('project-a', {
      work_dir: '/manifest/work',
    });

    const restarted = await harness.operations.ensureLoopSessionProjectReady('team-a');
    expect(restarted).toEqual({ bindProject: 'project-a', projectExists: true, isOnline: true });
    expect(harness.bridgeClient.createProject).toHaveBeenCalledWith(
      'project-a',
      'claudecode',
      '/manifest/work',
      'bridge',
      {}
    );
    expect(harness.restartBridge).toHaveBeenCalled();
  });

  it('validates collaboration and scans loop assets with active task counts', async () => {
    const harness = createHarness();
    const invalid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/collaboration',
      payload: { collaboration: 'yes' },
    });
    expect(invalid.statusCode).toBe(400);

    const valid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/collaboration',
      payload: { collaboration: false },
    });
    expect(valid.statusCode).toBe(200);
    expect(harness.teamProvisioning.updateTeam).toHaveBeenCalledWith('team-a', {
      collaboration: false,
    });

    harness.teamProvisioning.readTasks.mockResolvedValueOnce([
      {
        id: 'active',
        teamSlug: 'team-a',
        title: 'Active',
        status: 'todo',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        order: 0,
      },
      {
        id: 'deleted',
        teamSlug: 'team-a',
        title: 'Deleted',
        status: 'done',
        deletedAt: '2026-01-01',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        order: 1,
      },
    ]);
    const assets = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/loop-assets',
    });
    expect(assets.statusCode).toBe(200);
    expect(harness.loopAssetsScanner.scanTeam).toHaveBeenCalledWith(
      expect.objectContaining({ taskCount: 1, bindProject: 'project-a' })
    );
  });

  it('dispatches Pi and Codex teams through the one-shot runtime path', async () => {
    const harness = createHarness();
    harness.teamProvisioning.readTeamManifestByProject.mockResolvedValueOnce(
      manifest({ harness: 'pi' })
    );

    await harness.operations.dispatchDirectCliMessage({
      teamName: 'team-a',
      sessionKey: 'team-a:task:pi',
      workDir: '/manifest/work',
      from: 'Team A',
      to: 'user',
      text: '使用内置 Pi 完成任务',
      messageId: 'pi-message',
    });

    expect(harness.directCliManager.runOneShot).toHaveBeenCalledWith(
      'team-a:task:pi',
      expect.objectContaining({ harness: 'pi', text: '使用内置 Pi 完成任务' })
    );
    expect(harness.directCliManager.send).not.toHaveBeenCalled();
  });

  it('keeps concurrent runtime replies mapped to their originating mail thread', async () => {
    const harness = createHarness();

    await harness.operations.dispatchDirectCliMessage({
      teamName: 'team-a',
      sessionKey: 'team-a:member:alice',
      workDir: '/manifest/work',
      from: 'alice',
      to: 'user',
      text: 'first',
      messageId: 'reply-1',
      conversationId: 'conversation-1',
    });
    await harness.operations.dispatchDirectCliMessage({
      teamName: 'team-a',
      sessionKey: 'team-a:member:alice',
      workDir: '/manifest/work',
      from: 'alice',
      to: 'user',
      text: 'second',
      messageId: 'reply-2',
      conversationId: 'conversation-2',
    });

    expect(harness.directCliRoutes.get('team-a:member:alice')).toEqual(
      expect.objectContaining({
        conversationId: 'conversation-2',
        conversationIdByMessageId: {
          'reply-1': 'conversation-1',
          'reply-2': 'conversation-2',
        },
      })
    );
  });

  it('preserves loop-session reuse, dispatch routing, launch, and best-effort stop', async () => {
    const harness = createHarness();
    harness.directCliManager.getSessionId.mockReturnValue('session-1');
    const session = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/loop-session',
      payload: { reuse: true, message: '继续处理' },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual(expect.objectContaining({ reused: true, messageSent: true }));
    expect(harness.directCliManager.send).toHaveBeenCalledWith(
      'team-a:lead',
      expect.objectContaining({
        text: '继续处理',
        workDir: '/manifest/work',
        teamSlug: 'team-a',
        workbenchUrl: 'http://127.0.0.1:5681',
      })
    );
    expect(harness.directCliRoutes.get('team-a:lead')).toEqual({
      teamName: 'team-a',
      from: 'team-a',
      to: 'user',
    });

    harness.bridgeClient.getProject.mockRejectedValueOnce(new Error('missing'));
    const launch = await harness.app.inject({ method: 'POST', url: '/api/teams/team-a/launch' });
    expect(launch.statusCode).toBe(200);
    expect(harness.bridgeClient.createProject).toHaveBeenCalled();

    harness.bridgeClient.deleteProject.mockRejectedValueOnce(new Error('already gone'));
    const stop = await harness.app.inject({ method: 'POST', url: '/api/teams/team-a/stop' });
    expect(stop.json()).toEqual({ ok: true });
  });
});
