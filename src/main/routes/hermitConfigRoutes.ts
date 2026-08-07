import type { FastifyInstance } from 'fastify';

interface HermitRuntimeConfig {
  ccBaseUrl: string;
  ccToken: string;
  ccBridgeUrl: string;
  ccBridgeToken: string;
}

interface HermitConfigRouteDependencies {
  getConfig(): HermitRuntimeConfig;
  saveConfig(patch: Partial<HermitRuntimeConfig>): HermitRuntimeConfig;
  readRaw(): { path: string; content: string };
  writeRaw(content: string): HermitRuntimeConfig;
  updateBridgeClient(config: { baseUrl: string; token: string }): void;
  updateBridgeConnection(config: { bridgeUrl: string; bridgeToken: string }): void;
}

function errorPayload(error: unknown) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerHermitConfigRoutes(
  app: FastifyInstance,
  {
    getConfig,
    saveConfig,
    readRaw,
    writeRaw,
    updateBridgeClient,
    updateBridgeConnection,
  }: HermitConfigRouteDependencies
): void {
  const hotUpdateClients = (config: HermitRuntimeConfig) => {
    updateBridgeClient({ baseUrl: config.ccBaseUrl, token: config.ccToken });
    updateBridgeConnection({
      bridgeUrl: config.ccBridgeUrl,
      bridgeToken: config.ccBridgeToken || config.ccToken,
    });
  };

  app.get('/api/hermit-config', async () => {
    const config = getConfig();
    return {
      ok: true,
      data: {
        ccBaseUrl: config.ccBaseUrl,
        ccToken: config.ccToken ? `${config.ccToken.slice(0, 4)}****` : '',
        ccTokenSet: config.ccToken.length > 0,
        ccBridgeUrl: config.ccBridgeUrl,
      },
    };
  });

  app.post<{
    Body: { ccBaseUrl?: string; ccToken?: string; ccBridgeUrl?: string };
  }>('/api/hermit-config', async (request) => {
    const { ccBaseUrl, ccToken, ccBridgeUrl } = request.body ?? {};
    const patch: Partial<HermitRuntimeConfig> = {};
    if (ccBaseUrl !== undefined) {
      patch.ccBaseUrl = ccBaseUrl.trim() || 'http://127.0.0.1:9820';
    }
    if (ccToken !== undefined) patch.ccToken = ccToken.trim();
    if (ccBridgeUrl !== undefined) {
      patch.ccBridgeUrl = ccBridgeUrl.trim() || 'ws://127.0.0.1:9810/bridge/ws';
    }

    const config = saveConfig(patch);
    hotUpdateClients(config);
    return {
      ok: true,
      data: { ccBaseUrl: config.ccBaseUrl, ccTokenSet: config.ccToken.length > 0 },
    };
  });

  app.get('/api/hermit-config/raw', async () => {
    try {
      return { ok: true, data: readRaw() };
    } catch (error) {
      return errorPayload(error);
    }
  });

  app.post<{ Body: { content?: unknown } }>('/api/hermit-config/raw', async (request) => {
    try {
      const content = request.body?.content;
      if (typeof content !== 'string') {
        return { ok: false, error: 'content 必须是字符串' };
      }
      const config = writeRaw(content);
      hotUpdateClients(config);
      return {
        ok: true,
        data: { ccBaseUrl: config.ccBaseUrl, ccTokenSet: config.ccToken.length > 0 },
      };
    } catch (error) {
      return errorPayload(error);
    }
  });
}
