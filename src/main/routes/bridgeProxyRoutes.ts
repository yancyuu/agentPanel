import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface BridgeProxyRuntimeConfig {
  ccBaseUrl: string;
  ccToken: string;
}

interface BridgeProxyRouteDependencies {
  getRuntimeConfig(): BridgeProxyRuntimeConfig;
  fetchImpl?: typeof fetch;
}

async function proxyToBridge({
  request,
  reply,
  stripPrefix,
  getRuntimeConfig,
  fetchImpl,
}: {
  request: FastifyRequest;
  reply: FastifyReply;
  stripPrefix: string;
  getRuntimeConfig: () => BridgeProxyRuntimeConfig;
  fetchImpl: typeof fetch;
}) {
  const runtimeConfig = getRuntimeConfig();
  const baseUrl = runtimeConfig.ccBaseUrl.replace(/\/+$/, '');
  const subPath = request.url.startsWith(stripPrefix)
    ? request.url.slice(stripPrefix.length) || '/'
    : request.url;
  const target = `${baseUrl}/api/v1${subPath}`;
  const headers: Record<string, string> = {
    'Content-Type': request.headers['content-type'] ?? 'application/json',
  };
  if (runtimeConfig.ccToken) {
    headers.Authorization = `Bearer ${runtimeConfig.ccToken}`;
  }

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body =
      request.body === null || request.body === undefined
        ? undefined
        : JSON.stringify(request.body);
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, init);
  } catch (error) {
    request.log.warn({ target, err: error }, 'hermit-bridge proxy network error');
    return reply.code(502).send({
      ok: false,
      error: `hermit-bridge 不可达: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.includes('json') && upstream.status >= 400) {
    const snippet = body.toString('utf8').slice(0, 100).trim();
    request.log.warn(
      { target, status: upstream.status, contentType, snippet },
      'hermit-bridge returned non-JSON error response'
    );
    return reply.code(upstream.status).send({
      ok: false,
      error:
        `hermit-bridge 端点 ${subPath} 返回了非 JSON 响应 (HTTP ${upstream.status})。` +
        '请检查 hermit-bridge 是否正在运行且支持该端点。',
    });
  }

  return reply
    .code(upstream.status)
    .header('Content-Type', contentType || 'application/json; charset=utf-8')
    .send(body);
}

export function registerBridgeProxyRoutes(
  app: FastifyInstance,
  { getRuntimeConfig, fetchImpl = fetch }: BridgeProxyRouteDependencies
): void {
  app.all('/api/bridge/*', async (request, reply) =>
    proxyToBridge({ request, reply, stripPrefix: '/api/bridge', getRuntimeConfig, fetchImpl })
  );
  app.all('/api/cc/*', async (request, reply) =>
    proxyToBridge({ request, reply, stripPrefix: '/api/cc', getRuntimeConfig, fetchImpl })
  );
  app.all('/api/v1/*', async (request, reply) =>
    proxyToBridge({ request, reply, stripPrefix: '/api/v1', getRuntimeConfig, fetchImpl })
  );
}
