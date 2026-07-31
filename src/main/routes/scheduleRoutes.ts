import { Cron } from 'croner';

import type { InMemoryScheduleRun, ServerRuntimeState } from '../serverContext';
import type { HermitBridgeClient } from '../services/hermitBridge/HermitBridgeClient';
import type { TeamManifest } from '../services/team-management/TeamWorkspaceService';
import type { FastifyInstance } from 'fastify';

const CRON_ZERO_TIME_PREFIX = '0001-01-01T00:00:00';
const DEFAULT_SCHEDULE_TIMEZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
const DEFAULT_SCHEDULE_WARMUP_MINUTES = 15;
const DEFAULT_SCHEDULE_MAX_TURNS = 50;
const DEFAULT_SCHEDULE_MAX_CONSECUTIVE_FAILURES = 3;

type ScheduleBridgeClient = Pick<
  HermitBridgeClient,
  | 'listCronJobs'
  | 'createCronJob'
  | 'updateCronJob'
  | 'deleteCronJob'
  | 'sendMessage'
  | 'getProject'
>;

interface ScheduleRouteDependencies {
  state: ServerRuntimeState;
  bridgeClient: ScheduleBridgeClient;
  readTeamManifest(teamName: string): Promise<TeamManifest>;
  broadcastSse(event: string, data: unknown): void;
  buildFallbackSessionKey(teamName: string): string;
  reply500(error: unknown): { ok: boolean; error: string };
}

