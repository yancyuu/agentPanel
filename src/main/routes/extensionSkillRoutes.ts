import type { extensionHandlers } from '../ipc/extensions';
import type {
  SkillDeleteRequest,
  SkillImportRequest,
  SkillUpsertRequest,
} from '@shared/types/extensions';
import type { FastifyInstance } from 'fastify';

type ExtensionHandlers = typeof extensionHandlers;

type SkillRouteHandlers = Pick<
  ExtensionHandlers,
  | 'skillsList'
  | 'skillsGetDetail'
  | 'skillsUpsert'
  | 'skillsDelete'
  | 'skillsPreviewUpsert'
  | 'skillsApplyUpsert'
  | 'skillsPreviewImport'
  | 'skillsApplyImport'
  | 'skillsStartWatching'
  | 'skillsStopWatching'
>;

interface ExtensionSkillRouteDependencies {
  handlers: SkillRouteHandlers;
}

export function registerExtensionSkillRoutes(
  app: FastifyInstance,
  { handlers }: ExtensionSkillRouteDependencies
): void {
  app.get('/api/extensions/skills', async (request) => {
    const projectPath = (request.query as Record<string, string>).projectPath;
    return handlers.skillsList(projectPath);
  });

  app.get('/api/extensions/skills/:skillId', async (request) => {
    const { skillId } = request.params as { skillId: string };
    const projectPath = (request.query as Record<string, string>).projectPath;
    return handlers.skillsGetDetail(skillId, projectPath);
  });

  app.post('/api/extensions/skills/upsert', async (request) =>
    handlers.skillsUpsert(request.body as SkillUpsertRequest)
  );

  app.post('/api/extensions/skills/delete', async (request) =>
    handlers.skillsDelete(request.body as SkillDeleteRequest)
  );

  app.post('/api/extensions/skills/preview-upsert', async (request) =>
    handlers.skillsPreviewUpsert(request.body as SkillUpsertRequest)
  );

  app.post('/api/extensions/skills/apply-upsert', async (request) =>
    handlers.skillsApplyUpsert(request.body as SkillUpsertRequest)
  );

  app.post('/api/extensions/skills/preview-import', async (request) =>
    handlers.skillsPreviewImport(request.body as SkillImportRequest)
  );

  app.post('/api/extensions/skills/apply-import', async (request) =>
    handlers.skillsApplyImport(request.body as SkillImportRequest)
  );

  app.post('/api/extensions/skills/watching/start', async (request) => {
    const projectPath = (request.query as Record<string, string>).projectPath;
    return handlers.skillsStartWatching(projectPath);
  });

  app.post('/api/extensions/skills/watching/stop', async (request) => {
    const { watchId } = (request.body ?? {}) as { watchId?: string };
    return handlers.skillsStopWatching(watchId!);
  });
}
