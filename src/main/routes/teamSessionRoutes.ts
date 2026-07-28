import {
  filterHiddenTeamSessions,
  mergeLocalAndCcSessions,
} from '../services/session-intelligence/teamSessionListMapper';

import type {
  LocalSessionDetail,
  LocalSessionSummary,
} from '../services/session-intelligence/LocalSessionScanner';
import type { TeamManifest } from '../services/team-management/TeamWorkspaceService';
import type { CcSessionDetail } from '@shared/types/api';
import type {
  HermitBridgeProjectDetail,
  HermitBridgeProjectListItem,
  HermitBridgeSessionDetail,
  HermitBridgeSessionListItem,
} from '@shared/types/hermitBridge';
import type { FastifyInstance } from 'fastify';

interface TeamSessionRouteDependencies {
  readTeamManifest(teamName: string): Promise<TeamManifest>;
  readHiddenSessionIds(teamName: string): Promise<Set<string>>;
  hideSession(teamName: string, sessionId: string): Promise<void>;
  listTeams(): Promise<TeamManifest[]>;
  scanSummaries(workDir: string, projectId: string): Promise<LocalSessionSummary[]>;
  readSessionDetail(
    workDir: string,
    sessionId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<LocalSessionDetail | null>;
  listSessions(projectName: string): Promise<HermitBridgeSessionListItem[]>;
  getSession(
    projectName: string,
    sessionId: string,
    historyLimit?: number
  ): Promise<HermitBridgeSessionDetail>;
  deleteSession(projectName: string, sessionId: string): Promise<void>;
  listProjects(): Promise<HermitBridgeProjectListItem[]>;
  getProject(projectName: string): Promise<HermitBridgeProjectDetail>;
  resolveProjectName(teamName: string): Promise<string>;
  now?: () => Date;
}

function mapCcSessionDetail(detail: HermitBridgeSessionDetail): CcSessionDetail {
  return {
    id: detail.agent_session_id || detail.id,
    name: detail.name || detail.session_key,
    sessionKey: detail.session_key,
    agentSessionId: detail.agent_session_id,
    agentType: detail.agent_type,
    active: detail.active,
    live: detail.live,
    historyCount: detail.history_count,
    createdAt: detail.created_at,
    updatedAt: detail.updated_at,
    platform: detail.platform,
    history: detail.history ?? [],
  };
}

export function registerTeamSessionRoutes(
  app: FastifyInstance,
  dependencies: TeamSessionRouteDependencies
): void {
  const now = dependencies.now ?? (() => new Date());

  app.get<{ Params: { name: string } }>(
    '/api/teams/:name/member-activity-meta',
    async (request) => ({
      teamName: request.params.name,
      computedAt: now().toISOString(),
      members: {},
      feedRevision: '0',
    })
  );

  app.get<{ Params: { name: string } }>('/api/teams/:name/member-activity', async (request) => ({
    teamName: request.params.name,
    computedAt: now().toISOString(),
    members: {},
    feedRevision: '0',
  }));

  app.get<{ Params: { name: string } }>('/api/teams/:name/member-spawn-statuses', async () => ({
    statuses: {},
    runId: null,
  }));

  app.get<{ Params: { name: string } }>('/api/teams/:name/agent-runtime', async (request) => ({
    teamName: request.params.name,
    updatedAt: now().toISOString(),
    runId: null,
    members: {},
  }));

  app.get<{ Params: { name: string } }>('/api/teams/:name/lead-activity', async () => ({
    state: 'offline',
    updatedAt: now().toISOString(),
  }));

  app.get<{ Params: { name: string } }>('/api/teams/:name/lead-context', async () => ({
    usage: null,
  }));

  app.get<{ Params: { name: string } }>('/api/teams/:name/sessions', async (request) => {
    try {
      const team = await dependencies.readTeamManifest(request.params.name);
      const workDir = team.workDir || team.bindProject || request.params.name;
      const hiddenSessionIds = await dependencies.readHiddenSessionIds(request.params.name);
      const localSessions = await dependencies.scanSummaries(workDir, request.params.name);

      let ccSessions: HermitBridgeSessionListItem[] = [];
      try {
        const bindProject = await dependencies.resolveProjectName(request.params.name);
        ccSessions = await dependencies.listSessions(bindProject);
      } catch {
        // cc-connect unavailable — preserve local-only data.
      }

      const visibleSessions = filterHiddenTeamSessions(localSessions, ccSessions, hiddenSessionIds);
      return mergeLocalAndCcSessions(
        visibleSessions.localSessions,
        visibleSessions.ccSessions,
        request.params.name
      );
    } catch {
      return [];
    }
  });

  app.get<{
    Params: { name: string; sessionId: string };
    Querystring: { history_limit?: string; offset?: string };
  }>('/api/teams/:name/sessions/:sessionId', async (request, reply) => {
    const limit = request.query.history_limit ? parseInt(request.query.history_limit, 10) : 500;
    const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;
    const team = await dependencies.readTeamManifest(request.params.name);
    const workDir = team.workDir || team.bindProject || request.params.name;
    const detail = await dependencies.readSessionDetail(workDir, request.params.sessionId, {
      offset,
      limit,
    });
    if (detail) return detail;

    try {
      const bindProject = await dependencies.resolveProjectName(request.params.name);
      const ccDetail = await dependencies.getSession(bindProject, request.params.sessionId, limit);
      return mapCcSessionDetail(ccDetail);
    } catch {
      return reply.code(404).send({ error: 'Session not found' });
    }
  });

  app.delete<{ Params: { name: string; sessionId: string } }>(
    '/api/teams/:name/sessions/:sessionId',
    async (request, reply) => {
      try {
        await dependencies.hideSession(request.params.name, request.params.sessionId);
      } catch (error) {
        return reply
          .code(500)
          .send({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }

      try {
        const bindProject = await dependencies.resolveProjectName(request.params.name);
        await dependencies.deleteSession(bindProject, request.params.sessionId);
        return { ok: true, archived: true, ccDeleted: true };
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error);
        app.log.warn(
          { err: error, teamName: request.params.name, sessionId: request.params.sessionId },
          'archived session locally but cc-connect delete failed'
        );
        return { ok: true, archived: true, ccDeleted: false, warning };
      }
    }
  );

  app.get('/api/teams/runtime/alive', async () => {
    try {
      const [projects, localTeams] = await Promise.all([
        dependencies.listProjects(),
        dependencies.listTeams().catch(() => []),
      ]);
      const localByProject = new Map(localTeams.map((team) => [team.bindProject, team]));
      return await Promise.all(
        projects.map(async (project) => {
          let isAlive = false;
          try {
            const detail = await dependencies.getProject(project.name);
            isAlive =
              Array.isArray(detail.platforms) &&
              detail.platforms.some((platform) => platform.connected);
          } catch {
            // Preserve degraded offline state.
          }
          return {
            teamName: localByProject.get(project.name)?.slug ?? project.name,
            isAlive,
            runId: project.name,
          };
        })
      );
    } catch {
      return [];
    }
  });

  app.get<{ Params: { name: string } }>('/api/teams/:name/process-alive', async (request) => {
    try {
      const bindProject = await dependencies.resolveProjectName(request.params.name);
      const project = await dependencies.getProject(bindProject);
      return (
        Array.isArray(project.platforms) && project.platforms.some((platform) => platform.connected)
      );
    } catch {
      return false;
    }
  });
}
