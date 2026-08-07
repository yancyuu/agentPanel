import type { ServerRuntimeState, SseClient } from '../serverContext';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const SSE_FALLBACK_RE = /^\/api\/(.*\/(events|stream|notifications\/stream))$/;

interface SseRequestLike {
  raw: {
    on(eventName: 'close', listener: () => void): unknown;
  };
}

interface SseReplyLike {
  raw: {
    writeHead(statusCode: number, headers: Record<string, string>): unknown;
    write(chunk: string): unknown;
  };
  hijack(): unknown;
}

interface OpenSseStreamOptions {
  request: SseRequestLike;
  reply: SseReplyLike;
  state: ServerRuntimeState;
  clientId?: string;
  trackClient: boolean;
}

interface SseRouteDependencies {
  state: ServerRuntimeState;
  assertTrustedBrowserOrigin(request: FastifyRequest): void;
}

export function isSseFallbackRequest(method: string, url: string): boolean {
  return method === 'GET' && SSE_FALLBACK_RE.test(url);
}

export function openSseStream({
  request,
  reply,
  state,
  clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  trackClient,
}: OpenSseStreamOptions): unknown {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client: SseClient | null = trackClient
    ? {
        res: reply.raw as SseClient['res'],
        id: clientId,
      }
    : null;
  if (client) state.sseClients.add(client);

  reply.raw.write('event: hello\ndata: {"ok":true}\n\n');

  const keepAlive = setInterval(() => {
    try {
      reply.raw.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
      if (client) state.sseClients.delete(client);
    }
  }, 15_000);

  request.raw.on('close', () => {
    clearInterval(keepAlive);
    if (client) state.sseClients.delete(client);
  });

  return reply.hijack();
}

export function openSseFallbackStream(
  request: SseRequestLike,
  reply: SseReplyLike,
  state: ServerRuntimeState
): unknown {
  return openSseStream({ request, reply, state, trackClient: false });
}

export function registerSseRoutes(
  app: FastifyInstance,
  { state, assertTrustedBrowserOrigin }: SseRouteDependencies
): void {
  app.get('/api/events', (request, reply) => {
    try {
      assertTrustedBrowserOrigin(request);
    } catch (error) {
      reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    return openSseStream({
      request,
      reply,
      state,
      trackClient: true,
    });
  });
}
