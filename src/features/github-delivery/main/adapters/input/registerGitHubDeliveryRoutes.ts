import { GITHUB_DELIVERY_ROUTES } from '@features/github-delivery/contracts';
import { zipDirectory } from '@main/utils/zipDirectory';

import type {
  PublishGitHubDeliveryRequest,
  SaveGitHubDeliveryBindingRequest,
} from '@features/github-delivery/contracts';
import type { GitHubDeliveryService } from '@features/github-delivery/main/infrastructure/GitHubDeliveryService';
import type { FastifyInstance } from 'fastify';

function respondError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  error: unknown
) {
  return reply
    .code(400)
    .send({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

export function registerGitHubDeliveryRoutes(
  app: FastifyInstance,
  {
    service,
  }: {
    service: Pick<
      GitHubDeliveryService,
      'listBindings' | 'saveBinding' | 'deleteBinding' | 'publish' | 'resolveArchivedVersion'
    >;
  }
): void {
  app.get(GITHUB_DELIVERY_ROUTES.bindings, async () => ({
    ok: true,
    data: await service.listBindings(),
  }));

  app.put<{ Params: { agentName: string }; Body: SaveGitHubDeliveryBindingRequest }>(
    `${GITHUB_DELIVERY_ROUTES.bindings}/:agentName`,
    async (request, reply) => {
      try {
        return {
          ok: true,
          data: await service.saveBinding(request.params.agentName, request.body),
        };
      } catch (error) {
        return respondError(reply, error);
      }
    }
  );

  app.delete<{ Params: { agentName: string } }>(
    `${GITHUB_DELIVERY_ROUTES.bindings}/:agentName`,
    async (request, reply) => {
      try {
        await service.deleteBinding(request.params.agentName);
        return reply.code(204).send();
      } catch (error) {
        return respondError(reply, error);
      }
    }
  );

  app.get<{ Params: { teamName: string; taskId: string } }>(
    '/api/github-delivery/archive/:teamName/:taskId',
    async (request, reply) => {
      try {
        return {
          ok: true,
          data: await service.resolveArchivedVersion(
            request.params.teamName,
            request.params.taskId
          ),
        };
      } catch (error) {
        return respondError(reply, error);
      }
    }
  );

  app.get<{ Params: { teamName: string; taskId: string } }>(
    '/api/github-delivery/archive/:teamName/:taskId.zip',
    async (request, reply) => {
      try {
        const archived = await service.resolveArchivedVersion(
          request.params.teamName,
          request.params.taskId
        );
        const zip = await zipDirectory(archived.versionDir);
        const filename = `${archived.title.replace(/[^a-zA-Z0-9._-]+/gu, '-') || 'delivery'}-${archived.versionId}.zip`;
        reply.header('Content-Type', 'application/zip');
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
        return reply.send(zip);
      } catch (error) {
        return respondError(reply, error);
      }
    }
  );

  app.post<{ Body: PublishGitHubDeliveryRequest }>(
    GITHUB_DELIVERY_ROUTES.publish,
    async (request, reply) => {
      try {
        const { teamName, taskId, agentName } = request.body ?? {};
        if (
          ![teamName, taskId, agentName].every((value) => typeof value === 'string' && value.trim())
        ) {
          return reply
            .code(400)
            .send({ ok: false, error: 'teamName、taskId 和 agentName 为必填项' });
        }
        return { ok: true, data: await service.publish({ teamName, taskId, agentName }) };
      } catch (error) {
        return respondError(reply, error);
      }
    }
  );
}
