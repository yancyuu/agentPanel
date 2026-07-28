import type { FastifyInstance } from 'fastify';

interface ReviewCompatibilityRouteOptions {
  now?: () => Date;
}

export function registerReviewCompatibilityRoutes(
  app: FastifyInstance,
  { now = () => new Date() }: ReviewCompatibilityRouteOptions = {}
): void {
  app.get<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/review/agent-changes/:memberName',
    async (request) => ({
      teamName: request.params.name,
      memberName: request.params.memberName,
      files: [],
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalFiles: 0,
      computedAt: now().toISOString(),
    })
  );
  app.get<{ Params: { name: string; taskId: string } }>(
    '/api/teams/:name/review/task-changes/:taskId',
    async () => ({ changes: [] })
  );
  app.get<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/review/change-stats/:memberName',
    async () => ({ stats: {} })
  );
  app.get<{ Params: { name: string } }>('/api/teams/:name/review/file-content', async () => ({
    content: '',
  }));
  app.post<{ Params: { name: string } }>('/api/teams/:name/review/apply-decisions', async () => ({
    ok: true,
  }));
  app.post('/api/teams/review/check-conflict', async () => ({ conflict: false }));
  app.post('/api/teams/review/preview-reject', async () => ({ preview: '' }));
  app.post('/api/teams/review/save-edited-file', async () => ({ ok: true }));
  app.post('/api/teams/review/decisions/load', async () => ({ decisions: {} }));
  app.post('/api/teams/review/decisions/save', async () => ({ ok: true }));
  app.post('/api/teams/review/decisions/clear', async () => ({ ok: true }));
  app.get('/api/teams/review/git-file-log', async () => ({ log: [] }));
}
