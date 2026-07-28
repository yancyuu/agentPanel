import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildUsageTelemetryExport,
  createTelemetryEmptyStatus,
  createUsageTelemetryPresenter,
  enrichTelemetryProjectNames,
  summarizeCapabilities,
  summarizeTelemetryWorker,
  type TelemetryStatusShape,
} from '../../../src/main/routes/usageTelemetryPresenter';
import type { TeamManifest } from '../../../src/main/services/team-management/TeamWorkspaceService';
import type { TeamCapabilityTelemetrySnapshot } from '../../../src/shared/types/extensions';

const runtimeStatus = {
  running: false,
  phase: 'idle' as const,
  startedAt: null,
  updatedAt: null,
  lastError: null,
};

function baseStatus(overrides: Partial<TelemetryStatusShape> = {}): TelemetryStatusShape {
  return {
    connected: false,
    lastScan: null,
    sessions: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheCreation: 0,
    totalTokens: 0,
    activeDays: 0,
    hourly: [],
    projects: [],
    workSecondsByDay: {},
    ...overrides,
  };
}

function team(overrides: Partial<TeamManifest> & Pick<TeamManifest, 'slug'>): TeamManifest {
  return {
    schemaVersion: 2,
    displayName: overrides.slug,
    members: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as TeamManifest;
}

function capabilitySnapshot(
  overrides: Partial<TeamCapabilityTelemetrySnapshot> = {}
): TeamCapabilityTelemetrySnapshot {
  return {
    teamName: 'team-a',
    sourcePackIds: ['pack-a'],
    assets: [
      {
        kind: 'command',
        id: 'command-a',
        name: '命令 A',
        packId: 'pack-a',
        description: 'line 1, "quoted"',
      },
    ],
    counts: { commands: 1, skills: 2, workflows: 3, cron: 4, mcpServers: 5 },
    fingerprint: 'fingerprint-a',
    reportedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('usage telemetry presenter', () => {
  it('filters raw, deleted, and external projects while adding missing active teams', () => {
    const status = baseStatus({
      projects: [
        {
          cwd: '/work/team-a',
          sessions: 2,
          messages: 3,
          tokensIn: 4,
          tokensOut: 5,
          tokensTotal: 9,
        },
        {
          cwd: '/work/deleted',
          sessions: 1,
          messages: 1,
          tokensIn: 1,
          tokensOut: 1,
          tokensTotal: 2,
        },
        {
          cwd: '/raw/claude-project',
          sessions: 7,
          messages: 8,
          tokensIn: 9,
          tokensOut: 10,
          tokensTotal: 19,
        },
      ],
    });

    const enriched = enrichTelemetryProjectNames(status, [
      team({ slug: 'team-a', displayName: '团队 A', workDir: '/work/team-a' }),
      team({ slug: 'team-b', displayName: '团队 B', bindProject: 'project-b' }),
      team({ slug: 'deleted', workDir: '/work/deleted', deletedAt: '2026-01-02' }),
      team({ slug: 'feishu:chat:user', workDir: '/work/external' }),
    ]);

    expect(enriched.projects).toEqual([
      expect.objectContaining({
        cwd: '/work/team-a',
        displayName: '团队 A',
        teamSlug: 'team-a',
      }),
      expect.objectContaining({
        cwd: 'project-b',
        displayName: '团队 B',
        teamSlug: 'team-b',
        sessions: 0,
      }),
    ]);
    expect(enriched.projects.some((project) => path.basename(project.cwd) === 'deleted')).toBe(
      false
    );
  });

  it('summarizes capabilities, caches snapshots, and preserves the latest reported time', async () => {
    const snapshots = [
      capabilitySnapshot(),
      capabilitySnapshot({
        teamName: 'team-b',
        counts: { commands: 2, skills: 3, workflows: 4, cron: 5, mcpServers: 6 },
        reportedAt: '2026-01-03T00:00:00.000Z',
      }),
    ];
    const loadCapabilitySnapshots = vi.fn(() => Promise.resolve(snapshots));
    const presenter = createUsageTelemetryPresenter({
      listTeams: vi.fn(() => Promise.resolve([])),
      loadCapabilitySnapshots,
      getRuntimeStatus: () => runtimeStatus,
      warn: vi.fn(),
      now: () => 100,
    });

    const first = await presenter.enrich(baseStatus());
    const second = await presenter.enrich(baseStatus());

    expect(loadCapabilitySnapshots).toHaveBeenCalledOnce();
    expect(first.teamCapabilitySnapshots).toEqual(snapshots);
    expect(second.capabilitySummary).toEqual(summarizeCapabilities(snapshots));
    expect(second.capabilitySummary?.lastReportedAt).toBe('2026-01-03T00:00:00.000Z');
  });

  it('logs capability failures and degrades capability enrichment to empty values', async () => {
    const warn = vi.fn();
    const presenter = createUsageTelemetryPresenter({
      listTeams: vi.fn(() => Promise.reject(new Error('teams unavailable'))),
      loadCapabilitySnapshots: vi.fn(() => Promise.reject(new Error('packs unavailable'))),
      getRuntimeStatus: () => runtimeStatus,
      warn,
    });

    const result = await presenter.enrich(
      baseStatus({
        projects: [
          {
            cwd: '/raw',
            sessions: 1,
            messages: 1,
            tokensIn: 1,
            tokensOut: 1,
            tokensTotal: 2,
          },
        ],
      })
    );

    expect(result.projects).toEqual([]);
    expect(result.teamCapabilitySnapshots).toEqual([]);
    expect(result.capabilitySummary).toEqual({
      teams: 0,
      commands: 0,
      skills: 0,
      workflows: 0,
      cron: 0,
      mcpServers: 0,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.any(Error),
      'capability telemetry snapshot build failed'
    );
  });

  it('builds the existing empty and worker status shapes', () => {
    const empty = createTelemetryEmptyStatus(runtimeStatus);
    const worker = summarizeTelemetryWorker({
      status: {
        schemaVersion: 1,
        state: 'error',
        running: false,
        pid: 99,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:02:00.000Z',
        lastScan: '2026-01-01T00:01:00.000Z',
        source: 'local-jsonl',
        telemetryEnabled: true,
        telemetry: baseStatus() as never,
        lastError: 'scan failed',
      },
    });

    expect(empty).toEqual(
      expect.objectContaining({
        connected: false,
        scan: runtimeStatus,
        worker: { running: false },
        recentByProvider: expect.any(Object),
        byProvider: expect.any(Object),
        unresolvedUsage: { sessions: 0, messages: 0, tokensTotal: 0 },
      })
    );
    expect(worker).toEqual({
      running: false,
      state: 'error',
      pid: 99,
      telemetryEnabled: true,
      lastScan: '2026-01-01T00:01:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
      lastError: 'scan failed',
    });
  });

  it('preserves JSON output and CSV escaping for projects, users, and capabilities', () => {
    const status = baseStatus({
      sessions: 1,
      messages: 2,
      workSecondsByDay: { '2026-01-01': 30 },
      projects: [
        {
          cwd: '/work/team-a',
          displayName: '项目, "A"',
          sessions: 1,
          messages: 2,
          tokensIn: 3,
          tokensOut: 4,
          tokensTotal: 7,
        },
      ],
      localUsers: [
        {
          key: 'user-a',
          kind: 'local',
          identity: {
            platform: 'local',
            type: 'person',
            displayName: '用户\nA',
            confidence: 'high',
          },
          sessions: 1,
          messages: 1,
          tokensIn: 1,
          tokensOut: 1,
          cacheRead: 0,
          cacheCreation: 0,
          tokensTotal: 2,
        },
      ],
      teamCapabilitySnapshots: [capabilitySnapshot()],
      unresolvedUsage: { sessions: 1, messages: 2, tokensTotal: 3 },
    });
    const now = new Date('2026-01-02T03:04:05.678Z');

    const json = buildUsageTelemetryExport(status, 'json', now);
    const csv = buildUsageTelemetryExport(status, 'csv', now);

    expect(json).toEqual({
      filename: 'hermit-loop-usage-2026-01-02T03-04-05-678Z.json',
      mimeType: 'application/json;charset=utf-8',
      content: JSON.stringify(status, null, 2),
    });
    expect(csv.filename).toBe('hermit-loop-usage-2026-01-02T03-04-05-678Z.csv');
    expect(csv.mimeType).toBe('text/csv;charset=utf-8');
    expect(csv.content).toContain('project,"项目, ""A"""');
    expect(csv.content).toContain('local-user,"用户\nA"');
    expect(csv.content).toContain('capability-command,命令 A');
    expect(csv.content).toContain('unresolved-usage,未映射会话,1,2');
  });
});
