/* eslint-disable @typescript-eslint/require-await -- async test doubles implement Promise-returning route dependencies. */

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTeamDirectoryRoutes } from '../../../src/main/routes/teamDirectoryRoutes';
import type { ProjectUsageStats } from '../../../src/main/services/session-intelligence/SessionUsageParser';
import type {
  Task,
  TeamManifest,
} from '../../../src/main/services/team-management/TeamWorkspaceService';

const apps: ReturnType<typeof Fastify>[] = [];
type Dependencies = Parameters<typeof registerTeamDirectoryRoutes>[1];

function manifest(overrides: Partial<TeamManifest> = {}): TeamManifest {
  return {
    schemaVersion: 2,
    slug: 'team-a',
    displayName: '中文团队',
    bindProject: 'team-a-project',
    harness: 'claudecode',
    workDir: '/work/team-a',
    rootPath: '/hermit/team-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createHarness(overrides: Partial<Dependencies> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const teamProvisioning = {
    listTeams: vi.fn(async () => [manifest()]),
    readTeamManifest: vi.fn(async () => manifest()),
    readTeamManifestByProject: vi.fn(async () => manifest()),
    readTasks: vi.fn(async (): Promise<Task[]> => []),
    createTeam: vi.fn(async () => ({ slug: 'team-a', manifest: manifest() })),
    updateTeam: vi.fn(async () => manifest()),
    deleteTeam: vi.fn(async () => undefined),
    restoreTeam: vi.fn(async () => undefined),
  };
  const bridgeClient = {
    listProjects: vi.fn(async () => [
      {
        name: 'team-a-project',
        agent_type: 'claudecode',
        platforms: ['bridge', 'feishu'],
        sessions_count: 3,
        heartbeat_enabled: true,
      },
    ]),
    getProject: vi.fn(async () => ({
      name: 'team-a-project',
      agent_type: 'claudecode',
      work_dir: '/bridge/team-a',
      agent_mode: 'acceptEdits',
      platforms: [
        { type: 'bridge', connected: true },
        { type: 'feishu', connected: true },
      ],
      settings: { language: 'zh-CN', disabled_commands: ['rm'] },
      active_session_keys: ['team-a:lead'],
      heartbeat: null,
    })),
    getProviderRefs: vi.fn(async () => ['provider-a']),
    listProviders: vi.fn(async () => [{ name: 'provider-a' }]),
    deleteProject: vi.fn(async () => ({ message: 'deleted', restart_required: true })),
  };
  const dependencies = {
    teamProvisioning,
    bridgeClient,
    resolveProjectName: vi.fn(async () => 'team-a-project'),
    getProjectStatsSnapshot: vi.fn(
      () =>
        ({
          sessions: 2,
          messages: 4,
          totalTokens: 6,
          tokensIn: 1,
          tokensOut: 2,
          cacheRead: 3,
          cacheCreation: 0,
          durationMs: 7,
        }) as ProjectUsageStats
    ),
    reply500: (error: unknown) => ({ ok: false, error: String(error) }),
    homeDir: '/home/tester',
    ...overrides,
  } as unknown as Dependencies;
  registerTeamDirectoryRoutes(app, dependencies);
  return { app, dependencies, teamProvisioning, bridgeClient };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('team directory routes', () => {
  it('lists local teams, filters reserved/external teams, and reuses cached stats callback', async () => {
    const harness = createHarness();
    harness.teamProvisioning.listTeams.mockResolvedValue([
      manifest(),
      manifest({ slug: 'system-manager', bindProject: 'my-project' }),
      manifest({ slug: 'feishu:chat:user', bindProject: 'feishu:chat:user' }),
    ]);

    const response = await harness.app.inject({ method: 'GET', url: '/api/teams' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        teamName: 'team-a',
        displayName: '中文团队',
        sessionsCount: 3,
        isOnline: true,
        isExternallyReachable: true,
        externalPlatforms: ['feishu'],
        stats: expect.objectContaining({ sessions: 2, tokens: 6 }),
      }),
    ]);
    expect(harness.dependencies.getProjectStatsSnapshot).toHaveBeenCalledWith('/work/team-a');
    expect(harness.bridgeClient.getProject).not.toHaveBeenCalled();
  });

  it('preserves Chinese display names, safe bind-project validation, duplicates, and tilde expansion', async () => {
    const harness = createHarness();
    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/create',
      payload: { displayName: '中文团队', bindProject: '中文标识', workDir: '/tmp' },
    });
    expect(invalid.statusCode).toBe(400);

    harness.teamProvisioning.listTeams.mockResolvedValueOnce([
      manifest({ bindProject: 'taken', displayName: '已存在' }),
    ]);
    const duplicate = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/create',
      payload: { displayName: '新团队', bindProject: 'TAKEN'.toLowerCase(), workDir: '/tmp' },
    });
    expect(duplicate.statusCode).toBe(409);

    harness.teamProvisioning.listTeams.mockResolvedValueOnce([]);
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/create',
      payload: { displayName: '中文团队', bindProject: 'safe-project', workDir: '～/项目' },
    });
    expect(created.statusCode).toBe(200);
    expect(harness.teamProvisioning.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: '中文团队',
        bindProject: 'safe-project',
        workDir: '/home/tester/项目',
        createCcProject: false,
      })
    );
  });

  it('returns bridge-enriched data while filtering soft-deleted tasks and falls back offline', async () => {
    const harness = createHarness();
    harness.teamProvisioning.readTasks.mockResolvedValue([
      {
        id: 'active-task',
        teamSlug: 'team-a',
        title: 'Active',
        status: 'todo',
        needsClarification: 'lead',
        blockedBy: ['task-b'],
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        order: 0,
      },
      {
        id: 'deleted-task',
        teamSlug: 'team-a',
        title: 'Deleted',
        status: 'done',
        deletedAt: '2026-01-01',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        order: 1,
      },
    ]);

    const online = await harness.app.inject({ method: 'GET', url: '/api/teams/team-a/data' });
    expect(online.json()).toEqual(
      expect.objectContaining({
        isAlive: true,
        isOnline: true,
        isExternallyReachable: true,
        tasks: [
          expect.objectContaining({
            id: 'active-task',
            needsClarification: 'lead',
            blockedBy: ['task-b'],
          }),
        ],
        permissionMode: 'acceptEdits',
        providerRefs: ['provider-a'],
      })
    );

    harness.bridgeClient.getProject.mockRejectedValueOnce(new Error('offline'));
    const offline = await harness.app.inject({ method: 'GET', url: '/api/teams/team-a/data' });
    expect(offline.json()).toEqual(
      expect.objectContaining({
        isAlive: false,
        isOnline: false,
        isExternallyReachable: false,
        workDir: '/work/team-a',
        providerRefs: [],
      })
    );
  });

  it('protects reserved teams and keeps ordinary soft deletion best-effort', async () => {
    const harness = createHarness();
    const reserved = await harness.app.inject({
      method: 'DELETE',
      url: '/api/teams/system-manager',
    });
    expect(reserved.statusCode).toBe(403);

    harness.teamProvisioning.deleteTeam.mockRejectedValueOnce(new Error('already missing'));
    const deleted = await harness.app.inject({ method: 'DELETE', url: '/api/teams/team-a' });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, restartRequired: false });
  });

  it('preserves strict and best-effort permanent deletion contracts plus restore', async () => {
    const harness = createHarness();
    const restored = await harness.app.inject({ method: 'POST', url: '/api/teams/team-a/restore' });
    expect(restored.json()).toEqual({ ok: true });

    harness.bridgeClient.deleteProject.mockRejectedValueOnce(new Error('network down'));
    const strict = await harness.app.inject({
      method: 'DELETE',
      url: '/api/teams/team-a/permanent?strictExternal=true',
    });
    expect(strict.statusCode).toBe(502);
    expect(harness.teamProvisioning.deleteTeam).not.toHaveBeenCalled();

    harness.bridgeClient.deleteProject.mockRejectedValueOnce(new Error('project not found: team'));
    const missing = await harness.app.inject({
      method: 'DELETE',
      url: '/api/teams/team-a/permanent',
    });
    expect(missing.statusCode).toBe(200);
    expect(harness.teamProvisioning.deleteTeam).toHaveBeenCalledWith('team-a', {
      deleteFiles: true,
    });
  });
});
