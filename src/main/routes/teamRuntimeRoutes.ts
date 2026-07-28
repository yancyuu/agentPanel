import { SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';

import { buildDirectReplyMessageId } from '../services/direct-cli';
import {
  isPlaceholderWorkDir,
  needsWorkDirReconcile,
} from '../services/hermitBridge/workDirReconcile';

import { activeTasks } from './teamTaskRoutes';

import type { DirectCliSessionManager } from '../services/direct-cli';
import type { HermitBridgeClient } from '../services/hermitBridge/HermitBridgeClient';
import type { LoopAssetsScannerService } from '../services/loop-assets/LoopAssetsScannerService';
import type { TeamProvisioningService } from '../services/team-management';
import type { AttachmentPayload, TeamLaunchRequest } from '@shared/types/team';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

export interface DirectCliMessageInput {
  teamName: string;
  sessionKey: string;
  workDir: string;
  from: string;
  to: string;
  text: string;
  attachments?: AttachmentPayload[];
  messageId: string;
}

interface TeamRuntimeOperationDependencies {
  teamProvisioning: Pick<TeamProvisioningService, 'readTeamManifestByProject'>;
  bridgeClient: Pick<HermitBridgeClient, 'getProject' | 'updateProject' | 'createProject'>;
  directCliManager: Pick<DirectCliSessionManager, 'getSessionId' | 'send'>;
  directCliRoutes: Map<string, { teamName: string; from: string; to: string }>;
  ensureSystemManager(): Promise<unknown>;
  restartBridge(): Promise<void>;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

export interface TeamRuntimeOperations {
  ensureLoopSessionProjectReady(teamName: string): Promise<{
    bindProject: string;
    projectExists: boolean;
    isOnline: boolean;
  }>;
  resolveDirectCliWorkDir(teamName: string): Promise<string>;
  dispatchDirectCliMessage(params: DirectCliMessageInput): Promise<void>;
}

export function createTeamRuntimeOperations(
  dependencies: TeamRuntimeOperationDependencies
): TeamRuntimeOperations {
  const svc = dependencies.teamProvisioning;
  const cc = dependencies.bridgeClient;

  async function ensureLoopSessionProjectReady(teamName: string): Promise<{
    bindProject: string;
    projectExists: boolean;
    isOnline: boolean;
  }> {
    if (teamName === SYSTEM_MANAGER_TEAM_NAME) await dependencies.ensureSystemManager();

    let manifest: Awaited<ReturnType<typeof svc.readTeamManifestByProject>> | null = null;
    try {
      manifest = await svc.readTeamManifestByProject(teamName);
    } catch {
      // Route name may already be a cc-connect project name.
    }

    const bindProject = manifest?.bindProject?.trim() || teamName;
    let projectExists = false;
    let isOnline = false;
    let workDir = manifest?.workDir?.trim() || '';
    const harness = manifest?.harness || 'claudecode';
    const platformType = manifest?.platform || 'bridge';
    const platformOptions = manifest?.platformOptions ?? {};

    let projectWorkDir = '';
    try {
      const project = await cc.getProject(bindProject);
      projectExists = true;
      isOnline =
        Array.isArray(project.platforms) &&
        project.platforms.some((platform) => platform.connected);
      if (typeof project.work_dir === 'string') projectWorkDir = project.work_dir.trim();
      if (!workDir && !isPlaceholderWorkDir(projectWorkDir)) workDir = projectWorkDir;
    } catch {
      // Project can be missing after cc-connect reset.
    }

    if (projectExists && workDir && needsWorkDirReconcile(projectWorkDir, workDir)) {
      try {
        await cc.updateProject(bindProject, { work_dir: workDir });
      } catch (error) {
        dependencies.logger.warn(
          { err: error, bindProject, workDir },
          'cc-connect work_dir reconcile failed'
        );
      }
    }

    if (!isOnline) {
      if (!projectExists) {
        if (!workDir) throw new Error('团队缺少项目路径，无法启动 Loop runtime');
        await cc.createProject(bindProject, harness, workDir, platformType, platformOptions);
        projectExists = true;
      }
      await dependencies.restartBridge();
      try {
        const project = await cc.getProject(bindProject);
        isOnline =
          Array.isArray(project.platforms) &&
          project.platforms.some((platform) => platform.connected);
      } catch {
        isOnline = false;
      }
    }

    return { bindProject, projectExists, isOnline };
  }

  async function resolveDirectCliWorkDir(teamName: string): Promise<string> {
    if (teamName === SYSTEM_MANAGER_TEAM_NAME) {
      await dependencies.ensureSystemManager().catch(() => undefined);
    }
    let manifest: Awaited<ReturnType<typeof svc.readTeamManifestByProject>> | null = null;
    try {
      manifest = await svc.readTeamManifestByProject(teamName);
    } catch {
      // Route name may already be a cc-connect project name.
    }
    const manifestWorkDir = manifest?.workDir?.trim() || '';
    if (manifestWorkDir) return manifestWorkDir;
    try {
      const bindProject = manifest?.bindProject?.trim() || teamName;
      const project = await cc.getProject(bindProject);
      if (typeof project.work_dir === 'string') {
        const dir = project.work_dir.trim();
        if (dir && !isPlaceholderWorkDir(dir)) return dir;
      }
    } catch {
      // Project may not exist — that's fine for direct-CLI.
    }
    return '';
  }

  async function dispatchDirectCliMessage(params: DirectCliMessageInput): Promise<void> {
    dependencies.directCliRoutes.set(params.sessionKey, {
      teamName: params.teamName,
      from: params.from,
      to: params.to,
    });
    await dependencies.directCliManager.send(params.sessionKey, {
      text: params.text,
      attachments: params.attachments,
      messageId: params.messageId,
      workDir: params.workDir,
    });
  }

  return {
    ensureLoopSessionProjectReady,
    resolveDirectCliWorkDir,
    dispatchDirectCliMessage,
  };
}

interface TeamRuntimeRouteDependencies {
  teamProvisioning: Pick<
    TeamProvisioningService,
    'updateTeam' | 'readTeamManifest' | 'readTeamManifestByProject' | 'readTasks' | 'readMessages'
  >;
  bridgeClient: Pick<HermitBridgeClient, 'getProject' | 'createProject' | 'deleteProject'>;
  loopAssetsScanner: Pick<LoopAssetsScannerService, 'scanTeam'>;
  directCliManager: Pick<DirectCliSessionManager, 'getSessionId'>;
  operations: TeamRuntimeOperations;
  resolveProjectName(teamName: string): Promise<string>;
  restartBridge(): Promise<void>;
  reply500(error: unknown): { ok: boolean; error: string };
}

type TeamRuntimeRouteSection = 'collaboration' | 'runtime';

interface TeamRuntimeRouteOptions {
  routes?: TeamRuntimeRouteSection[];
}

export function registerTeamRuntimeRoutes(
  app: FastifyInstance,
  dependencies: TeamRuntimeRouteDependencies,
  options: TeamRuntimeRouteOptions = {}
): void {
  const routes = new Set(options.routes ?? ['collaboration', 'runtime']);
  const svc = dependencies.teamProvisioning;
  const cc = dependencies.bridgeClient;

  if (routes.has('collaboration')) {
    app.patch<{ Params: { name: string }; Body: { collaboration: boolean } }>(
      '/api/teams/:name/collaboration',
      async (request, reply) => {
        const { collaboration } = request.body ?? {};
        if (typeof collaboration !== 'boolean') {
          return reply.code(400).send({ error: 'collaboration must be boolean' });
        }
        try {
          const updated = await svc.updateTeam(request.params.name, { collaboration });
          return { ok: true, data: { collaboration: updated.collaboration } };
        } catch (error) {
          return reply.code(404).send(dependencies.reply500(error));
        }
      }
    );
  }

  if (routes.has('runtime')) {
    app.get<{ Params: { name: string } }>(
      '/api/teams/:name/loop-assets',
      async (request, reply) => {
        try {
          const name = request.params.name;
          const manifest = await svc.readTeamManifest(name);
          let bindProject = manifest.bindProject || name;
          let workDir = manifest.workDir || '';
          let platforms: { type: string; connected?: boolean }[] = [];

          try {
            bindProject = await dependencies.resolveProjectName(name);
            const project = await cc.getProject(bindProject).catch(() => null);
            if (!workDir && project?.work_dir) workDir = project.work_dir;
            platforms = Array.isArray(project?.platforms)
              ? project.platforms.map((platform) => ({
                  type: platform.type,
                  connected: platform.connected,
                }))
              : [];
          } catch {
            // Local manifest data is enough for a best-effort scan.
          }

          const [tasks, messages] = await Promise.all([
            svc.readTasks(name).catch(() => []),
            svc.readMessages(name).catch(() => []),
          ]);
          return await dependencies.loopAssetsScanner.scanTeam({
            teamName: name,
            displayName: manifest.displayName,
            bindProject,
            workDir,
            teamRoot: manifest.rootPath,
            memberCount: 1,
            taskCount: activeTasks(tasks).length,
            messageCount: messages.length,
            platforms,
          });
        } catch (error) {
          return reply
            .code(404)
            .send({ error: error instanceof Error ? error.message : String(error) });
        }
      }
    );

    app.post<{
      Params: { name: string };
      Body: { sessionName?: unknown; message?: unknown; reuse?: unknown };
    }>('/api/teams/:name/loop-session', async (request, reply) => {
      try {
        const teamName = request.params.name;
        const message =
          typeof request.body?.message === 'string' ? request.body.message.trim() : '';
        const reuse = request.body?.reuse === true;
        const requestedSessionName =
          typeof request.body?.sessionName === 'string' ? request.body.sessionName.trim() : '';
        const sessionName =
          requestedSessionName || `Loop ${new Date().toISOString().replace(/[:.]/g, '-')}`;
        const workDir = await dependencies.operations.resolveDirectCliWorkDir(teamName);
        if (!workDir) {
          return reply.code(400).send({ error: '团队缺少项目路径，无法启动 Loop runtime' });
        }

        const sessionKey = `${teamName}:lead`;
        const reused = reuse && dependencies.directCliManager.getSessionId(sessionKey) != null;
        let messageSent = false;
        if (message) {
          const messageId = buildDirectReplyMessageId(sessionKey);
          await dependencies.operations.dispatchDirectCliMessage({
            teamName,
            sessionKey,
            workDir,
            from: teamName,
            to: 'user',
            text: message,
            messageId,
          });
          messageSent = true;
        }

        return {
          session: {
            id: dependencies.directCliManager.getSessionId(sessionKey) ?? sessionKey,
            name: sessionName,
            session_key: sessionKey,
            title: sessionName,
          },
          reused,
          messageSent,
        };
      } catch (error) {
        return reply
          .code(500)
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.post<{ Params: { name: string }; Body: Partial<TeamLaunchRequest> }>(
      '/api/teams/:name/launch',
      async (request, reply) => {
        try {
          const name = request.params.name;
          const body = request.body ?? {};
          let manifest: Awaited<ReturnType<typeof svc.readTeamManifestByProject>> | null = null;
          try {
            manifest = await svc.readTeamManifestByProject(name);
          } catch {
            // Team may only exist in cc-connect.
          }
          const bindProject = manifest?.bindProject ?? name;
          const workDir = body.cwd ?? manifest?.workDir ?? '';
          const harness = manifest?.harness ?? 'claudecode';
          const platformType = manifest?.platform ?? 'bridge';
          const platformOptions = manifest?.platformOptions ?? {};
          let isOnline = false;
          let projectExists = false;
          try {
            const project = await cc.getProject(bindProject);
            projectExists = true;
            isOnline =
              Array.isArray(project.platforms) &&
              project.platforms.some((platform) => platform.connected);
          } catch {
            // Project does not exist.
          }

          if (!isOnline) {
            if (!projectExists) {
              if (!workDir) {
                return reply
                  .code(400)
                  .send({ error: '团队缺少项目路径，无法启动 cc-connect project' });
              }
              try {
                await cc.createProject(
                  bindProject,
                  harness,
                  workDir,
                  platformType,
                  platformOptions
                );
                projectExists = true;
              } catch {
                // CC Connect project creation is best-effort.
              }
            }
            try {
              await dependencies.restartBridge();
            } catch (error) {
              request.log.warn(
                { err: error, bindProject },
                'cc-connect restart/bridge reconnect failed during team launch'
              );
            }
          }

          return {
            runId: `cc-connect:${bindProject}:${Date.now()}`,
            ok: true,
            data: { teamName: name, bindProject, projectExists, isOnline },
          };
        } catch (error) {
          return reply.code(404).send(dependencies.reply500(error));
        }
      }
    );

    app.post<{ Params: { name: string } }>('/api/teams/:name/stop', async (request) => {
      const bindProject = await dependencies.resolveProjectName(request.params.name);
      try {
        await cc.deleteProject(bindProject);
      } catch {
        // Project may not exist in cc-connect.
      }
      return { ok: true };
    });
  }
}
