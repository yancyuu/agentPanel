import path from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';

interface SystemManagerConfigServiceLike {
  getStatus(): Promise<unknown>;
  getConfig(): Promise<{ selectedWorkDir: string }>;
  updateConfig(patch: { selectedWorkDir?: string }): Promise<unknown>;
}

interface WorkflowPromptServiceLike {
  list(folder: string): Promise<unknown>;
  read(folder: string, id: string): Promise<unknown>;
}

interface SystemManagerRouteDependencies {
  ensureSystemManager(): Promise<unknown>;
  ensureAdminLoopInitialized(): Promise<unknown>;
  systemManagerConfig: SystemManagerConfigServiceLike;
  workflowPrompt: WorkflowPromptServiceLike;
  assertTrustedBrowserOrigin(request: FastifyRequest): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerSystemManagerRoutes(
  app: FastifyInstance,
  {
    ensureSystemManager,
    ensureAdminLoopInitialized,
    systemManagerConfig,
    workflowPrompt,
    assertTrustedBrowserOrigin,
  }: SystemManagerRouteDependencies
): void {
  app.post('/api/system-manager/ensure', async (_request, reply) => {
    try {
      const summary = await ensureSystemManager();
      // The bootstrap remains fire-and-forget and idempotent so opening the
      // console does not block on the remote ops guide.
      void ensureAdminLoopInitialized();
      return summary;
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.get('/api/system-manager/status', async (_request, reply) => {
    try {
      return await systemManagerConfig.getStatus();
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.get('/api/system-manager/config', async (_request, reply) => {
    try {
      return await systemManagerConfig.getConfig();
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: { selectedWorkDir?: string } }>(
    '/api/system-manager/config',
    async (request, reply) => {
      try {
        return await systemManagerConfig.updateConfig(request.body ?? {});
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    }
  );

  app.post<{ Body: { folder?: string } }>(
    '/api/system-manager/workflows/list',
    async (request, reply) => {
      try {
        assertTrustedBrowserOrigin(request);
        const config = await systemManagerConfig.getConfig();
        const workspaceRoot = config.selectedWorkDir.replace(/[\\/]+$/, '');
        const folder =
          typeof request.body?.folder === 'string' && request.body.folder.trim().length > 0
            ? request.body.folder
            : path.join(workspaceRoot, '.claude', 'commands');
        if (!folder) return { folder: '', prompts: [], warnings: [] };
        return await workflowPrompt.list(folder);
      } catch (error) {
        const message = errorMessage(error);
        if (message.startsWith('Forbidden origin:')) {
          return reply.code(403).send({ error: message });
        }
        return { folder: '', prompts: [], warnings: [] };
      }
    }
  );

  app.post<{ Body: { folder?: string; id?: string } }>(
    '/api/system-manager/workflows/read',
    async (request, reply) => {
      try {
        assertTrustedBrowserOrigin(request);
        const config = await systemManagerConfig.getConfig();
        const workspaceRoot = config.selectedWorkDir.replace(/[\\/]+$/, '');
        const folder =
          typeof request.body?.folder === 'string' && request.body.folder.trim().length > 0
            ? request.body.folder
            : path.join(workspaceRoot, '.claude', 'commands');
        if (!folder) {
          return reply.code(400).send({ error: 'command folder is not configured' });
        }
        const id = typeof request.body?.id === 'string' ? request.body.id : '';
        return await workflowPrompt.read(folder, id);
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    }
  );
}
