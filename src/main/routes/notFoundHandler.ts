import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isSseFallbackRequest, openSseFallbackStream } from './sseRoutes';

import type { ServerRuntimeState } from '../serverContext';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface WorkbenchNotFoundHandlerOptions {
  staticDir: string;
  state: ServerRuntimeState;
  openSseFallback?: (
    request: FastifyRequest,
    reply: FastifyReply,
    state: ServerRuntimeState
  ) => unknown;
}

export function registerWorkbenchNotFoundHandler(
  app: FastifyInstance,
  {
    staticDir,
    state,
    openSseFallback = (request, reply, runtimeState) =>
      openSseFallbackStream(request, reply, runtimeState),
  }: WorkbenchNotFoundHandlerOptions
): void {
  app.setNotFoundHandler((request, reply) => {
    const url = request.url;
    if (!url.startsWith('/api/')) {
      const pathname = url.split('?')[0] ?? '/';
      const hasFileExtension = /\.[^/]+$/.test(pathname);
      const indexPath = path.join(staticDir, 'index.html');
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        !hasFileExtension &&
        existsSync(indexPath)
      ) {
        return reply.type('text/html; charset=utf-8').send(readFileSync(indexPath, 'utf8'));
      }
      return reply.code(404).type('text/plain').send('not found');
    }

    if (isSseFallbackRequest(request.method, url)) {
      return openSseFallback(request, reply, state);
    }
    if (request.method === 'GET') return [];
    return { ok: true };
  });
}
