import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface PlatformRuntimeConfig {
  ccBaseUrl: string;
  ccToken: string;
}

interface ExistingProject {
  agent_type?: string;
  work_dir?: string;
}

interface PlatformSetupDependencies {
  getRuntimeConfig(): PlatformRuntimeConfig;
  fetchImpl?: typeof fetch;
  persistPlatformMetadata(
    projectName: string,
    platformType: string,
    options: Record<string, unknown>
  ): Promise<void>;
  restartBridge(): Promise<void>;
  getProject(projectName: string): Promise<ExistingProject>;
  createProject(
    projectName: string,
    agentType: string,
    workDir: string,
    platformType: string,
    options: Record<string, string>
  ): Promise<Record<string, unknown> & { restart_required?: boolean }>;
}

function errorPayload(error: unknown) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function requestInit(config: PlatformRuntimeConfig, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.ccToken ? { Authorization: `Bearer ${config.ccToken}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  };
}

async function proxySetup(
  request: FastifyRequest,
  platform: 'feishu' | 'weixin',
  action: 'begin' | 'poll',
  getRuntimeConfig: () => PlatformRuntimeConfig,
  fetchImpl: typeof fetch
) {
  const config = getRuntimeConfig();
  return (
    await fetchImpl(
      `${config.ccBaseUrl}/api/v1/setup/${platform}/${action}`,
      requestInit(config, request.body)
    )
  ).json();
}

async function handleSetupSaveRestart(
  result: { data?: unknown; error?: unknown },
  restartBridge: () => Promise<void>
): Promise<unknown> {
  const resultData =
    result && typeof result.data === 'object' && result.data !== null ? result.data : result;
  if (!resultData || typeof resultData !== 'object') return result;
  const data = resultData as Record<string, unknown>;
  if ('error' in data || data.restart_handled === true) return result;
  await restartBridge();
  const restarted = { ...data, restart_required: false, restart_handled: true };
  return result.data && typeof result.data === 'object'
    ? { ...result, data: restarted }
    : restarted;
}

async function saveSetup(
  request: FastifyRequest,
  reply: FastifyReply,
  platform: 'feishu' | 'weixin',
  dependencies: Required<Pick<PlatformSetupDependencies, 'fetchImpl'>> &
    Omit<PlatformSetupDependencies, 'fetchImpl'>
) {
  const requestBody = (request.body ?? {}) as Record<string, unknown>;
  const config = dependencies.getRuntimeConfig();
  const response = await dependencies.fetchImpl(
    `${config.ccBaseUrl}/api/v1/setup/${platform}/save`,
    requestInit(config, requestBody)
  );
  const result = (await response.json()) as { data?: unknown; error?: unknown };
  if (!response.ok) return reply.code(response.status).send(result);
  const resultData = result && typeof result.data === 'object' ? result.data : result;
  if (resultData && typeof resultData === 'object' && !('error' in resultData)) {
    await dependencies.persistPlatformMetadata(
      typeof requestBody.project === 'string' ? requestBody.project : '',
      platform === 'feishu' && typeof requestBody.platform_type === 'string'
        ? requestBody.platform_type
        : platform,
      requestBody
    );
  }
  return handleSetupSaveRestart(result, dependencies.restartBridge);
}

export function registerPlatformSetupRoutes(
  app: FastifyInstance,
  dependencies: PlatformSetupDependencies
): void {
  const resolved = { ...dependencies, fetchImpl: dependencies.fetchImpl ?? fetch };

  app.post('/api/setup/feishu/begin', async (request) => {
    try {
      return await proxySetup(
        request,
        'feishu',
        'begin',
        resolved.getRuntimeConfig,
        resolved.fetchImpl
      );
    } catch (error) {
      return errorPayload(error);
    }
  });
  app.post('/api/setup/feishu/poll', async (request) => {
    try {
      return await proxySetup(
        request,
        'feishu',
        'poll',
        resolved.getRuntimeConfig,
        resolved.fetchImpl
      );
    } catch (error) {
      return errorPayload(error);
    }
  });
  app.post('/api/setup/feishu/save', async (request, reply) => {
    try {
      return await saveSetup(request, reply, 'feishu', resolved);
    } catch (error) {
      return errorPayload(error);
    }
  });
  app.post('/api/setup/weixin/begin', async (request) => {
    try {
      return await proxySetup(
        request,
        'weixin',
        'begin',
        resolved.getRuntimeConfig,
        resolved.fetchImpl
      );
    } catch (error) {
      return errorPayload(error);
    }
  });
  app.post('/api/setup/weixin/poll', async (request) => {
    try {
      return await proxySetup(
        request,
        'weixin',
        'poll',
        resolved.getRuntimeConfig,
        resolved.fetchImpl
      );
    } catch (error) {
      return errorPayload(error);
    }
  });
  app.post('/api/setup/weixin/save', async (request, reply) => {
    try {
      return await saveSetup(request, reply, 'weixin', resolved);
    } catch (error) {
      return errorPayload(error);
    }
  });

  app.post<{
    Params: { name: string };
    Body: {
      type: string;
      options?: Record<string, unknown>;
      work_dir?: string;
      agent_type?: string;
    };
  }>('/api/projects/:name/add-platform', async (request) => {
    try {
      const existingProject = await dependencies.getProject(request.params.name).catch(() => null);
      const result = await dependencies.createProject(
        request.params.name,
        request.body.agent_type ?? existingProject?.agent_type ?? 'claudecode',
        request.body.work_dir ?? existingProject?.work_dir ?? '',
        request.body.type,
        (request.body.options ?? {}) as Record<string, string>
      );
      await dependencies.persistPlatformMetadata(
        request.params.name,
        request.body.type,
        request.body.options ?? {}
      );
      if (result.restart_required) {
        await dependencies.restartBridge();
        return {
          ok: true,
          data: { ...result, restart_required: false, restart_handled: true },
        };
      }
      return { ok: true, data: { ...result, restart_handled: false } };
    } catch (error) {
      return errorPayload(error);
    }
  });
}
