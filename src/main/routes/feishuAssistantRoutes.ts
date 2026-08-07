/**
 * 飞书个人助理 routes：复用 bin/lib/feishuAssistant.mjs 的既有实现
 * （动态 import，模式同 AdvancedConnectionService 的 loadAikeyRuntime），不重写逻辑。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

interface FeishuAssistantCreateResult {
  ok: boolean;
  alreadyExists?: boolean;
  teamSlug?: string;
  message: string;
  detail?: string;
}

interface FeishuAssistantListResult {
  ok: boolean;
  projects: { name: string; teamSlug: string; status: string }[];
  message: string;
}

interface FeishuAssistantModule {
  createFeishuAssistant(opts: {
    name?: string;
    aiKey?: string;
    description?: string;
    appId?: string;
    appSecret?: string;
  }): FeishuAssistantCreateResult;
  listFeishuAssistants(): FeishuAssistantListResult;
}

let feishuAssistantModule: Promise<FeishuAssistantModule> | undefined;

function loadFeishuAssistant(): Promise<FeishuAssistantModule> {
  feishuAssistantModule ??= import(
    pathToFileURL(
      path.join(
        process.env.AGENTPANEL_PACKAGE_ROOT?.trim() || process.cwd(),
        'bin',
        'lib',
        'feishuAssistant.mjs'
      )
    ).href
  ) as Promise<FeishuAssistantModule>;
  return feishuAssistantModule;
}

/** 测试可注入模块工厂；默认走 bin/lib 动态加载 */
export interface FeishuAssistantRouteDependencies {
  loadModule?: () => Promise<FeishuAssistantModule>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerFeishuAssistantRoutes(
  app: FastifyInstance,
  dependencies: FeishuAssistantRouteDependencies = {}
): void {
  const loadModule = dependencies.loadModule ?? loadFeishuAssistant;

  app.get('/api/feishu-assistants', async (_request, reply) => {
    try {
      const assistant = await loadModule();
      return assistant.listFeishuAssistants();
    } catch (error) {
      return reply.code(500).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{
    Body: {
      name?: string;
      description?: string;
      aiKey?: string;
      appId?: string;
      appSecret?: string;
    };
  }>('/api/feishu-assistants', async (request, reply) => {
    const name = request.body?.name?.trim() ?? '';
    if (!name) return reply.code(400).send({ ok: false, error: '缺少助理名称' });
    try {
      const assistant = await loadModule();
      const result = assistant.createFeishuAssistant({
        name,
        description: request.body?.description?.trim() || undefined,
        aiKey: request.body?.aiKey?.trim() || undefined,
        appId: request.body?.appId?.trim() || undefined,
        appSecret: request.body?.appSecret?.trim() || undefined,
      });
      if (!result.ok) return reply.code(400).send({ ok: false, error: result.message });
      return result;
    } catch (error) {
      return reply.code(500).send({ ok: false, error: errorMessage(error) });
    }
  });
}
