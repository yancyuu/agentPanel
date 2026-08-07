import { CROSS_TEAM_SENT_SOURCE } from '@shared/constants/crossTeam';
import { SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';
import { discoverableTeamToWorker } from '@shared/types/worker';

import type { AppendGroupMessageInput } from '../services/team-management/TeamWorkspaceService';
import type { CcSession } from '@shared/types/api';
import type {
  HermitBridgeSessionDetail,
  HermitBridgeSessionListItem,
} from '@shared/types/hermitBridge';
import type { DiscoverableTeam } from '@shared/types/team';
import type { DiscoverableWorker } from '@shared/types/worker';
import type { FastifyInstance } from 'fastify';

interface WorkerRouteDependencies {
  discoverTeams(): Promise<DiscoverableTeam[]>;
  resolveTeamSlugForMention(rawName: string): Promise<string | null>;
  ensureLoopSessionProjectReady(teamName: string): Promise<{ bindProject: string }>;
  listSessions(projectName: string): Promise<HermitBridgeSessionListItem[]>;
  createSession(
    projectName: string,
    name?: string,
    sessionKey?: string
  ): Promise<HermitBridgeSessionDetail>;
  sendHarnessMessageViaBridge(params: {
    teamName: string;
    text: string;
    sessionKey?: string;
  }): Promise<string>;
  appendMessage(teamSlug: string, message: AppendGroupMessageInput): Promise<unknown>;
  broadcastSse(event: string, data: unknown): void;
  buildFallbackSessionKey(teamName: string): string;
}

function mapHermitBridgeSessionListItem(
  session: HermitBridgeSessionListItem,
  projectId: string
): CcSession {
  return {
    id: session.agent_session_id || session.id,
    title: session.name || session.session_key,
    projectId,
    sessionKey: session.session_key,
    platform: session.platform,
    userName: session.user_name ?? null,
    chatName: session.chat_name ?? null,
    active: session.active,
    live: session.live,
    historyCount: session.history_count,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    lastMessage: session.last_message
      ? {
          role: session.last_message.role,
          content: session.last_message.content,
          timestamp: session.last_message.timestamp,
        }
      : null,
  };
}

export function registerWorkerRoutes(
  app: FastifyInstance,
  dependencies: WorkerRouteDependencies
): void {
  const listDiscoverableWorkers = async (): Promise<DiscoverableWorker[]> => {
    const teams = await dependencies.discoverTeams();
    return teams
      .filter((team) => team.slug !== SYSTEM_MANAGER_TEAM_NAME && team.location === 'local')
      .map(discoverableTeamToWorker)
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  app.get('/api/workers', async () => ({ workers: await listDiscoverableWorkers() }));

  app.post<{
    Params: { workerId: string };
    Body: {
      fromTeam?: string;
      text?: unknown;
      summary?: unknown;
      sessionName?: unknown;
      reuse?: unknown;
      sessionKey?: unknown;
    };
  }>('/api/workers/:workerId/invoke', async (request, reply) => {
    try {
      const workerId = request.params.workerId.trim();
      const resolvedWorkerId = await dependencies.resolveTeamSlugForMention(workerId);
      if (!resolvedWorkerId || resolvedWorkerId === SYSTEM_MANAGER_TEAM_NAME) {
        return reply.code(404).send({ error: `Unknown worker: ${workerId}` });
      }

      const workers = await listDiscoverableWorkers();
      const worker = workers.find((entry) => entry.workerId === resolvedWorkerId);
      if (!worker) return reply.code(404).send({ error: `Unknown worker: ${workerId}` });

      const message = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
      if (!message) return reply.code(400).send({ error: 'text is required' });

      const requestedSessionName =
        typeof request.body?.sessionName === 'string' ? request.body.sessionName.trim() : '';
      const summary = typeof request.body?.summary === 'string' ? request.body.summary.trim() : '';
      const sessionName =
        requestedSessionName ||
        summary ||
        `Admin Invoke ${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const reuse = request.body?.reuse !== false;
      const fromTeam =
        typeof request.body?.fromTeam === 'string' ? request.body.fromTeam.trim() : '';
      const fromSessionKey =
        typeof request.body?.sessionKey === 'string' && request.body.sessionKey.trim().length > 0
          ? request.body.sessionKey.trim()
          : dependencies.buildFallbackSessionKey(fromTeam || SYSTEM_MANAGER_TEAM_NAME);

      const { bindProject } = await dependencies.ensureLoopSessionProjectReady(resolvedWorkerId);
      const sessionKey = `${dependencies.buildFallbackSessionKey(resolvedWorkerId)}:${Date.now().toString(36)}`;
      const sessions = reuse ? await dependencies.listSessions(bindProject).catch(() => []) : [];
      let session = reuse
        ? sessions.find((item) => item.name === sessionName && (item.live || item.active))
        : undefined;
      const reused = Boolean(session);
      if (!session) {
        const created = await dependencies.createSession(bindProject, sessionName, sessionKey);
        session = {
          id: created.id,
          name: created.name || sessionName,
          session_key: created.session_key || sessionKey,
          agent_session_id: created.agent_session_id,
          agent_type: created.agent_type,
          active: created.active,
          live: created.live,
          history_count: created.history_count,
          created_at: created.created_at,
          updated_at: created.updated_at,
          last_message: null,
          platform: created.platform,
        };
      }

      await dependencies.sendHarnessMessageViaBridge({
        teamName: resolvedWorkerId,
        text: message,
        sessionKey: session.session_key,
      });
      if (fromTeam) {
        await dependencies.appendMessage(fromTeam, {
          from: `${fromTeam}.user`,
          to: resolvedWorkerId,
          role: 'user',
          content: `@${resolvedWorkerId} ${message}`,
          meta: { source: CROSS_TEAM_SENT_SOURCE, sessionKey: fromSessionKey, summary },
        });
        dependencies.broadcastSse('team-change', { type: 'inbox', teamName: fromTeam });
      }
      dependencies.broadcastSse('team-change', {
        type: 'inbox',
        teamName: resolvedWorkerId,
      });
      return {
        ok: true,
        worker,
        session: mapHermitBridgeSessionListItem(session, resolvedWorkerId),
        reused,
        messageSent: true,
      };
    } catch (error) {
      return reply
        .code(500)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
