import path from 'node:path';

import type { PiRuntimeStatus } from '../services/system-manager/PiRuntimeStatus';
import type { FastifyInstance, FastifyRequest } from 'fastify';

interface SystemManagerConfigServiceLike {
  getStatus(): Promise<unknown>;
  getConfig(): Promise<{ selectedWorkDir: string }>;
  updateConfig(patch: { selectedWorkDir?: string }): Promise<unknown>;
}

interface SystemDiagnosticRunServiceLike {
  getCurrent(): Promise<unknown>;
  start(input: {
    actionId: string;
    title: string;
    prompt: string;
    workDir: string;
  }): Promise<unknown>;
}

interface WorkspaceCleanupServiceLike {
  scan(selectedWorkDir?: string): Promise<unknown>;
  clean(ids: string[], selectedWorkDir?: string): Promise<unknown>;
}

interface WorkflowPromptServiceLike {
  list(folder: string): Promise<unknown>;
  read(folder: string, id: string): Promise<unknown>;
}

interface SystemManagerRouteDependencies {
  ensureSystemManager(): Promise<unknown>;
  ensureAdminLoopInitialized(): Promise<unknown>;
  systemManagerConfig: SystemManagerConfigServiceLike;
  diagnosticRuns: SystemDiagnosticRunServiceLike;
  workspaceCleanup: WorkspaceCleanupServiceLike;
  workflowPrompt: WorkflowPromptServiceLike;
  assertTrustedBrowserOrigin(request: FastifyRequest): void;
  /** Pi 运行时探测（诊断执行前置；可注入缓存实现） */
  getPiRuntimeStatus(): Promise<PiRuntimeStatus>;
  refreshPiRuntimeStatus(): Promise<PiRuntimeStatus>;
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
    diagnosticRuns,
    workspaceCleanup,
    workflowPrompt,
    assertTrustedBrowserOrigin,
    getPiRuntimeStatus,
    refreshPiRuntimeStatus,
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

  app.get('/api/system-manager/diagnostics/current', async (_request, reply) => {
    try {
      return await diagnosticRuns.getCurrent();
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Querystring: { refresh?: string } }>(
    '/api/system-manager/diagnostics/runtime',
    async (_request, reply) => {
      try {
        const refresh = _request.query.refresh === '1';
        return refresh ? await refreshPiRuntimeStatus() : await getPiRuntimeStatus();
      } catch (error) {
        return reply.code(500).send({ error: errorMessage(error) });
      }
    }
  );

  app.post<{ Body: { actionId?: string; title?: string; prompt?: string } }>(
    '/api/system-manager/diagnostics/run',
    async (request, reply) => {
      try {
        const actionId = request.body?.actionId?.trim() ?? '';
        const title = request.body?.title?.trim() ?? '';
        const prompt = request.body?.prompt?.trim() ?? '';
        if (!actionId || !title || !prompt) {
          return reply.code(400).send({ error: '诊断类型、标题和检查要求不能为空' });
        }
        // 诊断固定走 pi 运行时：不可用时前置拦截并给出配置引导
        const piStatus = await getPiRuntimeStatus();
        if (!piStatus.available) {
          return reply.code(409).send({
            error: `需先配置 Pi 运行时：${piStatus.missing.join('；') || '运行时不可用'}`,
            code: 'pi_runtime_missing',
            piRuntime: piStatus,
          });
        }
        const config = await systemManagerConfig.getConfig();
        return reply.code(202).send(
          await diagnosticRuns.start({
            actionId,
            title,
            prompt,
            workDir: config.selectedWorkDir,
          })
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    }
  );

  app.get('/api/system-manager/cleanup/scan', async (_request, reply) => {
    try {
      const config = await systemManagerConfig.getConfig();
      return await workspaceCleanup.scan(config.selectedWorkDir);
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { ids?: unknown } }>('/api/system-manager/cleanup', async (request, reply) => {
    try {
      assertTrustedBrowserOrigin(request);
      if (
        !Array.isArray(request.body?.ids) ||
        !request.body.ids.every((id) => typeof id === 'string')
      ) {
        return reply.code(400).send({ error: '请选择要清理的项目' });
      }
      const config = await systemManagerConfig.getConfig();
      return await workspaceCleanup.clean(request.body.ids, config.selectedWorkDir);
    } catch (error) {
      const message = errorMessage(error);
      if (message.startsWith('Forbidden origin:')) return reply.code(403).send({ error: message });
      return reply.code(500).send({ error: message });
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
