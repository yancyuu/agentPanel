import {
  type AdvancedConnectionLocalSnapshot,
  type AdvancedConnectionTokenClaimRequest,
  type AdvancedConnectionTokenClaimStepEvent,
  type CreateAdvancedConnectionRequest,
  type DiscoverAdvancedConnectionRequest,
  type StartAdvancedConnectionAuthRequest,
  type UpdateAdvancedConnectionPermissionsRequest,
} from '../../../contracts';

import type { AdvancedConnectionService } from '../../infrastructure/AdvancedConnectionService';
import type { FastifyInstance } from 'fastify';

interface AdvancedConnectionRouteDependencies {
  service: AdvancedConnectionService;
  localSnapshot?: () => Promise<AdvancedConnectionLocalSnapshot>;
  /** Token 领取步骤事件（SSE token-claim-event 广播） */
  onTokenClaimStep?: (event: AdvancedConnectionTokenClaimStepEvent) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function registerAdvancedConnectionRoutes(
  app: FastifyInstance,
  dependencies: AdvancedConnectionRouteDependencies
): void {
  app.get('/api/advanced-connections', async () => dependencies.service.list());

  app.post<{ Body: DiscoverAdvancedConnectionRequest }>(
    '/api/advanced-connections/discover',
    async (request, reply) => {
      try {
        return await dependencies.service.discover(request.body?.baseUrl ?? '');
      } catch (error) {
        return reply.code(400).send({ ok: false, error: errorMessage(error, '服务发现失败') });
      }
    }
  );

  app.post<{ Body: CreateAdvancedConnectionRequest }>(
    '/api/advanced-connections',
    async (request, reply) => {
      try {
        const connection = await dependencies.service.create({
          baseUrl: request.body?.baseUrl ?? '',
          label: request.body?.label,
        });
        return reply.code(201).send(connection);
      } catch (error) {
        return reply.code(400).send({ ok: false, error: errorMessage(error, '添加连接失败') });
      }
    }
  );

  app.delete<{ Params: { connectionId: string } }>(
    '/api/advanced-connections/:connectionId',
    async (request, reply) => {
      try {
        await dependencies.service.remove(request.params.connectionId);
        return { ok: true };
      } catch (error) {
        return reply.code(404).send({ ok: false, error: errorMessage(error, '删除连接失败') });
      }
    }
  );

  app.patch<{
    Params: { connectionId: string };
    Body: UpdateAdvancedConnectionPermissionsRequest;
  }>('/api/advanced-connections/:connectionId/permissions', async (request, reply) => {
    try {
      return await dependencies.service.updatePermissions(request.params.connectionId, {
        permissions: request.body?.permissions ?? {},
        highRiskAcknowledged: request.body?.highRiskAcknowledged,
      });
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error, '更新授权失败') });
    }
  });

  app.post<{
    Params: { connectionId: string };
    Body: StartAdvancedConnectionAuthRequest;
  }>('/api/advanced-connections/:connectionId/auth/start', async (request, reply) => {
    try {
      return reply
        .code(202)
        .send(
          await dependencies.service.startAuthentication(
            request.params.connectionId,
            request.body?.methodId ?? ''
          )
        );
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error, '启动授权失败') });
    }
  });

  app.post<{ Params: { connectionId: string } }>(
    '/api/advanced-connections/:connectionId/insecure-allow',
    async (request, reply) => {
      try {
        return await dependencies.service.allowInsecureTransport(request.params.connectionId);
      } catch (error) {
        return reply.code(400).send({ ok: false, error: errorMessage(error, '记录连接偏好失败') });
      }
    }
  );

  app.post<{ Params: { connectionId: string } }>(
    '/api/advanced-connections/:connectionId/logout',
    async (request, reply) => {
      try {
        return await dependencies.service.logout(request.params.connectionId);
      } catch (error) {
        return reply.code(400).send({ ok: false, error: errorMessage(error, '退出登录失败') });
      }
    }
  );

  app.post<{ Params: { connectionId: string } }>(
    '/api/advanced-connections/:connectionId/sync',
    async (request, reply) => {
      try {
        if (!dependencies.localSnapshot) throw new Error('本地同步数据源尚未配置');
        return await dependencies.service.syncAuthorizedData(
          request.params.connectionId,
          await dependencies.localSnapshot()
        );
      } catch (error) {
        return reply.code(400).send({ ok: false, error: errorMessage(error, '同步失败') });
      }
    }
  );

  app.post<{ Params: { connectionId: string } }>(
    '/api/advanced-connections/:connectionId/team-bus/pull-tasks',
    async (request, reply) => {
      try {
        return await dependencies.service.pullRemoteTasks(request.params.connectionId);
      } catch (error) {
        return reply.code(400).send({ ok: false, error: errorMessage(error, '读取远程任务失败') });
      }
    }
  );

  app.post<{
    Params: { connectionId: string };
    Body: AdvancedConnectionTokenClaimRequest;
  }>('/api/advanced-connections/:connectionId/token-pool/claim-apply', async (request, reply) => {
    try {
      return await dependencies.service.claimAndApplyToken(
        request.params.connectionId,
        {
          modelApiIds: Array.isArray(request.body?.modelApiIds)
            ? request.body.modelApiIds
            : undefined,
          runtimes: Array.isArray(request.body?.runtimes) ? request.body.runtimes : [],
          model: request.body?.model,
          wireApi: request.body?.wireApi,
        },
        dependencies.onTokenClaimStep
      );
    } catch (error) {
      const message = errorMessage(error, 'Token 认领与应用失败');
      const status = message.includes('正在执行') ? 409 : 400;
      return reply.code(status).send({ ok: false, error: message });
    }
  });
}
