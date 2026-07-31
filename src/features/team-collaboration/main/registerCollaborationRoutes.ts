import type {
  CollaborationRun,
  CreateCollaborationRunRequest,
  CreateCollaborationTeamRequest,
} from '../shared/contracts';
import type { CollaborationOrchestrator } from './CollaborationOrchestrator';
import type { CollaborationWorkspaceService } from './CollaborationWorkspaceService';
import type { TeamProvisioningService } from '@main/services/team-management';
import type { FastifyInstance } from 'fastify';

interface CollaborationRouteDependencies {
  workspace: CollaborationWorkspaceService;
  orchestrator: CollaborationOrchestrator;
  teams: Pick<TeamProvisioningService, 'readTeamManifest' | 'readTasks'>;
}

async function reconcileCompletedReview(
  run: CollaborationRun,
  dependencies: CollaborationRouteDependencies
): Promise<CollaborationRun> {
  if (run.phase !== 'review' || !run.rootTaskId || !run.rootTaskTeamSlug) return run;
  const tasks = await dependencies.teams.readTasks(run.rootTaskTeamSlug);
  const rootTask = tasks.find((task) => task.id === run.rootTaskId);
  if (rootTask?.reviewState !== 'approved') return run;
  return dependencies.workspace.updateRun(run.id, (current) => ({
    ...current,
    phase: 'completed',
    error: undefined,
  }));
}

export function registerCollaborationRoutes(
  app: FastifyInstance,
  dependencies: CollaborationRouteDependencies
): void {
  app.get('/api/collaboration/teams', async () => dependencies.workspace.listTeams());

  app.post<{ Body: CreateCollaborationTeamRequest }>(
    '/api/collaboration/teams',
    async (request, reply) => {
      try {
        const memberTeamSlugs = [...new Set(request.body?.memberTeamSlugs ?? [])];
        if (memberTeamSlugs.length < 2) {
          return reply.code(400).send({ ok: false, error: '至少选择两名数字员工' });
        }
        await Promise.all(
          memberTeamSlugs.map(async (teamSlug) => {
            const manifest = await dependencies.teams.readTeamManifest(teamSlug);
            if (manifest.deletedAt) throw new Error(`数字员工 ${manifest.displayName} 已删除`);
            if (manifest.harness !== 'claudecode') {
              throw new Error(`数字员工 ${manifest.displayName} 暂不支持圆桌协作`);
            }
            if (!manifest.workDir.trim()) {
              throw new Error(`数字员工 ${manifest.displayName} 没有可用工作目录`);
            }
            return manifest;
          })
        );
        return await dependencies.workspace.createTeam({
          displayName: request.body?.displayName ?? '',
          description: request.body?.description,
          memberTeamSlugs,
        });
      } catch (error) {
        return reply.code(400).send({
          ok: false,
          error: error instanceof Error ? error.message : '创建协作团队失败',
        });
      }
    }
  );

  app.get<{ Params: { slug: string } }>(
    '/api/collaboration/teams/:slug',
    async (request, reply) => {
      try {
        const team = await dependencies.workspace.readTeam(request.params.slug);
        const members = await Promise.all(
          team.memberTeamSlugs.map(async (teamSlug) => {
            const manifest = await dependencies.teams.readTeamManifest(teamSlug);
            return {
              teamSlug: manifest.slug,
              displayName: manifest.displayName,
              description: manifest.description,
              harness: manifest.harness,
              workDir: manifest.workDir,
            };
          })
        );
        const runs = await Promise.all(
          (await dependencies.workspace.listRuns(team.slug)).map((run) =>
            reconcileCompletedReview(run, dependencies)
          )
        );
        return { team, members, runs };
      } catch (error) {
        return reply.code(404).send({
          ok: false,
          error: error instanceof Error ? error.message : '协作团队不存在',
        });
      }
    }
  );

  app.delete<{ Params: { slug: string } }>(
    '/api/collaboration/teams/:slug',
    async (request, reply) => {
      try {
        await dependencies.workspace.deleteTeam(request.params.slug);
        return { ok: true };
      } catch (error) {
        return reply.code(404).send({
          ok: false,
          error: error instanceof Error ? error.message : '删除协作团队失败',
        });
      }
    }
  );

  app.post<{ Params: { slug: string }; Body: CreateCollaborationRunRequest }>(
    '/api/collaboration/teams/:slug/runs',
    { bodyLimit: 50 * 1024 * 1024 },
    async (request, reply) => {
      try {
        const run = await dependencies.orchestrator.createRun(request.params.slug, {
          title: request.body?.title ?? '',
          description: request.body?.description,
          attachments: request.body?.attachments,
        });
        return reply.code(202).send(run);
      } catch (error) {
        return reply.code(400).send({
          ok: false,
          error: error instanceof Error ? error.message : '创建团队任务失败',
        });
      }
    }
  );

  app.get<{ Params: { runId: string } }>(
    '/api/collaboration/runs/:runId',
    async (request, reply) => {
      try {
        return await reconcileCompletedReview(
          await dependencies.workspace.readRun(request.params.runId),
          dependencies
        );
      } catch (error) {
        return reply.code(404).send({
          ok: false,
          error: error instanceof Error ? error.message : '协作任务不存在',
        });
      }
    }
  );

  app.post<{ Params: { runId: string } }>(
    '/api/collaboration/runs/:runId/retry',
    async (request, reply) => {
      try {
        await dependencies.workspace.readRun(request.params.runId);
        dependencies.orchestrator.start(request.params.runId);
        return reply.code(202).send({ ok: true });
      } catch (error) {
        return reply.code(404).send({
          ok: false,
          error: error instanceof Error ? error.message : '协作任务不存在',
        });
      }
    }
  );
}
