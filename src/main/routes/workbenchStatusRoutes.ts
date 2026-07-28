import type { FastifyInstance } from 'fastify';

interface WorkbenchStatusRouteDependencies {
  loadRecentProjects(): Promise<unknown> | unknown;
}

export function registerWorkbenchStatusRoutes(
  app: FastifyInstance,
  { loadRecentProjects }: WorkbenchStatusRouteDependencies
): void {
  app.get('/api/dashboard/recent-projects', async () => loadRecentProjects());

  app.get('/api/projects', async () => []);
  app.get('/api/repository-groups', async () => []);

  app.get('/api/notifications/unread-count', async () => ({ count: 0 }));
  app.get('/api/notifications', async () => []);

  app.get('/api/cli/status', async () => ({
    installed: true,
    version: 'cc-connect',
    path: null,
  }));

  app.get('/api/contexts', async () => []);
  app.get('/api/contexts/active', async () => null);
}
