import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerHeartbeatRoutes } from '../../../src/main/routes/heartbeatRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const resolveProjectName = vi.fn(async (teamName: string) => `project-${teamName}`);
  const heartbeat = { enabled: true, interval_mins: 30 };
  const bridgeClient = {
    getHeartbeat: vi.fn(async () => heartbeat),
    resumeHeartbeat: vi.fn(async () => undefined),
    pauseHeartbeat: vi.fn(async () => undefined),
    updateProject: vi.fn(async () => undefined),
  };
  registerHeartbeatRoutes(app, { bridgeClient, resolveProjectName });
  return { app, bridgeClient, heartbeat, resolveProjectName };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('heartbeat routes', () => {
  it('resolves the bound project for reads and updates', async () => {
    const harness = createHarness();

    const read = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/heartbeat',
    });
    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/heartbeat',
      payload: { interval_mins: 15, only_when_idle: true },
    });

    expect(read.json()).toEqual({ ok: true, data: harness.heartbeat });
    expect(updated.json()).toEqual({ ok: true, data: harness.heartbeat });
    expect(harness.resolveProjectName).toHaveBeenCalledWith('team-a');
    expect(harness.bridgeClient.updateProject).toHaveBeenCalledWith('project-team-a', {
      interval_mins: 15,
      only_when_idle: true,
    });
  });

  it('preserves enable/resume and disable/pause aliases', async () => {
    const harness = createHarness();

    for (const action of ['enable', 'resume']) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/teams/team-a/heartbeat/${action}`,
      });
      expect(response.json()).toEqual({ ok: true });
    }
    for (const action of ['disable', 'pause']) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/teams/team-a/heartbeat/${action}`,
      });
      expect(response.json()).toEqual({ ok: true });
    }

    expect(harness.bridgeClient.resumeHeartbeat).toHaveBeenCalledTimes(2);
    expect(harness.bridgeClient.pauseHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('preserves read and mutation error status codes', async () => {
    const harness = createHarness();
    harness.bridgeClient.getHeartbeat.mockRejectedValueOnce(new Error('not found'));
    harness.bridgeClient.resumeHeartbeat.mockRejectedValueOnce(new Error('offline'));

    const read = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/heartbeat',
    });
    const enable = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/heartbeat/enable',
    });

    expect(read.statusCode).toBe(404);
    expect(read.json()).toEqual({ ok: false, error: 'not found' });
    expect(enable.statusCode).toBe(500);
    expect(enable.json()).toEqual({ ok: false, error: 'offline' });
  });
});
