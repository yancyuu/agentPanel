import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTaskBusSettingsRoutes } from '../../../src/main/routes/taskBusSettingsRoutes';
import type { TeamManifest } from '../../../src/main/services/team-management/TeamWorkspaceService';

const apps: Array<ReturnType<typeof Fastify>> = [];
const tempDirs: string[] = [];

type Dependencies = Parameters<typeof registerTaskBusSettingsRoutes>[1];

async function createHarness(overrides: Partial<Dependencies> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentcli-task-bus-'));
  tempDirs.push(directory);
  const settingsFile = path.join(directory, 'settings.json');
  const app = Fastify({ logger: false });
  apps.push(app);

  const bridgeClient = {
    listProjects: vi.fn(async () => [
      {
        name: 'project-a',
        agent_type: 'claudecode' as const,
        platforms: ['bridge'],
        sessions_count: 0,
        heartbeat_enabled: false,
      },
    ]),
    getProject: vi.fn(
      async () =>
        ({ name: 'project-a', work_dir: '/bridge/project-a' }) as Awaited<
          ReturnType<Dependencies['bridgeClient']['getProject']>
        >
    ),
  } satisfies Dependencies['bridgeClient'];
  const teamProvisioning = {
    readTeamManifest: vi.fn(
      async () => ({ slug: 'team-a', workDir: '/manifest/team-a' }) as unknown as TeamManifest
    ),
    injectTeamInstructions: vi.fn(async () => undefined),
    removeTeamInstructions: vi.fn(async () => undefined),
  } satisfies Dependencies['teamProvisioning'];
  const dependencies: Dependencies = {
    settingsFile,
    bridgeClient,
    teamProvisioning,
    isExternalTelemetryWorkerRunning: vi.fn(async () => false),
    startTelemetry: vi.fn(async () => undefined),
    stopTelemetry: vi.fn(async () => undefined),
    ...overrides,
  };
  registerTaskBusSettingsRoutes(app, dependencies);
  return { app, settingsFile, dependencies, bridgeClient, teamProvisioning };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('task bus settings routes', () => {
  it('returns defaults for missing or malformed settings and reads an existing taskBus object', async () => {
    const missingHarness = await createHarness();
    const missing = await missingHarness.app.inject({
      method: 'GET',
      url: '/api/settings/task-bus',
    });

    const savedHarness = await createHarness();
    await writeFile(
      savedHarness.settingsFile,
      JSON.stringify({ taskBus: { enabled: true, telemetry: { enabled: true } } }),
      'utf8'
    );
    const saved = await savedHarness.app.inject({ method: 'GET', url: '/api/settings/task-bus' });

    const malformedHarness = await createHarness();
    await writeFile(malformedHarness.settingsFile, '{bad', 'utf8');
    const malformed = await malformedHarness.app.inject({
      method: 'GET',
      url: '/api/settings/task-bus',
    });

    expect(missing.json()).toEqual({
      enabled: false,
      telemetry: { enabled: false, platform: 'claudecode' },
    });
    expect(saved.json()).toEqual({ enabled: true, telemetry: { enabled: true } });
    expect(malformed.json()).toEqual(missing.json());
  });

  it('persists direct payloads, starts local telemetry, and injects team instructions', async () => {
    const harness = await createHarness();
    await writeFile(harness.settingsFile, JSON.stringify({ preserved: true }), 'utf8');

    const payload = {
      enabled: true,
      collaboration: true,
      telemetry: { enabled: true, platform: 'claudecode' },
    };
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings/task-bus',
      payload,
    });

    expect(response.json()).toEqual({ ok: true, connected: false, message: '设置已保存' });
    expect(JSON.parse(await readFile(harness.settingsFile, 'utf8'))).toEqual({
      preserved: true,
      taskBus: payload,
    });
    expect(harness.dependencies.startTelemetry).toHaveBeenCalledWith(payload);
    expect(harness.dependencies.stopTelemetry).not.toHaveBeenCalled();
    expect(harness.teamProvisioning.injectTeamInstructions).toHaveBeenCalledWith(
      '/manifest/team-a',
      'team-a'
    );
  });

  it('accepts wrapped payloads and stops duplicate Web telemetry when the worker is active', async () => {
    const isExternalTelemetryWorkerRunning = vi.fn(async () => true);
    const harness = await createHarness({ isExternalTelemetryWorkerRunning });
    const taskBus = {
      enabled: true,
      collaboration: false,
      telemetry: { enabled: true, platform: 'codex' },
    };

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings/task-bus',
      payload: { taskBus },
    });

    expect(response.statusCode).toBe(200);
    expect(harness.dependencies.stopTelemetry).toHaveBeenCalledOnce();
    expect(harness.dependencies.startTelemetry).not.toHaveBeenCalled();
    expect(harness.teamProvisioning.removeTeamInstructions).toHaveBeenCalledWith(
      '/manifest/team-a'
    );
  });

  it('falls back to bridge work directories and keeps instruction sync failures best-effort', async () => {
    const readTeamManifest = vi.fn(async () => {
      throw new Error('manifest missing');
    });
    const removeTeamInstructions = vi.fn(async () => {
      throw new Error('write failed');
    });
    const baseHarness = await createHarness();
    const harness = await createHarness({
      bridgeClient: baseHarness.bridgeClient,
      teamProvisioning: {
        ...baseHarness.teamProvisioning,
        readTeamManifest,
        removeTeamInstructions,
      },
    });

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings/task-bus',
      payload: { enabled: false, collaboration: false, telemetry: { enabled: false } },
    });

    expect(response.statusCode).toBe(200);
    expect(harness.dependencies.stopTelemetry).toHaveBeenCalledOnce();
    expect(baseHarness.bridgeClient.getProject).toHaveBeenCalledWith('project-a');
    expect(removeTeamInstructions).toHaveBeenCalledWith('/bridge/project-a');
  });
});
