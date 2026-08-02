import path from 'node:path';

import { isExternalPlatformSessionKey } from '../utils/externalPlatformSessionRouting';

import type { UsageTelemetryRuntimeStatus } from '../services/session-intelligence/UsageTelemetryService';
import type {
  UsageTelemetryStatus,
  UsageUnresolvedSummary,
  UserUsageTelemetryRow,
} from '../services/session-intelligence/usageTypes';
import type { TeamManifest } from '../services/team-management/TeamWorkspaceService';
import type { UsageTelemetryWorkerStatus } from '../telemetry/worker';
import type {
  CapabilityTelemetrySummary,
  TeamCapabilityTelemetrySnapshot,
} from '@shared/types/extensions';

export interface TelemetryProjectRow {
  cwd: string;
  displayName?: string;
  teamSlug?: string;
  bindProject?: string;
  deletedAt?: string;
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
}

export interface TelemetryStatusShape {
  ok?: boolean;
  connected: boolean;
  scan?: UsageTelemetryRuntimeStatus;
  worker?: {
    running: boolean;
    state?: string;
    pid?: number | null;
    telemetryEnabled?: boolean;
    lastScan?: string | null;
    updatedAt?: string | null;
    lastError?: string | null;
  };
  lastScan: string | null;
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  totalTokens: number;
  recentMessages?: number;
  recentTokensTotal?: number;
  recentByProvider?: UsageTelemetryStatus['recentByProvider'];
  byProvider?: UsageTelemetryStatus['byProvider'];
  activeDays: number;
  hourly: number[];
  projects: TelemetryProjectRow[];
  workSecondsByDay: Record<string, number>;
  daily?: UsageTelemetryStatus['daily'];
  localUsers?: UserUsageTelemetryRow[];
  teamCapabilitySnapshots?: TeamCapabilityTelemetrySnapshot[];
  capabilitySummary?: CapabilityTelemetrySummary;
  unresolvedUsage?: UsageUnresolvedSummary;
}

interface UsageTelemetryPresenterDependencies {
  listTeams: () => Promise<TeamManifest[]>;
  loadCapabilitySnapshots: () => Promise<TeamCapabilityTelemetrySnapshot[]>;
  getRuntimeStatus: () => UsageTelemetryRuntimeStatus;
  warn: (error: unknown, message: string) => void;
  now?: () => number;
}

export interface UsageTelemetryPresenter {
  enrich: (status: TelemetryStatusShape) => Promise<TelemetryStatusShape>;
  emptyStatus: () => TelemetryStatusShape;
  workerSummary: (workerStatus: UsageTelemetryWorkerReadResult) => TelemetryStatusShape['worker'];
  buildExport: (
    status: TelemetryStatusShape,
    format: 'csv' | 'json'
  ) => { filename: string; mimeType: string; content: string };
  getRuntimeStatus: () => UsageTelemetryRuntimeStatus;
}

export interface UsageTelemetryWorkerReadResult {
  status: UsageTelemetryWorkerStatus | null;
  error?: string;
}

const CAPABILITY_REPORT_TTL_MS = 10 * 60 * 1000;

export function summarizeCapabilities(
  snapshots: TeamCapabilityTelemetrySnapshot[]
): CapabilityTelemetrySummary {
  const summary: CapabilityTelemetrySummary = {
    teams: 0,
    commands: 0,
    skills: 0,
    workflows: 0,
    cron: 0,
    mcpServers: 0,
  };
  for (const snapshot of snapshots) {
    summary.teams += 1;
    summary.commands += snapshot.counts.commands;
    summary.skills += snapshot.counts.skills;
    summary.workflows += snapshot.counts.workflows;
    summary.cron += snapshot.counts.cron;
    summary.mcpServers += snapshot.counts.mcpServers;
    if (!summary.lastReportedAt || summary.lastReportedAt < snapshot.reportedAt) {
      summary.lastReportedAt = snapshot.reportedAt;
    }
  }
  return summary;
}

