import { EventEmitter } from 'node:events';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerRuntimeState } from '../../../src/main/serverContext';
import {
  isSseFallbackRequest,
  openSseStream,
  registerSseRoutes,
} from '../../../src/main/routes/sseRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('SSE routes', () => {
  it('preserves trusted-origin rejection for the primary event stream', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerSseRoutes(app, {
      state: createServerRuntimeState(),
      assertTrustedBrowserOrigin: () => {
        throw new Error('禁止来自非受信任网页的本地 API 请求');
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { origin: 'https://untrusted.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: '禁止来自非受信任网页的本地 API 请求',
    });
  });

  it('opens, tracks and cleans the primary event stream', () => {
    vi.useFakeTimers();
    const state = createServerRuntimeState();
    const rawRequest = new EventEmitter();
    const rawReply = {
      writeHead: vi.fn(),
      write: vi.fn(),
    };
    const reply = {
      raw: rawReply,
      hijack: vi.fn(() => 'hijacked'),
    };

    const result = openSseStream({
      request: { raw: rawRequest },
      reply,
      state,
      clientId: 'sse-fixed',
      trackClient: true,
    });

    expect(result).toBe('hijacked');
    expect(rawReply.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    expect(rawReply.write).toHaveBeenCalledWith('event: hello\ndata: {"ok":true}\n\n');
    expect([...state.sseClients].map((client) => client.id)).toEqual(['sse-fixed']);
    expect(vi.getTimerCount()).toBe(1);

    rawRequest.emit('close');
    expect(state.sseClients.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('matches only legacy GET SSE fallback paths', () => {
    expect(isSseFallbackRequest('GET', '/api/teams/a/events')).toBe(true);
    expect(isSseFallbackRequest('GET', '/api/foo/stream?x=1')).toBe(false);
    expect(isSseFallbackRequest('GET', '/api/foo/notifications/stream')).toBe(true);
    expect(isSseFallbackRequest('POST', '/api/foo/events')).toBe(false);
    expect(isSseFallbackRequest('GET', '/api/foo')).toBe(false);
  });
});
