import type { LocalSessionSummary } from '../services/session-intelligence/LocalSessionScanner';
import type { TeamManifest } from '../services/team-management/TeamWorkspaceService';
import type { FastifyInstance } from 'fastify';

interface TeamMemberStatsRouteDependencies {
  readTeamManifest(teamName: string): Promise<TeamManifest>;
  scanSummaries(workDir: string, projectId: string): Promise<LocalSessionSummary[]>;
  readTasksForStats(teamName: string): Promise<{ status: string }[]>;
  now?: () => Date;
}

interface MemberStatsResponse {
  linesAdded: number;
  linesRemoved: number;
  filesTouched: string[];
  fileStats: Record<string, never>;
  toolUsage: Record<string, never>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  tasksCompleted: number;
  messageCount: number;
  totalDurationMs: number;
  sessionCount: number;
  computedAt: string;
}

function emptyMemberStats(computedAt: string): MemberStatsResponse {
  return {
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
    computedAt,
  };
}

export function registerTeamCompatibilityRoutes(app: FastifyInstance): void {
  app.get<{ Params: { name: string } }>('/api/teams/:name/saved-request', async () => null);

  app.get<{ Params: { name: string } }>('/api/teams/:name/kanban', async (request) => ({
    teamName: request.params.name,
    reviewers: [],
    tasks: {},
  }));

  app.get<{ Params: { name: string } }>('/api/teams/:name/task-change-presence', async () => ({}));

  app.post<{ Params: { name: string } }>('/api/teams/:name/kanban-column-order', async () => ({
    ok: true,
  }));
}

export function registerTeamMemberCompatibilityRoutes(app: FastifyInstance): void {
  app.post<{ Params: { name: string } }>('/api/teams/:name/members', async () => ({ ok: true }));
  app.delete<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/members/:memberName',
    async () => ({ ok: true })
  );
  app.patch<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/members/:memberName/role',
    async () => ({ ok: true })
  );
  app.post<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/members/:memberName/restart',
    async () => ({ ok: true })
  );
  app.post<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/members/:memberName/skip-launch',
    async () => ({ ok: true })
  );

  app.get<{ Params: { name: string } }>('/api/teams/:name/claude-logs', async () => ({
    logs: [],
    total: 0,
  }));
}

export function registerTeamProvisioningCompatibilityRoutes(app: FastifyInstance): void {
  app.post('/api/teams/provisioning/prepare', async () => ({
    runId: null,
    warnings: [],
  }));
  app.get<{ Params: { runId: string } }>('/api/teams/provisioning/:runId', async () => ({
    runId: '',
    phase: 'done',
    progress: 100,
    message: '',
    done: true,
    error: null,
  }));
  app.post<{ Params: { runId: string } }>('/api/teams/provisioning/:runId/cancel', async () => ({
    ok: true,
  }));

  app.get('/api/teams/templates', async () => ({ sources: [], templates: [] }));
  app.post('/api/teams/templates/save', async () => ({ sources: [], templates: [] }));
  app.post('/api/teams/templates/refresh', async () => ({ sources: [], templates: [] }));

  app.put<{ Params: { name: string } }>('/api/teams/:name/members', async () => ({ ok: true }));
  app.delete<{ Params: { name: string } }>('/api/teams/:name/draft', async () => ({ ok: true }));
}

export function registerTeamKanbanCompatibilityRoutes(app: FastifyInstance): void {
  app.patch<{ Params: { name: string; id: string }; Body: Record<string, unknown> }>(
    '/api/teams/:name/kanban/:id',
    async () => ({ ok: true })
  );

  app.put<{ Params: { name: string } }>('/api/teams/:name/kanban/column-order', async () => ({
    ok: true,
  }));
}

export function registerTeamActionCompatibilityRoutes(app: FastifyInstance): void {
  app.post<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/members/:memberName/skip',
    async () => ({ ok: true })
  );

  app.post<{ Params: { name: string; taskId: string } }>(
    '/api/teams/:name/task-clarification/:taskId',
    async () => ({ ok: true })
  );

  app.delete<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id/relationships',
    async () => ({ ok: true })
  );

  app.post('/api/teams/config', async () => ({ ok: true }));

  app.post<{ Params: { name: string }; Body: { pid?: number } }>(
    '/api/teams/:name/kill-process',
    async () => ({ ok: true })
  );

  app.get<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/member-logs/:memberName',
    async () => []
  );

  app.get<{ Params: { name: string; taskId: string } }>(
    '/api/teams/:name/task-logs/:taskId',
    async () => []
  );

  app.get<{ Params: { name: string } }>('/api/teams/:name/activity', async () => []);

  app.get<{ Params: { name: string } }>('/api/teams/:name/task-activity-detail', async () => ({
    entries: [],
  }));

  app.get<{ Params: { name: string; taskId: string } }>(
    '/api/teams/:name/task-log-stream-summary/:taskId',
    async () => ({ chunks: [] })
  );

  app.get<{ Params: { name: string; taskId: string } }>(
    '/api/teams/:name/task-log-stream/:taskId',
    async () => ({ chunks: [] })
  );

  app.get<{ Params: { name: string; taskId: string } }>(
    '/api/teams/:name/exact-log-summaries/:taskId',
    async () => ({ logs: [] })
  );

  app.get<{ Params: { name: string; taskId: string } }>(
    '/api/teams/:name/exact-log-detail/:taskId',
    async () => ({ lines: [] })
  );
}

export function registerTeamMemberStatsRoutes(
  app: FastifyInstance,
  dependencies: TeamMemberStatsRouteDependencies
): void {
  const now = dependencies.now ?? (() => new Date());

  app.get<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/member-stats/:memberName',
    async (request) => {
      try {
        const team = await dependencies.readTeamManifest(request.params.name);
        const workDir = team.workDir || team.bindProject || request.params.name;
        const sessions = await dependencies.scanSummaries(workDir, request.params.name);

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;
        let totalTokens = 0;
        let messageCount = 0;
        let totalDurationMs = 0;
        let earliestStart: string | null = null;
        let latestEnd: string | null = null;

        for (const session of sessions) {
          inputTokens += session.inputTokens;
          outputTokens += session.outputTokens;
          cacheReadTokens += session.cacheReadTokens;
          cacheCreationTokens += session.cacheCreationTokens;
          totalTokens += session.totalTokens;
          messageCount += session.messageCount;

          if (session.startTime && (!earliestStart || session.startTime < earliestStart)) {
            earliestStart = session.startTime;
          }
          if (session.endTime && (!latestEnd || session.endTime > latestEnd)) {
            latestEnd = session.endTime;
          }
        }

        if (earliestStart && latestEnd) {
          totalDurationMs = Date.parse(latestEnd) - Date.parse(earliestStart);
          if (totalDurationMs < 0) totalDurationMs = 0;
        }

        let tasksCompleted = 0;
        try {
          const tasks = await dependencies.readTasksForStats(team.slug || request.params.name);
          tasksCompleted = tasks.filter((task) => task.status === 'done').length;
        } catch {
          // The task board may not exist yet.
        }

        return {
          linesAdded: 0,
          linesRemoved: 0,
          filesTouched: [],
          fileStats: {},
          toolUsage: {},
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          totalTokens,
          costUsd: 0,
          tasksCompleted,
          messageCount,
          totalDurationMs,
          sessionCount: sessions.length,
          computedAt: now().toISOString(),
        };
      } catch {
        return emptyMemberStats(now().toISOString());
      }
    }
  );
}
