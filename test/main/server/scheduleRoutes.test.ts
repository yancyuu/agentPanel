import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerScheduleRoutes } from '../../../src/main/routes/scheduleRoutes';
import { createServerRuntimeState } from '../../../src/main/serverContext';
import type {
  HermitBridgeCreateCronJobRequest,
  HermitBridgeCronJob,
} from '../../../src/shared/types/hermitBridge';
import type { TeamManifest } from '../../../src/main/services/team-management/TeamWorkspaceService';

const apps: Array<ReturnType<typeof Fastify>> = [];

type ScheduleDependencies = Parameters<typeof registerScheduleRoutes>[1];

const cronJob = (overrides: Partial<HermitBridgeCronJob> = {}): HermitBridgeCronJob => ({
  id: 'cron-123456',
  project: 'team-a',
  session_key: 'hermit:team-a:session',
  cron_expr: '0 9 * * *',
  prompt: 'Daily report',
  description: 'Morning report',
  enabled: true,
  timeout_mins: 50,
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function createHarness(overrides: Partial<ScheduleDependencies> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const state = createServerRuntimeState();
  const bridgeClient = {
    listCronJobs: vi.fn(async () => [cronJob()]),
    createCronJob: vi.fn(async (input: HermitBridgeCreateCronJobRequest) =>
      cronJob({
        id: 'created-cron',
        project: input.project,
        session_key: input.session_key,
        cron_expr: input.cron_expr,
        prompt: input.prompt,
        description: input.description,
        timeout_mins: input.timeout_mins,
      })
    ),
    updateCronJob: vi.fn(
      async (
        id: string,
        patch: Partial<HermitBridgeCreateCronJobRequest> & { enabled?: boolean }
      ) =>
        cronJob({
          id,
          description:
            typeof patch.description === 'string' ? patch.description : cronJob().description,
          cron_expr: typeof patch.cron_expr === 'string' ? patch.cron_expr : cronJob().cron_expr,
          prompt: typeof patch.prompt === 'string' ? patch.prompt : cronJob().prompt,
          enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cronJob().enabled,
        })
    ),
    deleteCronJob: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    getProject: vi.fn(
      async () =>
        ({ work_dir: '/project/team-a' }) as Awaited<
          ReturnType<ScheduleDependencies['bridgeClient']['getProject']>
        >
    ),
  } satisfies ScheduleDependencies['bridgeClient'];
  const dependencies: ScheduleDependencies = {
    state,
    bridgeClient,
    readTeamManifest: vi.fn(async () => ({ workDir: '/manifest/team-a' }) as TeamManifest),
    broadcastSse: vi.fn(),
    buildFallbackSessionKey: vi.fn((teamName: string) => `hermit:${teamName}:session`),
    reply500: vi.fn((error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    })),
    ...overrides,
  };
  registerScheduleRoutes(app, dependencies);
  return { app, state, dependencies, bridgeClient };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('schedule routes', () => {
  it('lists mapped cc-connect schedules and resolves manifest work directories', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({ method: 'GET', url: '/api/schedules' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: 'cron-123456',
        teamName: 'team-a',
        label: 'Morning report',
        cronExpression: '0 9 * * *',
        status: 'active',
        maxTurns: 50,
        launchConfig: { cwd: '/manifest/team-a', prompt: 'Daily report' },
      }),
    ]);
  });

  it('preserves list/get best-effort empty responses when the bridge fails or misses', async () => {
    const failed = createHarness({
      bridgeClient: {
        ...createHarness().bridgeClient,
        listCronJobs: vi.fn(async () => {
          throw new Error('offline');
        }),
      },
    });
    const missing = createHarness({
      bridgeClient: {
        ...createHarness().bridgeClient,
        listCronJobs: vi.fn(async () => []),
      },
    });

    const list = await failed.app.inject({ method: 'GET', url: '/api/schedules' });
    const get = await missing.app.inject({ method: 'GET', url: '/api/schedules/missing' });

    expect(list.json()).toEqual([]);
    expect(get.json()).toBeNull();
  });

  it('validates and creates schedules with the canonical bridge payload and SSE event', async () => {
    const harness = createHarness();
    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: { teamName: 'team-a' },
    });
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: {
        teamName: ' team-a ',
        cronExpression: ' 0 10 * * * ',
        label: ' Daily ',
        maxTurns: 2.9,
        launchConfig: { prompt: ' Run report ', cwd: '/work', session_key: ' custom-key ' },
      },
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      error: 'teamName、cronExpression、launchConfig.prompt 不能为空',
    });
    expect(harness.bridgeClient.createCronJob).toHaveBeenCalledWith({
      project: 'team-a',
      session_key: 'custom-key',
      cron_expr: '0 10 * * *',
      prompt: 'Run report',
      description: 'Daily',
      enabled: true,
      timeout_mins: 2,
    });
    expect(created.json()).toEqual(
      expect.objectContaining({
        id: 'created-cron',
        launchConfig: { cwd: '/work', prompt: 'Run report' },
      })
    );
    expect(harness.dependencies.broadcastSse).toHaveBeenCalledWith('schedule:change', {
      type: 'schedule-updated',
      scheduleId: 'created-cron',
      teamName: 'team-a',
      detail: 'created',
    });
  });

  it('patches known schedules and preserves the 404 contract for unknown IDs', async () => {
    const harness = createHarness();
    const missingHarness = createHarness({
      bridgeClient: {
        ...createHarness().bridgeClient,
        listCronJobs: vi.fn(async () => []),
      },
    });

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/schedules/cron-123456',
      payload: {
        label: ' Updated ',
        cronExpression: ' 0 11 * * * ',
        maxTurns: 4.8,
        launchConfig: { prompt: ' New prompt ' },
      },
    });
    const missing = await missingHarness.app.inject({
      method: 'PATCH',
      url: '/api/schedules/missing',
      payload: {},
    });

    expect(harness.bridgeClient.updateCronJob).toHaveBeenCalledWith('cron-123456', {
      description: 'Updated',
      cron_expr: '0 11 * * *',
      prompt: 'New prompt',
      timeout_mins: 4,
    });
    expect(updated.json()).toEqual(
      expect.objectContaining({ label: 'Updated', cronExpression: '0 11 * * *' })
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Schedule not found' });
  });

  it('normalizes legacy delete IDs, clears run state, and treats missing jobs idempotently', async () => {
    const harness = createHarness();
    harness.state.scheduleRunsById.set('cron-123456', [
      {
        id: 'run-1',
        scheduleId: 'cron-123456',
        teamName: 'team-a',
        status: 'running',
        scheduledFor: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:00.000Z',
        retryCount: 0,
      },
    ]);
    harness.state.scheduleRunLogsByKey.set('cron-123456:run-1', {
      stdout: 'out',
      stderr: '',
    });

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/schedules/SCH-cron-123',
    });

    expect(deleted.json()).toEqual({});
    expect(harness.bridgeClient.deleteCronJob).toHaveBeenCalledWith('cron-123456');
    expect(harness.state.scheduleRunsById.has('cron-123456')).toBe(false);
    expect(harness.state.scheduleRunLogsByKey.has('cron-123456:run-1')).toBe(false);
    expect(harness.dependencies.broadcastSse).toHaveBeenCalledWith('schedule:change', {
      type: 'schedule-updated',
      scheduleId: 'cron-123456',
      teamName: 'team-a',
      detail: 'deleted',
    });

    const missingHarness = createHarness({
      bridgeClient: {
        ...createHarness().bridgeClient,
        listCronJobs: vi.fn(async () => []),
      },
    });
    const missing = await missingHarness.app.inject({
      method: 'DELETE',
      url: '/api/schedules/schedule:gone',
    });
    expect(missing.json()).toEqual({});
    expect(missingHarness.bridgeClient.deleteCronJob).not.toHaveBeenCalled();
  });

  it('pauses, resumes, and emits the existing schedule-change projections', async () => {
    const harness = createHarness();

    const paused = await harness.app.inject({
      method: 'POST',
      url: '/api/schedules/cron-123456/pause',
    });
    const resumed = await harness.app.inject({
      method: 'POST',
      url: '/api/schedules/cron-123456/resume',
    });

    expect(paused.json()).toEqual({});
    expect(resumed.json()).toEqual({});
    expect(harness.bridgeClient.sendMessage).toHaveBeenCalledWith(
      'team-a',
      'hermit:team-a:session',
      '/stop'
    );
    expect(harness.bridgeClient.updateCronJob).toHaveBeenNthCalledWith(1, 'cron-123456', {
      enabled: false,
    });
    expect(harness.bridgeClient.updateCronJob).toHaveBeenNthCalledWith(2, 'cron-123456', {
      enabled: true,
    });
    expect(harness.dependencies.broadcastSse).toHaveBeenNthCalledWith(1, 'schedule:change', {
      type: 'schedule-paused',
      scheduleId: 'cron-123456',
      teamName: 'team-a',
      detail: 'paused',
    });
    expect(harness.dependencies.broadcastSse).toHaveBeenNthCalledWith(2, 'schedule:change', {
      type: 'schedule-updated',
      scheduleId: 'cron-123456',
      teamName: 'team-a',
      detail: 'resumed',
    });
  });

  it('records trigger runs and exposes in-memory logs without duplicating state', async () => {
    const harness = createHarness();

    const triggered = await harness.app.inject({
      method: 'POST',
      url: '/api/schedules/cron-123456/trigger',
    });
    const run = triggered.json();
    const runs = await harness.app.inject({
      method: 'GET',
      url: '/api/schedules/cron-123456/runs',
    });
    const logs = await harness.app.inject({
      method: 'GET',
      url: `/api/schedules/cron-123456/runs/${run.id}/logs`,
    });

    expect(run).toEqual(
      expect.objectContaining({
        scheduleId: 'cron-123456',
        teamName: 'team-a',
        status: 'running',
        retryCount: 0,
      })
    );
    expect(runs.json()).toEqual([run]);
    expect(logs.json()).toEqual({
      stdout: expect.stringMatching(/^Triggered at /),
      stderr: '',
    });
    expect(harness.state.scheduleRunsById.get('cron-123456')).toHaveLength(1);
    expect(harness.dependencies.broadcastSse).toHaveBeenCalledWith('schedule:change', {
      type: 'run-started',
      scheduleId: 'cron-123456',
      teamName: 'team-a',
      detail: 'running',
    });
  });

  it('projects cc-connect last_run only when no in-memory run exists', async () => {
    const harness = createHarness({
      bridgeClient: {
        ...createHarness().bridgeClient,
        listCronJobs: vi.fn(async () => [cronJob({ last_run: '2026-01-02T03:04:05.000Z' })]),
      },
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/schedules/cron-123456/runs',
    });

    expect(response.json()).toEqual([
      {
        id: 'last-cron-123456',
        scheduleId: 'cron-123456',
        teamName: 'team-a',
        status: 'completed',
        scheduledFor: '2026-01-02T03:04:05.000Z',
        startedAt: '2026-01-02T03:04:05.000Z',
        executionStartedAt: '2026-01-02T03:04:05.000Z',
        completedAt: '2026-01-02T03:04:05.000Z',
        durationMs: 0,
        exitCode: 0,
        retryCount: 0,
        summary: 'Last run from cc-connect',
      },
    ]);
  });
});
