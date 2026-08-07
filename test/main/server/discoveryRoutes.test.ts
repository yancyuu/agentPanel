import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGraphRoutes } from '../../../src/main/routes/graphRoutes';
import { registerHarnessRoutes } from '../../../src/main/routes/harnessRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const projects = [
    { name: 'team-a', agent_type: 'claudecode' },
    { name: 'team-b', agent_type: 'codex' },
  ];
  const listProjects = vi.fn(async () => projects);
  const readTasks = vi.fn(async (teamName: string) =>
    teamName === 'team-a'
      ? [
          { id: 'task-1', title: 'Active', assignee: 'member-a', status: 'doing' },
          { id: 'task-2', title: 'Done', assignee: 'member-b', status: 'done' },
        ]
      : []
  );
  registerHarnessRoutes(app, {
    agentTypes: ['claudecode', 'codex', 'pi'],
    listProjects,
  });
  registerGraphRoutes(app, { listProjects, readTasks });
  return { app, listProjects, projects, readTasks };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('harness and graph discovery routes', () => {
  it('marks harness types used by existing projects', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({ method: 'GET', url: '/api/harnesses' });

    expect(response.json()).toEqual([
      { type: 'claudecode', inUse: true },
      { type: 'codex', inUse: true },
      { type: 'pi', inUse: false },
    ]);
  });

  it('reports packaged desktop runtime availability and bundled Pi', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerHarnessRoutes(app, {
      agentTypes: ['claudecode', 'codex', 'pi'],
      listProjects: () => Promise.resolve([]),
      packagedDesktop: true,
      isCommandAvailable: (command) => Promise.resolve(command === 'pi'),
    });

    const response = await app.inject({ method: 'GET', url: '/api/harnesses' });

    expect(response.json()).toEqual([
      {
        type: 'claudecode',
        inUse: false,
        available: false,
        bundled: false,
        desktopManaged: true,
      },
      {
        type: 'codex',
        inUse: false,
        available: false,
        bundled: false,
        desktopManaged: true,
      },
      { type: 'pi', inUse: false, available: true, bundled: true, desktopManaged: true },
    ]);
  });

  it('builds graph nodes and active assignment edges', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({ method: 'GET', url: '/api/graph' });

    expect(response.json()).toEqual({
      ok: true,
      data: {
        nodes: [
          {
            id: 'team-a',
            label: 'team-a',
            harness: 'claudecode',
            color: 'blue',
            collaboration: true,
            bindProject: 'team-a',
          },
          {
            id: 'team-b',
            label: 'team-b',
            harness: 'codex',
            color: 'blue',
            collaboration: true,
            bindProject: 'team-b',
          },
        ],
        edges: [
          {
            source: 'team-a',
            target: 'member-a',
            taskId: 'task-1',
            taskTitle: 'Active',
          },
        ],
      },
    });
  });

  it('preserves harness fallback and graph error envelopes', async () => {
    const harness = createHarness();
    harness.listProjects.mockRejectedValue(new Error('offline'));

    const harnesses = await harness.app.inject({ method: 'GET', url: '/api/harnesses' });
    const graph = await harness.app.inject({ method: 'GET', url: '/api/graph' });

    expect(harnesses.json()).toEqual([
      { type: 'claudecode', inUse: false },
      { type: 'codex', inUse: false },
      { type: 'pi', inUse: false },
    ]);
    expect(graph.json()).toEqual({ ok: false, error: 'offline' });
  });
});