export function enrichTelemetryProjectNames<T extends { projects: TelemetryProjectRow[] }>(
  status: T,
  teams: TeamManifest[]
): T {
  const activeTeams = teams.filter(
    (team) =>
      !team.deletedAt &&
      !isExternalPlatformSessionKey(team.slug) &&
      !isExternalPlatformSessionKey(team.bindProject || '')
  );
  const byWorkDir = new Map<string, TeamManifest>();
  const byBindProject = new Map<string, TeamManifest>();
  for (const team of activeTeams) {
    const workDir = (team.workDir || '').trim();
    if (workDir) byWorkDir.set(path.resolve(workDir), team);
    if (team.bindProject) byBindProject.set(team.bindProject, team);
    byBindProject.set(team.slug, team);
  }

  const seenTeamSlugs = new Set<string>();
  const projects = status.projects.flatMap((project) => {
    const cwd = (project.cwd || '').trim();
    const team =
      (cwd ? byWorkDir.get(path.resolve(cwd)) : undefined) ??
      byBindProject.get(cwd) ??
      byBindProject.get(path.basename(cwd));
    if (team?.deletedAt) return [];
    if (!team) return [];
    seenTeamSlugs.add(team.slug);
    return [
      {
        ...project,
        displayName: team.displayName || team.slug,
        teamSlug: team.slug,
        bindProject: team.bindProject,
      },
    ];
  });

  for (const team of activeTeams) {
    if (seenTeamSlugs.has(team.slug)) continue;
    projects.push({
      cwd: team.workDir || team.bindProject || team.slug,
      displayName: team.displayName || team.slug,
      teamSlug: team.slug,
      bindProject: team.bindProject,
      sessions: 0,
      messages: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 0,
    });
  }

  return { ...status, projects };
}

export function createTelemetryEmptyStatus(
  runtimeStatus: UsageTelemetryRuntimeStatus
): TelemetryStatusShape {
  return {
    connected: false,
    scan: runtimeStatus,
    worker: { running: false },
    lastScan: null,
    sessions: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheCreation: 0,
    totalTokens: 0,
    recentMessages: 0,
    recentTokensTotal: 0,
    recentByProvider: {
      claudecode: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
      codex: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
      pi: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
    },
    byProvider: {
      claudecode: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
      codex: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
      pi: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
    },
    activeDays: 0,
    hourly: [],
    projects: [],
    workSecondsByDay: {},
    daily: {},
    localUsers: [],
    teamCapabilitySnapshots: [],
    capabilitySummary: { teams: 0, commands: 0, skills: 0, workflows: 0, cron: 0, mcpServers: 0 },
    unresolvedUsage: { sessions: 0, messages: 0, tokensTotal: 0 },
  };
}

export function summarizeTelemetryWorker(
  workerStatus: UsageTelemetryWorkerReadResult
): TelemetryStatusShape['worker'] {
  const status = workerStatus.status;
  return {
    running: Boolean(status?.running),
    state: status?.state,
    pid: status?.pid ?? null,
    telemetryEnabled: Boolean(status?.telemetryEnabled),
    lastScan: status?.lastScan ?? null,
    updatedAt: status?.updatedAt ?? null,
    lastError: status?.lastError ?? null,
  };
}

