import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerTeamActionCompatibilityRoutes,
  registerTeamCompatibilityRoutes,
  registerTeamKanbanCompatibilityRoutes,
  registerTeamMemberCompatibilityRoutes,
  registerTeamMemberStatsRoutes,
  registerTeamProvisioningCompatibilityRoutes,
} from '../../../src/main/routes/teamCompatibilityRoutes';
import type { LocalSessionSummary } from '../../../src/main/services/session-intelligence/LocalSessionScanner';
import type { TeamManifest } from '../../../src/main/services/team-management/TeamWorkspaceService';

const apps: Array<ReturnType<typeof Fastify>> = [];
type MemberStatsDependencies = Parameters<typeof registerTeamMemberStatsRoutes>[1];

function registerAllCompatibilityRoutes(
  app: ReturnType<typeof Fastify>,
  memberStatsDependencies: MemberStatsDependencies
): void {
  registerTeamCompatibilityRoutes(app);
  registerTeamMemberCompatibilityRoutes(app);
  registerTeamProvisioningCompatibilityRoutes(app);
  registerTeamKanbanCompatibilityRoutes(app);
  registerTeamActionCompatibilityRoutes(app);
  registerTeamMemberStatsRoutes(app, memberStatsDependencies);
}

function createHarness(overrides: Partial<MemberStatsDependencies> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const dependencies: MemberStatsDependencies = {
    readTeamManifest: vi.fn(
      async () =>
        ({
          schemaVersion: 2,
          slug: 'team-a',
          displayName: 'Team A',
          bindProject: 'project-a',
          harness: 'claudecode',
          workDir: '/work/team-a',
        }) as TeamManifest
    ),
    scanSummaries: vi.fn(async () => []),
    readTasksForStats: vi.fn(async () => []),
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    ...overrides,
  };
  registerAllCompatibilityRoutes(app, dependencies);
  return { app, dependencies };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('team compatibility routes', () => {
  it('pins exact response contracts for compatibility stubs and aliases', async () => {
    const harness = createHarness();
    const cases: Array<{
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      url: string;
      expected: unknown;
    }> = [
      { method: 'GET', url: '/api/teams/team-a/saved-request', expected: null },
      {
        method: 'GET',
        url: '/api/teams/team-a/kanban',
        expected: { teamName: 'team-a', reviewers: [], tasks: {} },
      },
      { method: 'GET', url: '/api/teams/team-a/task-change-presence', expected: {} },
      { method: 'POST', url: '/api/teams/team-a/kanban-column-order', expected: { ok: true } },
      { method: 'POST', url: '/api/teams/team-a/members', expected: { ok: true } },
      { method: 'DELETE', url: '/api/teams/team-a/members/member-a', expected: { ok: true } },
      { method: 'PATCH', url: '/api/teams/team-a/members/member-a/role', expected: { ok: true } },
      { method: 'POST', url: '/api/teams/team-a/members/member-a/restart', expected: { ok: true } },
      {
        method: 'POST',
        url: '/api/teams/team-a/members/member-a/skip-launch',
        expected: { ok: true },
      },
      { method: 'GET', url: '/api/teams/team-a/claude-logs', expected: { logs: [], total: 0 } },
      {
        method: 'POST',
        url: '/api/teams/provisioning/prepare',
        expected: { runId: null, warnings: [] },
      },
      {
        method: 'GET',
        url: '/api/teams/provisioning/run-1',
        expected: { runId: '', phase: 'done', progress: 100, message: '', done: true, error: null },
      },
      { method: 'POST', url: '/api/teams/provisioning/run-1/cancel', expected: { ok: true } },
      { method: 'GET', url: '/api/teams/templates', expected: { sources: [], templates: [] } },
      {
        method: 'POST',
        url: '/api/teams/templates/save',
        expected: { sources: [], templates: [] },
      },
      {
        method: 'POST',
        url: '/api/teams/templates/refresh',
        expected: { sources: [], templates: [] },
      },
      { method: 'PUT', url: '/api/teams/team-a/members', expected: { ok: true } },
      { method: 'DELETE', url: '/api/teams/team-a/draft', expected: { ok: true } },
      { method: 'PATCH', url: '/api/teams/team-a/kanban/task-1', expected: { ok: true } },
      { method: 'PUT', url: '/api/teams/team-a/kanban/column-order', expected: { ok: true } },
      { method: 'POST', url: '/api/teams/team-a/members/member-a/skip', expected: { ok: true } },
      {
        method: 'POST',
        url: '/api/teams/team-a/task-clarification/task-1',
        expected: { ok: true },
      },
      {
        method: 'DELETE',
        url: '/api/teams/team-a/tasks/task-1/relationships',
        expected: { ok: true },
      },
      { method: 'POST', url: '/api/teams/config', expected: { ok: true } },
      { method: 'POST', url: '/api/teams/team-a/kill-process', expected: { ok: true } },
      { method: 'GET', url: '/api/teams/team-a/member-logs/member-a', expected: [] },
      { method: 'GET', url: '/api/teams/team-a/task-logs/task-1', expected: [] },
      { method: 'GET', url: '/api/teams/team-a/activity', expected: [] },
      { method: 'GET', url: '/api/teams/team-a/task-activity-detail', expected: { entries: [] } },
      {
        method: 'GET',
        url: '/api/teams/team-a/task-log-stream-summary/task-1',
        expected: { chunks: [] },
      },
      { method: 'GET', url: '/api/teams/team-a/task-log-stream/task-1', expected: { chunks: [] } },
      {
        method: 'GET',
        url: '/api/teams/team-a/exact-log-summaries/task-1',
        expected: { logs: [] },
      },
      { method: 'GET', url: '/api/teams/team-a/exact-log-detail/task-1', expected: { lines: [] } },
    ];

    for (const testCase of cases) {
      const response = await harness.app.inject({ method: testCase.method, url: testCase.url });
      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(200);
      expect(response.json(), `${testCase.method} ${testCase.url}`).toEqual(testCase.expected);
    }
  });

  it('aggregates member stats from all local session summaries and completed tasks', async () => {
    const sessions: LocalSessionSummary[] = [
      {
        id: 'session-1',
        title: 'One',
        projectId: 'team-a',
        messageCount: 3,
        userMessageCount: 2,
        assistantMessageCount: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 2,
        totalTokens: 37,
        model: 'claude',
        active: false,
        live: false,
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-01T00:10:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:10:00.000Z',
      },
      {
        id: 'session-2',
        title: 'Two',
        projectId: 'team-a',
        messageCount: 4,
        userMessageCount: 2,
        assistantMessageCount: 2,
        inputTokens: 30,
        outputTokens: 40,
        cacheReadTokens: 6,
        cacheCreationTokens: 3,
        totalTokens: 79,
        model: 'claude',
        active: false,
        live: false,
        startTime: '2026-01-01T00:05:00.000Z',
        endTime: '2026-01-01T00:20:00.000Z',
        createdAt: '2026-01-01T00:05:00.000Z',
        updatedAt: '2026-01-01T00:20:00.000Z',
      },
    ];
    const harness = createHarness({
      scanSummaries: vi.fn(async () => sessions),
      readTasksForStats: vi.fn(async () => [
        { status: 'done' },
        { status: 'done' },
        { status: 'doing' },
      ]),
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/member-stats/member-a',
    });

    expect(response.json()).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
      filesTouched: [],
      fileStats: {},
      toolUsage: {},
      inputTokens: 40,
      outputTokens: 60,
      cacheReadTokens: 11,
      cacheCreationTokens: 5,
      totalTokens: 116,
      costUsd: 0,
      tasksCompleted: 2,
      messageCount: 7,
      totalDurationMs: 1_200_000,
      sessionCount: 2,
      computedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(harness.dependencies.scanSummaries).toHaveBeenCalledWith('/work/team-a', 'team-a');
    expect(harness.dependencies.readTasksForStats).toHaveBeenCalledWith('team-a');
  });

  it('keeps task counting best-effort and clamps negative durations', async () => {
    const harness = createHarness({
      scanSummaries: vi.fn(async () => [
        {
          id: 'session-1',
          title: 'One',
          projectId: 'team-a',
          messageCount: 1,
          userMessageCount: 1,
          assistantMessageCount: 0,
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 4,
          totalTokens: 10,
          model: 'claude',
          active: false,
          live: false,
          startTime: '2026-01-01T00:10:00.000Z',
          endTime: '2026-01-01T00:00:00.000Z',
          createdAt: '2026-01-01T00:10:00.000Z',
          updatedAt: '2026-01-01T00:10:00.000Z',
        },
      ]),
      readTasksForStats: vi.fn(async () => {
        throw new Error('missing board');
      }),
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/member-stats/member-a',
    });

    expect(response.json()).toEqual(
      expect.objectContaining({
        tasksCompleted: 0,
        totalDurationMs: 0,
        sessionCount: 1,
        computedAt: '2026-01-02T03:04:05.000Z',
      })
    );
  });

  it('returns the zero member stats contract when manifest or session scanning fails', async () => {
    const harness = createHarness({
      readTeamManifest: vi.fn(async () => {
        throw new Error('missing team');
      }),
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/member-stats/member-a',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
      filesTouched: [],
      fileStats: {},
      toolUsage: {},
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      tasksCompleted: 0,
      messageCount: 0,
      totalDurationMs: 0,
      sessionCount: 0,
      computedAt: '2026-01-02T03:04:05.000Z',
    });
  });
});
