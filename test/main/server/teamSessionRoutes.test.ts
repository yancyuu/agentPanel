import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTeamSessionRoutes } from '../../../src/main/routes/teamSessionRoutes';
import type { LocalSessionSummary } from '../../../src/main/services/session-intelligence/LocalSessionScanner';
import type { TeamManifest } from '../../../src/main/services/team-management/TeamWorkspaceService';
import type {
  HermitBridgeProjectDetail,
  HermitBridgeProjectListItem,
  HermitBridgeSessionDetail,
  HermitBridgeSessionListItem,
} from '../../../src/shared/types/hermitBridge';

const apps: Array<ReturnType<typeof Fastify>> = [];
type Dependencies = Parameters<typeof registerTeamSessionRoutes>[1];

const manifest = (overrides: Partial<TeamManifest> = {}): TeamManifest =>
  ({
    schemaVersion: 2,
    slug: 'team-a',
    displayName: 'Team A',
    bindProject: 'project-a',
    harness: 'claudecode',
    workDir: '/work/team-a',
    ...overrides,
  }) as TeamManifest;

const localSession = (overrides: Partial<LocalSessionSummary> = {}): LocalSessionSummary => ({
  id: 'local-1',
  title: 'Local Session',
  projectId: 'team-a',
  messageCount: 3,
  userMessageCount: 2,
  assistantMessageCount: 1,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 30,
  model: 'claude',
  active: true,
  live: true,
  startTime: '2026-01-01T00:00:00.000Z',
  endTime: '2026-01-01T00:01:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  ...overrides,
});

const ccSession = (
  overrides: Partial<HermitBridgeSessionListItem> = {}
): HermitBridgeSessionListItem => ({
  id: 'cc-1',
  name: 'Bridge Session',
  session_key: 'feishu:chat:user',
  agent_session_id: undefined,
  agent_type: 'claudecode',
  active: true,
  live: true,
  history_count: 4,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:02:00.000Z',
  last_message: null,
  platform: 'feishu',
  ...overrides,
});

const ccDetail = (
  overrides: Partial<HermitBridgeSessionDetail> = {}
): HermitBridgeSessionDetail => ({
  id: 'cc-detail',
  name: 'Bridge Detail',
  session_key: 'feishu:chat:user',
  agent_session_id: 'agent-session',
  agent_type: 'claudecode',
  active: true,
  live: true,
  history_count: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:02:00.000Z',
  platform: 'feishu',
  history: [{ role: 'user', content: 'hello', timestamp: '2026-01-01T00:01:00.000Z' }],
  ...overrides,
});