export function csvCell(value: unknown): string {
  const text = String(
    (value ?? '') as string | number | boolean | bigint | symbol | null | undefined
  );
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildUsageTelemetryExport(
  status: TelemetryStatusShape,
  format: 'csv' | 'json',
  now = new Date()
): { filename: string; mimeType: string; content: string } {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  if (format === 'json') {
    return {
      filename: `hermit-loop-usage-${stamp}.json`,
      mimeType: 'application/json;charset=utf-8',
      content: JSON.stringify(status, null, 2),
    };
  }

  const rows = [
    [
      'section',
      'name',
      'sessions',
      'messages',
      'tokensIn',
      'tokensOut',
      'cacheRead',
      'cacheCreation',
      'totalTokens',
      'activeDays',
      'durationSeconds',
      'cwd',
      'teamSlug',
      'teamName',
      'teamDisplayName',
      'projectName',
      'bindProject',
      'sourceKind',
      'assetKind',
      'description',
    ],
    [
      'summary',
      '累计 Loop 数据',
      status.sessions,
      status.messages,
      status.tokensIn,
      status.tokensOut,
      status.cacheRead,
      status.cacheCreation,
      status.totalTokens,
      status.activeDays,
      '',
      '',
    ],
    ...Object.entries(status.workSecondsByDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, seconds]) => ['day', day, '', '', '', '', '', '', '', '', seconds, '']),
    ...status.projects.map((project) => [
      'project',
      project.displayName || path.basename(project.cwd) || project.cwd,
      project.sessions,
      project.messages,
      project.tokensIn,
      project.tokensOut,
      '',
      '',
      project.tokensTotal,
      '',
      '',
      project.cwd,
    ]),
    ...(status.localUsers ?? []).map((user) => [
      'local-user',
      user.identity.displayName,
      user.sessions,
      user.messages,
      user.tokensIn,
      user.tokensOut,
      user.cacheRead,
      user.cacheCreation,
      user.tokensTotal,
      '',
      '',
      user.projectName ?? user.teamName ?? '',
    ]),
    ...(status.teamCapabilitySnapshots ?? []).flatMap((snapshot) =>
      snapshot.assets.map((asset) => [
        `capability-${asset.kind}`,
        asset.name,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        asset.scope ?? '',
        snapshot.teamSlug ?? '',
        snapshot.teamName,
        snapshot.teamDisplayName ?? '',
        snapshot.projectName ?? '',
        snapshot.bindProject ?? '',
        asset.source ?? '',
        asset.kind,
        asset.description ?? '',
      ])
    ),
    [
      'unresolved-usage',
      '未映射会话',
      status.unresolvedUsage?.sessions ?? 0,
      status.unresolvedUsage?.messages ?? 0,
      '',
      '',
      '',
      '',
      status.unresolvedUsage?.tokensTotal ?? 0,
      '',
      '',
      '',
    ],
  ];

  return {
    filename: `hermit-loop-usage-${stamp}.csv`,
    mimeType: 'text/csv;charset=utf-8',
    content: rows.map((row) => row.map(csvCell).join(',')).join('\n'),
  };
}

export function createUsageTelemetryPresenter({
  listTeams,
  loadCapabilitySnapshots,
  getRuntimeStatus,
  warn,
  now = Date.now,
}: UsageTelemetryPresenterDependencies): UsageTelemetryPresenter {
  let capabilityReportCache: {
    expiresAt: number;
    promise?: Promise<TeamCapabilityTelemetrySnapshot[]>;
    value: TeamCapabilityTelemetrySnapshot[];
  } | null = null;

  const getCapabilityTelemetrySnapshots = async (): Promise<TeamCapabilityTelemetrySnapshot[]> => {
    const currentTime = now();
    if (capabilityReportCache?.value && capabilityReportCache.expiresAt > currentTime) {
      return capabilityReportCache.value;
    }
    if (capabilityReportCache?.promise) return capabilityReportCache.promise;

    const previousValue = capabilityReportCache?.value ?? [];
    const promise = (async () => {
      try {
        const snapshots = await loadCapabilitySnapshots();
        capabilityReportCache = {
          expiresAt: now() + CAPABILITY_REPORT_TTL_MS,
          value: snapshots,
        };
        return snapshots;
      } catch (error) {
        capabilityReportCache = previousValue.length
          ? { expiresAt: 0, value: previousValue }
          : null;
        throw error;
      }
    })();

    capabilityReportCache = { expiresAt: 0, promise, value: previousValue };
    return promise;
  };

  return {
    async enrich(status) {
      const teams = await listTeams().catch(() => []);
      const enriched = enrichTelemetryProjectNames(status, teams);
      const capabilities = await getCapabilityTelemetrySnapshots().catch((error) => {
        warn(error, 'capability telemetry snapshot build failed');
        return [] as TeamCapabilityTelemetrySnapshot[];
      });
      return {
        ...enriched,
        teamCapabilitySnapshots: capabilities,
        capabilitySummary: summarizeCapabilities(capabilities),
      };
    },
    emptyStatus: () => createTelemetryEmptyStatus(getRuntimeStatus()),
    workerSummary: summarizeTelemetryWorker,
    buildExport: (status, format) => buildUsageTelemetryExport(status, format),
    getRuntimeStatus,
  };
}
