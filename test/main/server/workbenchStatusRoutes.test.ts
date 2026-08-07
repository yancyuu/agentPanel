import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerWorkbenchStatusRoutes } from '../../../src/main/routes/workbenchStatusRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createApp() {
  const app = Fastify({ logger: false });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('workbench status routes', () => {
  it('delegates recent projects and preserves empty compatibility projections', async () => {
    const app = createApp();
    const loadRecentProjects = vi.fn(async () => [{ path: '/code/agentpanel', name: 'agentpanel' }]);
    registerWorkbenchStatusRoutes(app, { loadRecentProjects });

    const recent = await app.inject({ method: 'GET', url: '/api/dashboard/recent-projects' });
    const projects = await app.inject({ method: 'GET', url: '/api/projects' });
    const groups = await app.inject({ method: 'GET', url: '/api/repository-groups' });
    const contexts = await app.inject({ method: 'GET', url: '/api/contexts' });
    const activeContext = await app.inject({ method: 'GET', url: '/api/contexts/active' });

    expect(recent.statusCode).toBe(200);
    expect(recent.json()).toEqual([{ path: '/code/agentpanel', name: 'agentpanel' }]);
    expect(loadRecentProjects).toHaveBeenCalledTimes(1);
    expect(projects.json()).toEqual([]);
    expect(groups.json()).toEqual([]);
    expect(contexts.json()).toEqual([]);
    expect(activeContext.json()).toBeNull();
  });

  it('preserves notification and CLI status response contracts', async () => {
    const app = createApp();
    registerWorkbenchStatusRoutes(app, { loadRecentProjects: vi.fn(async () => []) });

    const unread = await app.inject({
      method: 'GET',
      url: '/api/notifications/unread-count',
    });
    const notifications = await app.inject({ method: 'GET', url: '/api/notifications' });
    const cliStatus = await app.inject({ method: 'GET', url: '/api/cli/status' });

    expect(unread.json()).toEqual({ count: 0 });
    expect(notifications.json()).toEqual([]);
    expect(cliStatus.json()).toEqual({
      installed: true,
      version: 'cc-connect',
      path: null,
    });
  });
});
