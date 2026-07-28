import os from 'node:os';
import path from 'node:path';

import {
  isCcProjectNotFoundError,
  isReservedSystemTeamName,
  normalizePlatformAllowFrom,
  normalizeStringArray,
  toHermitBridgeAgentType,
} from './teamRouteUtils';
import { activeTasks, toTeamTask } from './teamTaskRoutes';

import type { HermitBridgeClient } from '../services/hermitBridge/HermitBridgeClient';
import type { ProjectUsageStats } from '../services/session-intelligence/SessionUsageParser';
import type { TeamProvisioningService } from '../services/team-management';
import type { HermitBridgeProjectPlatform } from '@shared/types/hermitBridge';
import type { FastifyInstance } from 'fastify';

interface TeamDirectoryRouteDependencies {
  teamProvisioning: Pick<
    TeamProvisioningService,
    | 'listTeams'
    | 'readTeamManifest'
    | 'readTeamManifestByProject'
    | 'readTasks'
    | 'createTeam'
    | 'updateTeam'
    | 'deleteTeam'
    | 'restoreTeam'
  >;
  bridgeClient: Pick<
    HermitBridgeClient,
    'listProjects' | 'getProject' | 'getProviderRefs' | 'listProviders' | 'deleteProject'
  >;
  resolveProjectName(teamName: string): Promise<string>;
  getProjectStatsSnapshot(workDir: string): ProjectUsageStats | null;
  reply500(error: unknown): { ok: boolean; error: string };
  homeDir?: string;
}

type TeamDirectoryRouteSection = 'core' | 'restore';

interface TeamDirectoryRouteOptions {
  routes?: TeamDirectoryRouteSection[];
}

