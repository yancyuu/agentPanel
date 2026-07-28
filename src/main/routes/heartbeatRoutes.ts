import type { FastifyInstance } from 'fastify';

interface HeartbeatBridgeClient {
  getHeartbeat(projectName: string): Promise<unknown>;
  resumeHeartbeat(projectName: string): Promise<unknown>;
  pauseHeartbeat(projectName: string): Promise<unknown>;
  updateProject(projectName: string, patch: Record<string, unknown>): Promise<unknown>;
}

interface HeartbeatRouteDependencies {
  bridgeClient: HeartbeatBridgeClient;
  resolveProjectName(teamName: string): Promise<string>;
}

function errorPayload(error: unknown) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerHeartbeatRoutes(
  app: FastifyInstance,
  { bridgeClient, resolveProjectName }: HeartbeatRouteDependencies
): void {
  app.get<{ Params: { name: string } }>('/api/teams/:name/heartbeat', async (request, reply) => {
    try {
      const projectName = await resolveProjectName(request.params.name);
      const data = await bridgeClient.getHeartbeat(projectName);
      return { ok: true, data };
    } catch (error) {
      return reply.code(404).send(errorPayload(error));
    }
  });

  const toggleHandler =
    (toggle: (projectName: string) => Promise<unknown>) =>
    async (
      request: { params: { name: string } },
      reply: { code: (status: number) => { send: (payload: unknown) => unknown } }
    ) => {
      try {
        const projectName = await resolveProjectName(request.params.name);
        await toggle(projectName);
        return { ok: true };
      } catch (error) {
        return reply.code(500).send(errorPayload(error));
      }
    };

  app.post<{ Params: { name: string } }>(
    '/api/teams/:name/heartbeat/enable',
    toggleHandler((projectName) => bridgeClient.resumeHeartbeat(projectName))
  );
  app.post<{ Params: { name: string } }>(
    '/api/teams/:name/heartbeat/disable',
    toggleHandler((projectName) => bridgeClient.pauseHeartbeat(projectName))
  );
  app.post<{ Params: { name: string } }>(
    '/api/teams/:name/heartbeat/pause',
    toggleHandler((projectName) => bridgeClient.pauseHeartbeat(projectName))
  );
  app.post<{ Params: { name: string } }>(
    '/api/teams/:name/heartbeat/resume',
    toggleHandler((projectName) => bridgeClient.resumeHeartbeat(projectName))
  );

  app.patch<{
    Params: { name: string };
    Body: { interval_mins?: number; only_when_idle?: boolean; silent?: boolean };
  }>('/api/teams/:name/heartbeat', async (request, reply) => {
    try {
      const projectName = await resolveProjectName(request.params.name);
      await bridgeClient.updateProject(projectName, request.body as Record<string, unknown>);
      const data = await bridgeClient.getHeartbeat(projectName);
      return { ok: true, data };
    } catch (error) {
      return reply.code(500).send(errorPayload(error));
    }
  });
}
