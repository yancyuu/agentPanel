import { existsSync } from 'node:fs';

import staticPlugin from '@fastify/static';

import type { FastifyInstance } from 'fastify';

interface StaticRouteOptions {
  staticDir: string;
}

export async function registerStaticRoutes(
  app: FastifyInstance,
  { staticDir }: StaticRouteOptions
): Promise<void> {
  if (existsSync(staticDir)) {
    await app.register(staticPlugin, {
      root: staticDir,
      prefix: '/',
      decorateReply: false,
    });
    return;
  }

  app.get('/', async (request, reply) => {
    if (request.url.startsWith('/api/')) return;
    reply
      .code(503)
      .type('text/plain')
      .send(`UI not built. Run: pnpm build:web (output → ${staticDir})`);
  });
}
