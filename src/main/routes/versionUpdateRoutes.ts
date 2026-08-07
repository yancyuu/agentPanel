import type { UpdateService } from '../services/UpdateService';
import type { FastifyInstance } from 'fastify';

interface VersionUpdateRouteDependencies {
  version: string;
  updateService: Pick<UpdateService, 'applyUpdate' | 'checkForUpdates'>;
}

export function registerVersionUpdateRoutes(
  app: FastifyInstance,
  { version, updateService }: VersionUpdateRouteDependencies
): void {
  // The renderer expects a JSON string rather than Fastify's default text/plain
  // handling for a raw string response.
  app.get('/api/version', async (_request, reply) =>
    reply.type('application/json').send(JSON.stringify(version))
  );

  app.get('/api/update/check', async () => updateService.checkForUpdates());

  app.post('/api/update/apply', async (_request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await updateService.applyUpdate((progress) => {
        send(progress);
        if (progress.phase === 'completed' || progress.phase === 'error') {
          reply.raw.end();
        }
      });
    } catch (error) {
      send({
        phase: 'error',
        message: 'Update failed',
        error: error instanceof Error ? error.message : String(error),
      });
      reply.raw.end();
    }
  });
}