function createHarness(overrides: Partial<Dependencies> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const dependencies: Dependencies = {
    readTeamManifest: vi.fn(async () => manifest()),
    readHiddenSessionIds: vi.fn(async () => new Set<string>()),
    hideSession: vi.fn(async () => undefined),
    listTeams: vi.fn(async () => [manifest()]),
    scanSummaries: vi.fn(async () => []),
    readSessionDetail: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    getSession: vi.fn(async () => ccDetail()),
    deleteSession: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => []),
    getProject: vi.fn(async () => ({ platforms: [] }) as unknown as HermitBridgeProjectDetail),
    resolveProjectName: vi.fn(async () => 'project-a'),
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    ...overrides,
  };
  registerTeamSessionRoutes(app, dependencies);
  return { app, dependencies };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('team session and runtime read routes', () => {
  it('preserves activity and runtime compatibility response shapes', async () => {
    const harness = createHarness();
    const requests = [
      [
        '/api/teams/team-a/member-activity-meta',
        {
          teamName: 'team-a',
          computedAt: '2026-01-02T03:04:05.000Z',
          members: {},
          feedRevision: '0',
        },
      ],
      [
        '/api/teams/team-a/member-activity',
        {
          teamName: 'team-a',
          computedAt: '2026-01-02T03:04:05.000Z',
          members: {},
          feedRevision: '0',
        },
      ],
      ['/api/teams/team-a/member-spawn-statuses', { statuses: {}, runId: null }],
      [
        '/api/teams/team-a/agent-runtime',
        { teamName: 'team-a', updatedAt: '2026-01-02T03:04:05.000Z', runId: null, members: {} },
      ],
      [
        '/api/teams/team-a/lead-activity',
        { state: 'offline', updatedAt: '2026-01-02T03:04:05.000Z' },
      ],
      ['/api/teams/team-a/lead-context', { usage: null }],
    ] as const;

    for (const [url, expected] of requests) {
      const response = await harness.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
    }
  });

  it('merges local and cc sessions while filtering hidden ids', async () => {
    const scanSummaries = vi.fn(async () => [
      localSession(),
      localSession({ id: 'hidden', title: 'Hidden' }),
    ]);
    const listSessions = vi.fn(async () => [
      ccSession({ id: 'cc-local', agent_session_id: 'local-1', session_key: 'bridge:local-1' }),
      ccSession({
        id: 'cc-only',
        session_key: 'feishu:chat:other',
        updated_at: '2026-01-01T00:03:00.000Z',
      }),
      ccSession({ id: 'hidden', session_key: 'bridge:hidden' }),
    ]);
    const harness = createHarness({
      scanSummaries,
      listSessions,
      readHiddenSessionIds: vi.fn(async () => new Set(['hidden'])),
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/teams/team-a/sessions' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ id: 'cc-only', hasLocalFile: false, projectId: 'team-a' }),
      expect.objectContaining({ id: 'local-1', sessionKey: 'bridge:local-1', hasLocalFile: true }),
    ]);
    expect(scanSummaries).toHaveBeenCalledWith('/work/team-a', 'team-a');
    expect(listSessions).toHaveBeenCalledWith('project-a');
  });

  it('degrades session listing to local-only data or an empty list', async () => {
    const localOnly = createHarness({
      scanSummaries: vi.fn(async () => [localSession()]),
      listSessions: vi.fn(async () => {
        throw new Error('cc unavailable');
      }),
    });
    const localResponse = await localOnly.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/sessions',
    });

    const failed = createHarness({
      readTeamManifest: vi.fn(async () => {
        throw new Error('missing');
      }),
    });
    const failedResponse = await failed.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/sessions',
    });

    expect(localResponse.json()).toEqual([
      expect.objectContaining({ id: 'local-1', platform: 'local', hasLocalFile: true }),
    ]);
    expect(failedResponse.json()).toEqual([]);
  });

  it('prefers local detail and preserves pagination parsing before cc fallback', async () => {
    const localDetail = { id: 'local-1', history: [] } as unknown as Awaited<
      ReturnType<Dependencies['readSessionDetail']>
    >;
    const readSessionDetail = vi.fn(async () => localDetail);
    const getSession = vi.fn(async () => ccDetail());
    const harness = createHarness({ readSessionDetail, getSession });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/sessions/local-1?history_limit=25&offset=5',
    });

    expect(response.json()).toEqual(localDetail);
    expect(readSessionDetail).toHaveBeenCalledWith('/work/team-a', 'local-1', {
      offset: 5,
      limit: 25,
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('maps cc session detail and returns 404 when neither source has the session', async () => {
    const fallback = createHarness({ readSessionDetail: vi.fn(async () => null) });
    const fallbackResponse = await fallback.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/sessions/cc-detail',
    });

    const missing = createHarness({
      readSessionDetail: vi.fn(async () => null),
      getSession: vi.fn(async () => {
        throw new Error('missing');
      }),
    });
    const missingResponse = await missing.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/sessions/missing',
    });

    expect(fallbackResponse.json()).toEqual({
      id: 'agent-session',
      name: 'Bridge Detail',
      sessionKey: 'feishu:chat:user',
      agentSessionId: 'agent-session',
      agentType: 'claudecode',
      active: true,
      live: true,
      historyCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
      platform: 'feishu',
      history: [{ role: 'user', content: 'hello', timestamp: '2026-01-01T00:01:00.000Z' }],
    });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({ error: 'Session not found' });
  });

  it('archives locally before best-effort cc deletion and surfaces local archive failures', async () => {
    const deleteSession = vi.fn(async () => {
      throw new Error('cc delete failed');
    });
    const harness = createHarness({ deleteSession });
    const response = await harness.app.inject({
      method: 'DELETE',
      url: '/api/teams/team-a/sessions/session-1',
    });

    const failed = createHarness({
      hideSession: vi.fn(async () => {
        throw new Error('archive failed');
      }),
    });
    const failedResponse = await failed.app.inject({
      method: 'DELETE',
      url: '/api/teams/team-a/sessions/session-1',
    });

    expect(response.json()).toEqual({
      ok: true,
      archived: true,
      ccDeleted: false,
      warning: 'cc delete failed',
    });
    expect(harness.dependencies.hideSession).toHaveBeenCalledBefore(deleteSession);
    expect(failedResponse.statusCode).toBe(500);
    expect(failedResponse.json()).toEqual({ ok: false, error: 'archive failed' });
    expect(failed.dependencies.deleteSession).not.toHaveBeenCalled();
  });

  it('maps global and per-team liveness with degraded fallbacks', async () => {
    const projects: HermitBridgeProjectListItem[] = [
      {
        name: 'project-a',
        agent_type: 'claudecode',
        platforms: ['bridge'],
        sessions_count: 1,
        heartbeat_enabled: false,
      },
      {
        name: 'project-b',
        agent_type: 'claudecode',
        platforms: [],
        sessions_count: 0,
        heartbeat_enabled: false,
      },
    ];
    const getProject = vi.fn(async (name: string) => {
      if (name === 'project-b') throw new Error('offline');
      return { platforms: [{ type: 'bridge', connected: true }] } as HermitBridgeProjectDetail;
    });
    const harness = createHarness({
      listProjects: vi.fn(async () => projects),
      getProject,
      listTeams: vi.fn(async () => [manifest()]),
    });

    const global = await harness.app.inject({ method: 'GET', url: '/api/teams/runtime/alive' });
    const team = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/process-alive',
    });

    expect(global.json()).toEqual([
      { teamName: 'team-a', isAlive: true, runId: 'project-a' },
      { teamName: 'project-b', isAlive: false, runId: 'project-b' },
    ]);
    expect(team.json()).toBe(true);

    const degraded = createHarness({
      listProjects: vi.fn(async () => {
        throw new Error('unavailable');
      }),
      getProject: vi.fn(async () => {
        throw new Error('unavailable');
      }),
    });
    expect(
      (await degraded.app.inject({ method: 'GET', url: '/api/teams/runtime/alive' })).json()
    ).toEqual([]);
    expect(
      (await degraded.app.inject({ method: 'GET', url: '/api/teams/team-a/process-alive' })).json()
    ).toBe(false);
  });
});
