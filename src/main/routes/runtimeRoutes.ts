import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

interface RuntimeRouteDependencies {
  getStatus(): Promise<unknown>;
  getRuntimeReadiness(): unknown;
  readEffectiveSettings(): Promise<Record<string, unknown>>;
  patchLocalSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  patchRemoteSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  defaultSettings: Record<string, unknown>;
  restartBridge(): Promise<unknown>;
  reloadBridge(): Promise<unknown>;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

function errorPayload(error: unknown) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerRuntimeRoutes(
  app: FastifyInstance,
  {
    getStatus,
    getRuntimeReadiness,
    readEffectiveSettings,
    patchLocalSettings,
    patchRemoteSettings,
    defaultSettings,
    restartBridge,
    reloadBridge,
    logger,
  }: RuntimeRouteDependencies
): void {
  app.get('/api/status', async () => {
    try {
      return { ok: true, data: await getStatus() };
    } catch (error) {
      return errorPayload(error);
    }
  });

  app.get('/api/v1/system/readiness', async () => ({
    ok: true,
    data: getRuntimeReadiness(),
  }));

  app.get('/api/cc-settings', async () => ({
    ok: true,
    data: await readEffectiveSettings(),
  }));

  app.patch<{ Body: Record<string, unknown> }>('/api/cc-settings', async (request) => {
    const patch = request.body ?? {};
    try {
      const localSettings = await patchLocalSettings(patch);
      let remoteSettings: Record<string, unknown> = {};
      try {
        remoteSettings = await patchRemoteSettings(patch);
      } catch (error) {
        logger.warn(
          { err: error },
          'cc-connect settings patch failed; saved AgentCLI settings locally'
        );
      }
      return {
        ok: true,
        data: { ...defaultSettings, ...remoteSettings, ...localSettings },
      };
    } catch (error) {
      return errorPayload(error);
    }
  });

  app.post('/api/cc-restart', async () => {
    try {
      await restartBridge();
      return { ok: true };
    } catch (error) {
      return errorPayload(error);
    }
  });

  app.post('/api/cc-reload', async () => {
    try {
      await reloadBridge();
      return { ok: true };
    } catch (error) {
      return errorPayload(error);
    }
  });
}