function makeScheduleRunLogKey(scheduleId: string, runId: string): string {
  return `${scheduleId}:${runId}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeCronLastRun(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.startsWith(CRON_ZERO_TIME_PREFIX)) return undefined;
  return value;
}

function mapCronJobToSchedule(
  cronJob: {
    id: string;
    project: string;
    cron_expr: string;
    prompt: string;
    description?: string;
    enabled: boolean;
    created_at: string;
    last_run?: string;
  },
  cwd: string
): {
  id: string;
  teamName: string;
  label?: string;
  cronExpression: string;
  timezone: string;
  status: 'active' | 'paused' | 'disabled';
  warmUpMinutes: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  maxTurns: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  launchConfig: { cwd: string; prompt: string };
} {
  const lastRunAt = normalizeCronLastRun(cronJob.last_run);
  const status: 'active' | 'paused' = cronJob.enabled ? 'active' : 'paused';

  let nextRunAt: string | undefined;
  if (cronJob.enabled && isNonEmptyString(cronJob.cron_expr)) {
    try {
      const job = new Cron(cronJob.cron_expr.trim(), {
        timezone: DEFAULT_SCHEDULE_TIMEZONE,
        paused: true,
      });
      const next = job.nextRun();
      if (next) {
        nextRunAt = (next instanceof Date ? next : new Date(next)).toISOString();
      }
    } catch {
      // Invalid cron expression — leave nextRunAt undefined.
    }
  }

  return {
    id: cronJob.id,
    teamName: cronJob.project,
    label: isNonEmptyString(cronJob.description) ? cronJob.description.trim() : undefined,
    cronExpression: cronJob.cron_expr,
    timezone: DEFAULT_SCHEDULE_TIMEZONE,
    status,
    warmUpMinutes: DEFAULT_SCHEDULE_WARMUP_MINUTES,
    maxConsecutiveFailures: DEFAULT_SCHEDULE_MAX_CONSECUTIVE_FAILURES,
    consecutiveFailures: 0,
    maxTurns: DEFAULT_SCHEDULE_MAX_TURNS,
    createdAt: cronJob.created_at,
    updatedAt: lastRunAt ?? cronJob.created_at,
    lastRunAt,
    nextRunAt,
    launchConfig: {
      cwd,
      prompt: cronJob.prompt,
    },
  };
}

function normalizeScheduleRouteId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith('schedule:')) {
    return trimmed.slice('schedule:'.length);
  }
  if (trimmed.startsWith('SCH-')) {
    return trimmed.slice('SCH-'.length);
  }
  return trimmed;
}

function findCronJobByRouteId<T extends { id: string }>(jobs: T[], id: string): T | undefined {
  const normalized = normalizeScheduleRouteId(id);
  const exact = jobs.find((job) => job.id === normalized || job.id === id);
  if (exact) return exact;

  const prefixMatches = jobs.filter((job) => job.id.startsWith(normalized));
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

function isCronNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(\b404\b|not found|no matching|does not exist|不存在)/i.test(message);
}

export function registerScheduleRoutes(
  app: FastifyInstance,
  {
    state,
    bridgeClient: cc,
    readTeamManifest,
    broadcastSse,
    buildFallbackSessionKey,
    reply500,
  }: ScheduleRouteDependencies
): void {
  const { scheduleRunsById, scheduleRunLogsByKey } = state;

  const resolveTeamWorkDirs = async (teamNames: string[]): Promise<Map<string, string>> => {
    const uniqueTeamNames = [...new Set(teamNames.filter((name) => name.trim().length > 0))];
    const results = new Map<string, string>();

    await Promise.all(
      uniqueTeamNames.map(async (teamName) => {
        let cwd = '';
        try {
          const meta = await readTeamManifest(teamName);
          if (typeof meta.workDir === 'string') {
            cwd = meta.workDir.trim();
          }
        } catch {
          // ignore
        }

        if (!cwd) {
          try {
            const detail = await cc.getProject(teamName);
            if (typeof detail.work_dir === 'string') {
              cwd = detail.work_dir.trim();
            }
          } catch {
            // ignore
          }
        }

        results.set(teamName, cwd);
      })
    );

    return results;
  };

  const clearScheduleRuntimeState = (scheduleId: string): void => {
    scheduleRunsById.delete(scheduleId);
    for (const key of [...scheduleRunLogsByKey.keys()]) {
      if (key.startsWith(`${scheduleId}:`)) {
        scheduleRunLogsByKey.delete(key);
      }
    }
  };

  app.get('/api/schedules', async () => {
    try {
      const jobs = await cc.listCronJobs();
      if (jobs.length === 0) return [];
      const workDirMap = await resolveTeamWorkDirs(jobs.map((job) => job.project));
      return jobs.map((job) => mapCronJobToSchedule(job, workDirMap.get(job.project) ?? ''));
    } catch (error) {
      app.log.warn({ err: error }, 'list schedules from cc-connect failed');
      return [];
    }
  });

  app.get<{ Params: { id: string } }>('/api/schedules/:id', async (request) => {
    try {
      const jobs = await cc.listCronJobs();
      const job = jobs.find((item) => item.id === request.params.id);
      if (!job) return null;
      const workDirMap = await resolveTeamWorkDirs([job.project]);
      return mapCronJobToSchedule(job, workDirMap.get(job.project) ?? '');
    } catch (error) {
      app.log.warn(
        { err: error, scheduleId: request.params.id },
        'get schedule from cc-connect failed'
      );
      return null;
    }
  });

  app.post<{ Body: Record<string, unknown> }>('/api/schedules', async (request, reply) => {
    try {
      const body = request.body ?? {};
      const teamName = typeof body.teamName === 'string' ? body.teamName.trim() : '';
      const cronExpression =
        typeof body.cronExpression === 'string' ? body.cronExpression.trim() : '';
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      const maxTurns =
        typeof body.maxTurns === 'number' && Number.isFinite(body.maxTurns)
          ? Math.max(1, Math.floor(body.maxTurns))
          : DEFAULT_SCHEDULE_MAX_TURNS;

      const launchConfig =
        body.launchConfig &&
        typeof body.launchConfig === 'object' &&
        !Array.isArray(body.launchConfig)
          ? (body.launchConfig as Record<string, unknown>)
          : {};
      const prompt = typeof launchConfig.prompt === 'string' ? launchConfig.prompt.trim() : '';
      const cwd = typeof launchConfig.cwd === 'string' ? launchConfig.cwd.trim() : '';
      const sessionKey =
        typeof launchConfig.session_key === 'string' && launchConfig.session_key.trim().length > 0
          ? launchConfig.session_key.trim()
          : buildFallbackSessionKey(teamName);

      if (!teamName || !cronExpression || !prompt) {
        return reply
          .code(400)
          .send({ error: 'teamName、cronExpression、launchConfig.prompt 不能为空' });
      }
      const created = await cc.createCronJob({
        project: teamName,
        session_key: sessionKey,
        cron_expr: cronExpression,
        prompt,
        description: label || undefined,
        enabled: true,
        timeout_mins: maxTurns,
      });

      const schedule = mapCronJobToSchedule(created, cwd);
      broadcastSse('schedule:change', {
        type: 'schedule-updated',
        scheduleId: schedule.id,
        teamName: schedule.teamName,
        detail: 'created',
      });
      return schedule;
    } catch (error) {
      return reply500(error);
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/schedules/:id',
    async (request, reply) => {
      try {
        const jobs = await cc.listCronJobs();
        const existing = jobs.find((item) => item.id === request.params.id);
        if (!existing) {
          return reply.code(404).send({ error: 'Schedule not found' });
        }

        const patchBody = request.body ?? {};
        const patch: Record<string, unknown> = {};
        if (typeof patchBody.label === 'string') {
          patch.description = patchBody.label.trim();
        }
        if (typeof patchBody.cronExpression === 'string') {
          patch.cron_expr = patchBody.cronExpression.trim();
        }
        const launchConfig =
          patchBody.launchConfig &&
          typeof patchBody.launchConfig === 'object' &&
          !Array.isArray(patchBody.launchConfig)
            ? (patchBody.launchConfig as Record<string, unknown>)
            : null;
        if (launchConfig && typeof launchConfig.prompt === 'string') {
          patch.prompt = launchConfig.prompt.trim();
        }
        if (typeof patchBody.maxTurns === 'number' && Number.isFinite(patchBody.maxTurns)) {
          patch.timeout_mins = Math.max(1, Math.floor(patchBody.maxTurns));
        }

        const updated = Object.keys(patch).length
          ? await cc.updateCronJob(request.params.id, patch)
          : existing;

        const workDirMap = await resolveTeamWorkDirs([updated.project]);
        const schedule = mapCronJobToSchedule(updated, workDirMap.get(updated.project) ?? '');
        broadcastSse('schedule:change', {
          type: 'schedule-updated',
          scheduleId: schedule.id,
          teamName: schedule.teamName,
          detail: 'updated',
        });
        return schedule;
      } catch (error) {
        return reply500(error);
      }
    }
  );

  app.delete<{ Params: { id: string } }>('/api/schedules/:id', async (request, reply) => {
    const requestedId = request.params.id;
    const normalizedId = normalizeScheduleRouteId(requestedId);
    let resolvedId = normalizedId;
    let resolvedTeamName = '';

    try {
      let jobs: Awaited<ReturnType<typeof cc.listCronJobs>> = [];
      let listedJobs = false;
      try {
        jobs = await cc.listCronJobs();
        listedJobs = true;
      } catch (listError) {
        request.log.warn(
          { err: listError, scheduleId: requestedId },
          'list cron jobs before delete failed'
        );
      }
      const target = findCronJobByRouteId(jobs, requestedId);
      if (target) {
        resolvedId = target.id;
        resolvedTeamName =
          'project' in target && typeof target.project === 'string' ? target.project : '';
      } else if (
        listedJobs &&
        !jobs.some((job) => job.id === normalizedId || job.id.startsWith(normalizedId))
      ) {
        clearScheduleRuntimeState(normalizedId);
        broadcastSse('schedule:change', {
          type: 'schedule-updated',
          scheduleId: normalizedId,
          teamName: '',
          detail: 'deleted',
        });
        return {};
      }

      await cc.deleteCronJob(resolvedId);
      clearScheduleRuntimeState(resolvedId);
      broadcastSse('schedule:change', {
        type: 'schedule-updated',
        scheduleId: resolvedId,
        teamName: resolvedTeamName,
        detail: 'deleted',
      });
      return {};
    } catch (error) {
      if (isCronNotFoundError(error)) {
        clearScheduleRuntimeState(resolvedId);
        clearScheduleRuntimeState(normalizedId);
        broadcastSse('schedule:change', {
          type: 'schedule-updated',
          scheduleId: resolvedId,
          teamName: resolvedTeamName,
          detail: 'deleted',
        });
        return {};
      }
      try {
        const jobs = await cc.listCronJobs();
        const stillExists = Boolean(findCronJobByRouteId(jobs, requestedId));
        if (!stillExists) {
          clearScheduleRuntimeState(resolvedId);
          broadcastSse('schedule:change', {
            type: 'schedule-updated',
            scheduleId: resolvedId,
            teamName: resolvedTeamName,
            detail: 'deleted',
          });
          return {};
        }
      } catch (verifyError) {
        request.log.warn(
          { err: verifyError, scheduleId: requestedId },
          'verify cron delete failed'
        );
      }
      return reply.code(500).send(reply500(error));
    }
  });

  app.post<{ Params: { id: string } }>('/api/schedules/:id/pause', async (request) => {
    try {
      const jobs = await cc.listCronJobs();
      const current = jobs.find((item) => item.id === request.params.id);
      if (current) {
        try {
          await cc.sendMessage(
            current.project,
            current.session_key || buildFallbackSessionKey(current.project),
            '/stop'
          );
        } catch (error) {
          request.log.warn(
            { err: error, scheduleId: request.params.id },
            'send /stop for cron failed'
          );
        }
      }
      const updated = await cc.updateCronJob(request.params.id, { enabled: false });
      broadcastSse('schedule:change', {
        type: 'schedule-paused',
        scheduleId: request.params.id,
        teamName: updated.project,
        detail: 'paused',
      });
      return {};
    } catch (error) {
      return reply500(error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/schedules/:id/resume', async (request) => {
    try {
      const updated = await cc.updateCronJob(request.params.id, { enabled: true });
      broadcastSse('schedule:change', {
        type: 'schedule-updated',
        scheduleId: request.params.id,
        teamName: updated.project,
        detail: 'resumed',
      });
      return {};
    } catch (error) {
      return reply500(error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/schedules/:id/trigger', async (request, reply) => {
    try {
      const jobs = await cc.listCronJobs();
      const job = jobs.find((item) => item.id === request.params.id);
      if (!job) {
        return reply.code(404).send({ error: 'Schedule not found' });
      }
      const nowIso = new Date().toISOString();
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let run: InMemoryScheduleRun;

      try {
        await cc.sendMessage(
          job.project,
          job.session_key || buildFallbackSessionKey(job.project),
          job.prompt
        );
        run = {
          id: runId,
          scheduleId: job.id,
          teamName: job.project,
          status: 'running',
          scheduledFor: nowIso,
          startedAt: nowIso,
          executionStartedAt: nowIso,
          retryCount: 0,
          summary: 'Triggered via AgentCLI; waiting for Agent runtime',
        };
        scheduleRunLogsByKey.set(makeScheduleRunLogKey(job.id, runId), {
          stdout: `Triggered at ${nowIso}`,
          stderr: '',
        });
      } catch (error) {
        run = {
          id: runId,
          scheduleId: job.id,
          teamName: job.project,
          status: 'failed',
          scheduledFor: nowIso,
          startedAt: nowIso,
          executionStartedAt: nowIso,
          completedAt: nowIso,
          durationMs: 0,
          exitCode: 1,
          retryCount: 0,
          error: error instanceof Error ? error.message : String(error),
          summary: 'Trigger failed',
        };
        scheduleRunLogsByKey.set(makeScheduleRunLogKey(job.id, runId), {
          stdout: '',
          stderr: run.error ?? 'Trigger failed',
        });
      }

      const previousRuns = scheduleRunsById.get(job.id) ?? [];
      scheduleRunsById.set(job.id, [run, ...previousRuns].slice(0, 100));
      broadcastSse('schedule:change', {
        type: run.status === 'failed' ? 'run-failed' : 'run-started',
        scheduleId: job.id,
        teamName: job.project,
        detail: run.status,
      });
      return run;
    } catch (error) {
      return reply500(error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/schedules/:id/runs', async (request) => {
    const scheduleId = request.params.id;
    const runs = scheduleRunsById.get(scheduleId) ?? [];
    if (runs.length > 0) {
      return runs;
    }

    try {
      const jobs = await cc.listCronJobs();
      const job = jobs.find((item) => item.id === scheduleId);
      const lastRunAt = normalizeCronLastRun(job?.last_run);
      if (!job || !lastRunAt) return [];
      return [
        {
          id: `last-${scheduleId}`,
          scheduleId,
          teamName: job.project,
          status: 'completed',
          scheduledFor: lastRunAt,
          startedAt: lastRunAt,
          executionStartedAt: lastRunAt,
          completedAt: lastRunAt,
          durationMs: 0,
          exitCode: 0,
          retryCount: 0,
          summary: 'Last run from cc-connect',
        },
      ];
    } catch {
      return [];
    }
  });

  app.get<{ Params: { id: string; runId: string } }>(
    '/api/schedules/:id/runs/:runId/logs',
    async (request) => {
      return (
        scheduleRunLogsByKey.get(
          makeScheduleRunLogKey(request.params.id, request.params.runId)
        ) ?? {
          stdout: '',
          stderr: '',
        }
      );
    }
  );
}
