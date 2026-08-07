import type { CommentReadStateService } from '../services/team-management/CommentReadStateService';
import type { FastifyInstance } from 'fastify';

export function registerCommentReadStateRoutes(
  app: FastifyInstance,
  dependencies: { service: CommentReadStateService }
): void {
  app.get('/api/workbench/comment-read-state', async () => ({
    state: await dependencies.service.read(),
  }));

  app.put<{ Body: { state?: unknown } }>('/api/workbench/comment-read-state', async (request) => ({
    state: await dependencies.service.write(request.body?.state),
  }));
}
