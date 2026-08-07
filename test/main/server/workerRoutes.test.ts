import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SYSTEM_MANAGER_TEAM_NAME } from '../../../src/shared/types/team';
import type { DiscoverableTeam } from '../../../src/shared/types/team';
import type {
  HermitBridgeSessionDetail,
  HermitBridgeSessionListItem,
} from '../../../src/shared/types/hermitBridge';
import { registerWorkerRoutes } from '../../../src/main/routes/workerRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

const workerTeam = (overrides: Partial<DiscoverableTeam> = {}): DiscoverableTeam => ({
  slug: 'worker-a',
  displayName: 'Worker A',
  location: 'local',
  status: 'online',
  collaboration: true,
  harness: 'claudecode',
  workDir: '/tmp/worker-a',
  ...overrides,
});

const session = (
  overrides: Partial<HermitBridgeSessionListItem> = {}
): HermitBridgeSessionListItem => ({
  id: 'session-1',
  name: 'Existing Session',
  session_key: 'hermit:worker-a:session:existing',
  agent_session_id: 'agent-session-1',
  agent_type: 'claudecode',
  active: true,
  live: true,
  history_count: 2,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:01:00.000Z',
  last_message: null,
  platform: 'bridge',
  ...overrides,
});

function createHarness(overrides: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const dependencies = {
    discoverTeams: vi.fn(async () => [workerTeam()]),
    resolveTeamSlugForMention: vi.fn(async (name: string) => name),
    ensureLoopSessionProjectReady: vi.fn(async () => ({ bindProject: 'project-a' })),
    listSessions: vi.fn(async () => [] as HermitBridgeSessionListItem[]),
    createSession: vi.fn(async () => ({
      ...session({
        id: 'created-1',
        name: 'Created Session',
        session_key: 'created-session-key',
        agent_session_id: 'created-agent-session',
      }),
      history: [],
    })) as unknown as () => Promise<HermitBridgeSessionDetail>,
    sendHarnessMessageViaBridge: vi.fn(async () => 'created-session-key'),
    appendMessage: vi.fn(async () => ({})),
    broadcastSse: vi.fn(),
    buildFallbackSessionKey: vi.fn((teamName: string) => `hermit:${teamName}:session`),
    ...overrides,
  };
  registerWorkerRoutes(app, dependencies);
  return { app, dependencies };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('worker routes', () => {
  it('lists only local non-system workers sorted by display name', async () => {
    const harness = createHarness({
      discoverTeams: vi.fn(async () => [
        workerTeam({ slug: 'worker-z', displayName: 'Zulu' }),
        workerTeam({ slug: 'remote', displayName: 'Remote', location: 'remote' }),
        workerTeam({ slug: SYSTEM_MANAGER_TEAM_NAME, displayName: 'System Manager' }),
        workerTeam({ slug: 'worker-a', displayName: 'Alpha' }),
      ]),
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/workers' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workers: [
        expect.objectContaining({ workerId: 'worker-a', name: 'Alpha', kind: 'composite' }),
        expect.objectContaining({ workerId: 'worker-z', name: 'Zulu', kind: 'composite' }),
      ],
    });
  });

  it('preserves unknown-worker and missing-text validation responses', async () => {
    const unknownHarness = createHarness({
      resolveTeamSlugForMention: vi.fn(async () => null),
    });
    const unknown = await unknownHarness.app.inject({
      method: 'POST',
      url: '/api/workers/missing/invoke',
      payload: { text: 'hello' },
    });

    const missingTextHarness = createHarness();
    const missingText = await missingTextHarness.app.inject({
      method: 'POST',
      url: '/api/workers/worker-a/invoke',
      payload: { text: '   ' },
    });

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'Unknown worker: missing' });
    expect(missingText.statusCode).toBe(400);
    expect(missingText.json()).toEqual({ error: 'text is required' });
  });

  it('reuses an active named session and records the cross-team invocation', async () => {
    const existing = session();
    const harness = createHarness({
      listSessions: vi.fn(async () => [existing]),
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/workers/worker-a/invoke',
      payload: {
        fromTeam: 'source-team',
        text: '  investigate  ',
        summary: 'Summary',
        sessionName: 'Existing Session',
        sessionKey: 'source-session',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      worker: expect.objectContaining({ workerId: 'worker-a', name: 'Worker A' }),
      session: expect.objectContaining({
        id: 'agent-session-1',
        title: 'Existing Session',
        projectId: 'worker-a',
        sessionKey: existing.session_key,
      }),
      reused: true,
      messageSent: true,
    });
    expect(harness.dependencies.createSession).not.toHaveBeenCalled();
    expect(harness.dependencies.sendHarnessMessageViaBridge).toHaveBeenCalledWith({
      teamName: 'worker-a',
      text: 'investigate',
      sessionKey: existing.session_key,
    });
    expect(harness.dependencies.appendMessage).toHaveBeenCalledWith('source-team', {
      from: 'source-team.user',
      to: 'worker-a',
      role: 'user',
      content: '@worker-a investigate',
      meta: {
        source: 'cross_team_sent',
        sessionKey: 'source-session',
        summary: 'Summary',
      },
    });
    expect(harness.dependencies.broadcastSse).toHaveBeenNthCalledWith(1, 'team-change', {
      type: 'inbox',
      teamName: 'source-team',
    });
    expect(harness.dependencies.broadcastSse).toHaveBeenNthCalledWith(2, 'team-change', {
      type: 'inbox',
      teamName: 'worker-a',
    });
  });

  it('creates a fresh session when reuse is disabled and maps failures to HTTP 500', async () => {
    const harness = createHarness();
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/workers/worker-a/invoke',
      payload: { text: 'run', summary: 'Fresh', reuse: false },
    });

    expect(created.statusCode).toBe(200);
    expect(harness.dependencies.listSessions).not.toHaveBeenCalled();
    expect(harness.dependencies.createSession).toHaveBeenCalledWith(
      'project-a',
      'Fresh',
      expect.stringMatching(/^hermit:worker-a:session:/)
    );
    expect(created.json()).toEqual(
      expect.objectContaining({
        reused: false,
        messageSent: true,
        session: expect.objectContaining({ sessionKey: 'created-session-key' }),
      })
    );

    const failedHarness = createHarness({
      ensureLoopSessionProjectReady: vi.fn(async () => {
        throw new Error('runtime unavailable');
      }),
    });
    const failed = await failedHarness.app.inject({
      method: 'POST',
      url: '/api/workers/worker-a/invoke',
      payload: { text: 'run' },
    });

    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: 'runtime unavailable' });
  });
});