export function registerTeamDirectoryRoutes(
  app: FastifyInstance,
  dependencies: TeamDirectoryRouteDependencies,
  options: TeamDirectoryRouteOptions = {}
): void {
  const routes = new Set(options.routes ?? ['core', 'restore']);
  const svc = dependencies.teamProvisioning;
  const cc = dependencies.bridgeClient;

  if (routes.has('core')) {
    app.get('/api/teams', async () => {
      try {
        const [projects, localTeams] = await Promise.all([
          cc.listProjects().catch(() => []),
          svc.listTeams().catch(() => []),
        ]);
        const projectByName = new Map(projects.map((project) => [project.name, project]));
        const shouldHideProject = (name: string): boolean =>
          isReservedSystemTeamName(name) || name.startsWith('feishu:');

        return await Promise.all(
          localTeams
            .filter((meta) => {
              const bindProject = meta.bindProject || meta.slug;
              return (
                !isReservedSystemTeamName(meta.slug) &&
                !shouldHideProject(bindProject) &&
                !meta.slug.startsWith('feishu:')
              );
            })
            .map(async (meta) => {
              const bindProject = meta.bindProject || meta.slug;
              const project = projectByName.get(bindProject);
              const workDir = (meta.workDir || '').trim();
              const projectPath = (meta.workDir || '').trim();
              const harness = toHermitBridgeAgentType(project?.agent_type || meta.harness);
              const color = meta.color || 'blue';
              const displayName = meta.displayName || meta.slug;
              const usageStats = workDir ? dependencies.getProjectStatsSnapshot(workDir) : null;

              return {
                teamName: meta.slug,
                displayName,
                description: meta.description || '本地数字员工',
                color,
                memberCount: 1,
                members: [{ name: displayName, role: 'agent', agentId: harness, color }],
                taskCount: 0,
                lastActivity: null,
                isAlive: false,
                harness,
                bindProject,
                workDir,
                projectPath: projectPath || undefined,
                sessionsCount: project?.sessions_count ?? 0,
                heartbeatEnabled: project?.heartbeat_enabled ?? false,
                deletedAt: meta.deletedAt,
                pendingDelete: meta.pendingDelete === true,
                restartRequired: meta.restartRequired === true,
                stats: meta.deletedAt
                  ? undefined
                  : usageStats
                    ? {
                        sessions: usageStats.sessions,
                        messages: usageStats.messages,
                        tokens: usageStats.totalTokens,
                        tokensIn: usageStats.tokensIn,
                        tokensOut: usageStats.tokensOut,
                        cacheRead: usageStats.cacheRead,
                        cacheCreation: usageStats.cacheCreation,
                        durationMs: usageStats.durationMs,
                      }
                    : undefined,
              };
            })
        );
      } catch {
        return [];
      }
    });

    app.post('/api/teams/create', async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const bindProject = String(body.bindProject ?? '').trim();
        const displayName = String(body.displayName ?? body.teamName ?? '').trim();
        const harness = String(body.harness ?? 'claudecode');
        let workDir = String(body.workDir ?? body.cwd ?? '');

        if (!bindProject) return reply.code(400).send({ error: 'bindProject required' });
        if (!displayName) return reply.code(400).send({ error: 'displayName required' });
        if (!workDir) return reply.code(400).send({ error: 'workDir required' });
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(bindProject)) {
          return reply.code(400).send({
            error: '项目标识只能包含小写英文字母、数字、连字符和下划线，且必须以字母或数字开头',
          });
        }

        const existingTeams = await svc.listTeams().catch(() => []);
        const duplicateProject = existingTeams.find(
          (team) => team.bindProject?.toLowerCase() === bindProject.toLowerCase()
        );
        if (duplicateProject) {
          return reply.code(409).send({
            error: `项目标识"${bindProject}"已被"${duplicateProject.displayName}"使用，请换一个。`,
          });
        }

        workDir = workDir.replace(/\uff5e/g, '~');
        if (workDir.startsWith('~')) {
          workDir = path.join(dependencies.homeDir ?? os.homedir(), workDir.slice(1));
        }

        await svc.createTeam({
          displayName,
          bindProject,
          harness,
          workDir,
          color: typeof body.color === 'string' ? body.color : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          createCcProject: false,
        });
        return { runId: `local:${bindProject}:${Date.now()}` };
      } catch (error) {
        return reply
          .code(500)
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.get<{ Params: { name: string } }>('/api/teams/:name/data', async (request) => {
      const { name } = request.params;
      let displayName = name;
      let color = 'blue';
      let description = '';
      let collaboration = true;
      let workDir = '';
      let harness = 'claudecode';
      let language = '';
      let permissionMode = 'default';
      let showContextIndicator = false;
      let replyFooter = false;
      let injectSender = false;
      let managedSources = '*';
      let disabledCommands: string[] = [];
      let platformAllowFrom: Record<string, string> = {};
      let platformAllowChat: Record<string, string> = {};
      let bindProject = name;
      try {
        const meta = await svc.readTeamManifest(name);
        if (meta.displayName) displayName = meta.displayName;
        if (meta.color) color = meta.color;
        if (meta.description) description = meta.description;
        bindProject = meta.bindProject || name;
        collaboration = meta.collaboration ?? true;
        if (meta.workDir) workDir = meta.workDir;
        if (meta.harness) harness = meta.harness;
        if (meta.language) language = meta.language;
        if (meta.permissionMode) permissionMode = meta.permissionMode;
        if (typeof meta.showContextIndicator === 'boolean') {
          showContextIndicator = meta.showContextIndicator;
        }
        if (typeof meta.replyFooter === 'boolean') replyFooter = meta.replyFooter;
        if (typeof meta.injectSender === 'boolean') injectSender = meta.injectSender;
        if (meta.managedSources) managedSources = meta.managedSources;
        if (Array.isArray(meta.disabledCommands)) {
          disabledCommands = normalizeStringArray(meta.disabledCommands);
        }
        if (meta.platformAllowFrom) {
          platformAllowFrom = normalizePlatformAllowFrom(meta.platformAllowFrom);
        }
        if (meta.platformAllowChat) {
          platformAllowChat = normalizePlatformAllowFrom(meta.platformAllowChat);
        }
      } catch {
        // No local manifest.
      }

      const rawTasks = activeTasks(await svc.readTasks(name).catch(() => []));
      const teamTasks = rawTasks.map(toTeamTask);

      try {
        bindProject = await dependencies.resolveProjectName(name);
        const project = await cc.getProject(bindProject);
        const isOnline =
          Array.isArray(project.platforms) &&
          project.platforms.some((platform) => platform.connected);
        const projectSettings = (project.settings ?? {}) as Record<string, unknown>;
        const resolvedLanguage =
          typeof projectSettings.language === 'string' && projectSettings.language.trim().length > 0
            ? projectSettings.language.trim()
            : language;
        const resolvedManagedSources =
          typeof projectSettings.admin_from === 'string' &&
          projectSettings.admin_from.trim().length > 0
            ? projectSettings.admin_from.trim()
            : managedSources;
        const normalizedDisabledCommands = normalizeStringArray(projectSettings.disabled_commands);
        const resolvedDisabledCommands =
          Array.isArray(projectSettings.disabled_commands) && normalizedDisabledCommands.length > 0
            ? normalizedDisabledCommands
            : disabledCommands;
        const resolvedShowContextIndicator =
          typeof projectSettings.show_context_indicator === 'boolean'
            ? projectSettings.show_context_indicator
            : showContextIndicator;
        const resolvedReplyFooter =
          typeof projectSettings.reply_footer === 'boolean'
            ? projectSettings.reply_footer
            : replyFooter;
        const resolvedInjectSender =
          typeof projectSettings.inject_sender === 'boolean'
            ? projectSettings.inject_sender
            : injectSender;
        const normalizedAllowFrom = normalizePlatformAllowFrom(projectSettings.platform_allow_from);
        const normalizedAllowChat = normalizePlatformAllowFrom(projectSettings.platform_allow_chat);
        const resolvedPlatformAllowFrom =
          Object.keys(normalizedAllowFrom).length > 0 ? normalizedAllowFrom : platformAllowFrom;
        const resolvedPlatformAllowChat =
          Object.keys(normalizedAllowChat).length > 0 ? normalizedAllowChat : platformAllowChat;
        const resolvedPermissionMode =
          typeof project.agent_mode === 'string' && project.agent_mode.trim().length > 0
            ? project.agent_mode.trim()
            : permissionMode;
        const [providerRefs, globalProviders] = await Promise.all([
          cc.getProviderRefs(bindProject).catch(() => []),
          cc.listProviders().catch(() => []),
        ]);

        return {
          teamName: name,
          config: {
            name: displayName,
            color,
            description,
            language: resolvedLanguage,
            agentType: project.agent_type,
            permissionMode: resolvedPermissionMode,
            showContextIndicator: resolvedShowContextIndicator,
            replyFooter: resolvedReplyFooter,
            injectSender: resolvedInjectSender,
            managedSources: resolvedManagedSources,
            disabledCommands: resolvedDisabledCommands,
            platformAllowFrom: resolvedPlatformAllowFrom,
            platformAllowChat: resolvedPlatformAllowChat,
            projectPath: workDir || project.work_dir,
            members: [{ name: displayName, role: 'lead' }],
          },
          tasks: teamTasks,
          members: [
            {
              name: displayName,
              agentId: project.agent_type,
              agentType: project.agent_type,
              role: 'lead',
              color,
              currentTaskId: null,
              taskCount: teamTasks.length,
            },
          ],
          kanbanState: { teamName: name, reviewers: [], tasks: {} },
          processes: [],
          isAlive: isOnline,
          platforms: project.platforms ?? [],
          harness: project.agent_type,
          bindProject,
          collaboration,
          description,
          workDir: workDir || project.work_dir,
          permissionMode: resolvedPermissionMode,
          providerRefs,
          globalProviders,
          settings: {
            ...projectSettings,
            language: resolvedLanguage,
            admin_from: resolvedManagedSources,
            disabled_commands: resolvedDisabledCommands,
            show_context_indicator: resolvedShowContextIndicator,
            reply_footer: resolvedReplyFooter,
            inject_sender: resolvedInjectSender,
            platform_allow_from: resolvedPlatformAllowFrom,
            platform_allow_chat: resolvedPlatformAllowChat,
          },
          heartbeat: project.heartbeat,
          activeSessions: project.active_session_keys ?? [],
        };
      } catch {
        return {
          teamName: name,
          config: {
            name: displayName,
            color,
            description,
            language,
            agentType: harness,
            permissionMode,
            showContextIndicator,
            replyFooter,
            injectSender,
            managedSources,
            disabledCommands,
            platformAllowFrom,
            platformAllowChat,
            projectPath: workDir,
            members: [{ name: displayName, role: 'lead' }],
          },
          tasks: teamTasks,
          members: [
            {
              name: displayName,
              agentId: harness,
              agentType: harness,
              role: 'lead',
              color,
              currentTaskId: null,
              taskCount: teamTasks.length,
            },
          ],
          kanbanState: { teamName: name, reviewers: [], tasks: {} },
          processes: [],
          isAlive: false,
          platforms: [] as HermitBridgeProjectPlatform[],
          harness,
          bindProject,
          collaboration,
          description,
          workDir,
          permissionMode,
          providerRefs: [],
          globalProviders: [],
          heartbeat: null,
          settings: {
            language,
            admin_from: managedSources,
            disabled_commands: disabledCommands,
            show_context_indicator: showContextIndicator,
            reply_footer: replyFooter,
            inject_sender: injectSender,
            platform_allow_from: platformAllowFrom,
            platform_allow_chat: platformAllowChat,
          },
          activeSessions: [],
        };
      }
    });

    app.patch<{
      Params: { name: string };
      Body: { displayName?: string; color?: string; description?: string };
    }>('/api/teams/:name', async (request, reply) => {
      try {
        const updated = await svc.updateTeam(request.params.name, request.body ?? {});
        return { ok: true, data: updated };
      } catch (error) {
        return reply.code(404).send(dependencies.reply500(error));
      }
    });

    app.delete<{ Params: { name: string }; Querystring: { deleteFiles?: string } }>(
      '/api/teams/:name',
      async (request, reply) => {
        const teamName = request.params.name;
        if (isReservedSystemTeamName(teamName)) {
          return reply.code(403).send({ error: 'Helm Loop 不可删除' });
        }
        try {
          const restartRequired = false;
          let ccProjectName = teamName;
          let localTeamName = teamName;
          try {
            const manifest = await svc.readTeamManifestByProject(teamName);
            ccProjectName = manifest.bindProject || teamName;
            localTeamName = manifest.slug || teamName;
          } catch {
            // Team may only exist remotely or local metadata may already be gone.
          }
          if (isReservedSystemTeamName(ccProjectName) || isReservedSystemTeamName(localTeamName)) {
            return reply.code(403).send({ error: 'Helm Loop 不可删除' });
          }
          try {
            await svc.deleteTeam(localTeamName, {
              deleteFiles: request.query.deleteFiles === 'true',
            });
          } catch (error) {
            request.log.warn(
              { err: error, teamName, localTeamName },
              'delete local team metadata failed or already missing'
            );
          }
          return { ok: true, restartRequired };
        } catch (error) {
          return reply.code(500).send(dependencies.reply500(error));
        }
      }
    );
  }

  if (routes.has('restore')) {
    app.post<{ Params: { name: string } }>('/api/teams/:name/restore', async (request, reply) => {
      try {
        await svc.restoreTeam(request.params.name);
        return { ok: true };
      } catch (error) {
        return reply.code(404).send(dependencies.reply500(error));
      }
    });

    app.delete<{ Params: { name: string }; Querystring: { strictExternal?: string } }>(
      '/api/teams/:name/permanent',
      async (request, reply) => {
        const teamName = request.params.name;
        const strictExternal = request.query.strictExternal === 'true';
        if (isReservedSystemTeamName(teamName)) {
          return reply.code(403).send({ error: 'Helm Loop 不可删除' });
        }
        try {
          const manifest = await svc.readTeamManifestByProject(teamName);
          const ccProjectName = manifest.bindProject || teamName;
          if (isReservedSystemTeamName(ccProjectName) || isReservedSystemTeamName(manifest.slug)) {
            return reply.code(403).send({ error: 'Helm Loop 不可删除' });
          }
          let restartRequired = false;
          try {
            const result = await cc.deleteProject(ccProjectName);
            restartRequired = result.restart_required === true;
          } catch (error) {
            if (isCcProjectNotFoundError(error)) {
              request.log.info(
                { teamName, ccProjectName },
                'cc-connect project already missing while permanently deleting team'
              );
            } else if (strictExternal) {
              request.log.warn(
                { err: error, teamName, ccProjectName },
                'strict cc-connect project deletion failed'
              );
              return reply.code(502).send({
                error: `删除渠道项目失败，本地团队已保留：${error instanceof Error ? error.message : String(error)}`,
              });
            } else {
              request.log.warn(
                { err: error, teamName, ccProjectName },
                'delete cc-connect project failed'
              );
            }
          }
          await svc.deleteTeam(manifest.slug, { deleteFiles: true });
          return { ok: true, restartRequired };
        } catch (error) {
          return reply.code(500).send(dependencies.reply500(error));
        }
      }
    );
  }
}
