import {
  CC_AGENT_TYPES,
  isCcProjectNotFoundError,
  normalizePlatformAllowFrom,
  normalizePlatformAllowUpdate,
  normalizeStringArray,
} from './teamRouteUtils';

import type { HermitBridgeClient } from '../services/hermitBridge/HermitBridgeClient';
import type { TeamProvisioningService } from '../services/team-management';
import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';
import type { FastifyInstance } from 'fastify';

interface TeamConfigRouteDependencies {
  teamProvisioning: Pick<TeamProvisioningService, 'updateTeam' | 'createTeam' | 'readTeamManifest'>;
  bridgeClient: Pick<
    HermitBridgeClient,
    | 'getProject'
    | 'updateProject'
    | 'reload'
    | 'getProviderRefs'
    | 'setProviderRefs'
    | 'listProviders'
  >;
  resolveProjectName(teamName: string): Promise<string>;
  readConfigTomlRaw(): { path: string; content: string };
  writeConfigTomlRaw(content: string): void | Promise<void>;
  reply500(error: unknown): { ok: boolean; error: string };
  agentTypes?: readonly HermitBridgeAgentType[];
  assertCliAvailable?(agentType: string): Promise<void>;
}

type TeamConfigRouteSection = 'core' | 'put';

interface TeamConfigRouteOptions {
  routes?: TeamConfigRouteSection[];
}

async function defaultAssertCliAvailable(agentType: string): Promise<void> {
  if (agentType === 'claudecode') return;
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [agentType], {
      stdio: 'pipe',
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    throw new Error(
      `${agentType} CLI 未安装，无法切换到 ${agentType} 模式。请先安装对应的 CLI 工具。`
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function applyTeamConfigUpdate(
  teamName: string,
  body: Record<string, unknown>,
  dependencies: TeamConfigRouteDependencies
): Promise<Record<string, unknown>> {
  const svc = dependencies.teamProvisioning;
  const cc = dependencies.bridgeClient;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const color = typeof body.color === 'string' ? body.color.trim() : '';
  const agentType = typeof body.agentType === 'string' ? body.agentType.trim() : '';
  const workDir = typeof body.workDir === 'string' ? body.workDir.trim() : '';
  const permissionMode = typeof body.permissionMode === 'string' ? body.permissionMode.trim() : '';
  const language = typeof body.language === 'string' ? body.language.trim() : '';
  const managedSources = typeof body.managedSources === 'string' ? body.managedSources.trim() : '';
  const showContextIndicator =
    typeof body.showContextIndicator === 'boolean' ? body.showContextIndicator : undefined;
  const replyFooter = typeof body.replyFooter === 'boolean' ? body.replyFooter : undefined;
  const injectSender = typeof body.injectSender === 'boolean' ? body.injectSender : undefined;
  const disabledCommands = Array.isArray(body.disabledCommands)
    ? normalizeStringArray(body.disabledCommands)
    : undefined;
  const providerRefs = Array.isArray(body.providerRefs)
    ? normalizeStringArray(body.providerRefs)
    : undefined;
  const resetOnIdleMins =
    typeof body.resetOnIdleMins === 'number'
      ? Math.max(0, Math.round(body.resetOnIdleMins))
      : undefined;
  const platformOptionsUpdate =
    body.platformOptions &&
    typeof body.platformOptions === 'object' &&
    !Array.isArray(body.platformOptions)
      ? (body.platformOptions as Record<string, Record<string, string>>)
      : undefined;
  const platformAllowFrom = normalizePlatformAllowUpdate(body.platformAllowFrom);
  const platformAllowChat = normalizePlatformAllowUpdate(body.platformAllowChat);
  const agentTypes = dependencies.agentTypes ?? CC_AGENT_TYPES;

  if (agentType && !agentTypes.includes(agentType as HermitBridgeAgentType)) {
    throw new Error(`${agentType} 不是支持的运行时类型。`);
  }
  if (agentType && agentType !== 'claudecode') {
    await (dependencies.assertCliAvailable ?? defaultAssertCliAvailable)(agentType);
  }

  const localPatch: Record<string, unknown> = {};
  if (name) localPatch.displayName = name;
  if (description) localPatch.description = description;
  if (color) localPatch.color = color;
  if (agentType) localPatch.harness = agentType;
  if (workDir) localPatch.workDir = workDir;
  if (permissionMode) localPatch.permissionMode = permissionMode;
  if (language) localPatch.language = language;
  if (managedSources) localPatch.managedSources = managedSources;
  if (disabledCommands) localPatch.disabledCommands = disabledCommands;
  if (platformAllowFrom !== undefined) localPatch.platformAllowFrom = platformAllowFrom;
  if (platformAllowChat !== undefined) localPatch.platformAllowChat = platformAllowChat;
  if (showContextIndicator !== undefined) localPatch.showContextIndicator = showContextIndicator;
  if (replyFooter !== undefined) localPatch.replyFooter = replyFooter;
  if (injectSender !== undefined) localPatch.injectSender = injectSender;

  if (Object.keys(localPatch).length > 0) {
    try {
      await svc.updateTeam(teamName, localPatch);
    } catch {
      const project = await cc.getProject(teamName);
      await svc.createTeam({
        displayName: name || teamName,
        bindProject: teamName,
        harness: agentType || project.agent_type || 'claudecode',
        workDir: workDir || project.work_dir || '',
        color: color || undefined,
        description: description || undefined,
        createCcProject: false,
      });
      await svc.updateTeam(teamName, localPatch);
    }
  }

  const ccPatch: Record<string, unknown> = {};
  if (agentType) ccPatch.agent_type = agentType;
  if (workDir) ccPatch.work_dir = workDir;
  if (permissionMode) ccPatch.mode = permissionMode;
  if (language) ccPatch.language = language;
  if (managedSources) ccPatch.admin_from = managedSources;
  if (disabledCommands) ccPatch.disabled_commands = disabledCommands;
  if (platformAllowFrom !== undefined) ccPatch.platform_allow_from = platformAllowFrom;
  if (platformAllowChat !== undefined) ccPatch.platform_allow_chat = platformAllowChat;
  if (showContextIndicator !== undefined) ccPatch.show_context_indicator = showContextIndicator;
  if (replyFooter !== undefined) ccPatch.reply_footer = replyFooter;
  if (injectSender !== undefined) ccPatch.inject_sender = injectSender;

  let ccSyncError: string | null = null;
  let bindProject: string;
  try {
    bindProject = await dependencies.resolveProjectName(teamName);
  } catch {
    bindProject = teamName;
  }

  if (Object.keys(ccPatch).length > 0) {
    try {
      const updateResult = await cc.updateProject(
        bindProject,
        ccPatch as Parameters<HermitBridgeClient['updateProject']>[1]
      );
      if (updateResult.restart_required) {
        try {
          await cc.reload();
        } catch {
          // Best effort.
        }
      }
    } catch (error) {
      if (!isCcProjectNotFoundError(error)) {
        ccSyncError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  if (providerRefs !== undefined) {
    try {
      await cc.setProviderRefs(bindProject, providerRefs);
    } catch (error) {
      if (!isCcProjectNotFoundError(error)) {
        ccSyncError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (resetOnIdleMins !== undefined) {
    try {
      const { content: tomlRaw } = dependencies.readConfigTomlRaw();
      const projectPattern = new RegExp(
        `(\\[\\[projects\\]\\]\\s*\\n(?:[^\\[]*?)?name\\s*=\\s*"${escapeRegExp(bindProject)}"[^\\[]*?)(?=\\[\\[|$)`,
        's'
      );
      const projectMatch = projectPattern.exec(tomlRaw);
      if (projectMatch) {
        let section = projectMatch[1];
        if (/^reset_on_idle_mins\s*=/m.exec(section)) {
          section = section.replace(/^(reset_on_idle_mins\s*=\s*)\d+/m, `$1${resetOnIdleMins}`);
        } else {
          section = section.replace(
            /(\[\[projects\]\]\s*\n)/,
            `$1reset_on_idle_mins = ${resetOnIdleMins}\n`
          );
        }
        void dependencies.writeConfigTomlRaw(tomlRaw.replace(projectPattern, section));
        try {
          await cc.reload();
        } catch {
          // Best effort.
        }
      }
    } catch (error) {
      if (!ccSyncError) {
        ccSyncError = `reset_on_idle_mins: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  if (platformOptionsUpdate && Object.keys(platformOptionsUpdate).length > 0) {
    try {
      const { content: tomlRaw } = dependencies.readConfigTomlRaw();
      let updatedToml = tomlRaw;
      for (const [platformType, platformOptions] of Object.entries(platformOptionsUpdate)) {
        for (const [key, value] of Object.entries(platformOptions)) {
          const platformSection = new RegExp(
            `(\\[\\[projects\\.platforms\\]\\]\\s*\\ntype\\s*=\\s*"${platformType}"[^\\[]*?\\[projects\\.platforms\\.options\\]\\s*\\n)([^\\[]*)`,
            's'
          ).exec(updatedToml);
          if (!platformSection) continue;
          const optionContent = platformSection[2];
          const tomlValue = value === 'true' || value === 'false' ? value : `"${value}"`;
          if (new RegExp(`^${key}\\s*=`, 'm').exec(optionContent)) {
            updatedToml = updatedToml.replace(
              new RegExp(
                `(\\[\\[projects\\.platforms\\]\\]\\s*\\ntype\\s*=\\s*"${platformType}"[^\\[]*?\\[projects\\.platforms\\.options\\]\\s*\\n[^\\[]*?)^(${key}\\s*=\\s*).*$`,
                'ms'
              ),
              `$1$2${tomlValue}`
            );
          } else {
            updatedToml = updatedToml.replace(
              new RegExp(
                `(\\[\\[projects\\.platforms\\]\\]\\s*\\ntype\\s*=\\s*"${platformType}"[^\\[]*?\\[projects\\.platforms\\.options\\]\\s*\\n)`,
                's'
              ),
              `$1${key} = ${tomlValue}\n`
            );
          }
        }
      }
      if (updatedToml !== tomlRaw) {
        void dependencies.writeConfigTomlRaw(updatedToml);
        try {
          await cc.reload();
        } catch {
          // Best effort.
        }
      }
    } catch (error) {
      if (!ccSyncError) {
        ccSyncError = `platformOptions: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  return {
    name: name || teamName,
    displayName: name || teamName,
    description: description || undefined,
    color: color || undefined,
    projectPath: workDir || undefined,
    agentType: agentType || undefined,
    permissionMode: permissionMode || undefined,
    language: language || undefined,
    managedSources: managedSources || undefined,
    disabledCommands: disabledCommands ?? [],
    showContextIndicator: showContextIndicator ?? false,
    replyFooter: replyFooter ?? false,
    injectSender: injectSender ?? false,
    platformAllowFrom: platformAllowFrom ?? {},
    platformAllowChat: platformAllowChat ?? {},
    providerRefs: providerRefs ?? [],
    ccSyncError,
  };
}

function registerCoreRoutes(app: FastifyInstance, dependencies: TeamConfigRouteDependencies): void {
  const svc = dependencies.teamProvisioning;
  const cc = dependencies.bridgeClient;

  app.get<{ Params: { name: string } }>('/api/teams/:name/config', async (request, reply) => {
    try {
      const name = request.params.name;
      const bindProject = await dependencies.resolveProjectName(name);
      const project = await cc.getProject(bindProject);
      let color = 'blue';
      let description = '';
      let language = '';
      let managedSources = '*';
      let disabledCommands: string[] = [];
      let showContextIndicator = false;
      let replyFooter = false;
      let injectSender = false;
      let permissionMode = 'default';
      let platformAllowFrom: Record<string, string> = {};
      let platformAllowChat: Record<string, string> = {};
      try {
        const meta = await svc.readTeamManifest(name);
        color = meta.color ?? color;
        description = meta.description ?? description;
        language = meta.language ?? language;
        managedSources = meta.managedSources ?? managedSources;
        disabledCommands = normalizeStringArray(meta.disabledCommands);
        showContextIndicator = meta.showContextIndicator ?? showContextIndicator;
        replyFooter = meta.replyFooter ?? replyFooter;
        injectSender = meta.injectSender ?? injectSender;
        permissionMode = meta.permissionMode ?? permissionMode;
        platformAllowFrom = normalizePlatformAllowFrom(meta.platformAllowFrom);
        platformAllowChat = normalizePlatformAllowFrom(meta.platformAllowChat);
      } catch {
        // Local metadata is optional.
      }
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
      const normalizedDisabled = normalizeStringArray(projectSettings.disabled_commands);
      const resolvedDisabledCommands =
        Array.isArray(projectSettings.disabled_commands) && normalizedDisabled.length > 0
          ? normalizedDisabled
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
      let resetOnIdleMins: number | undefined;
      const platformOptions: Record<string, Record<string, string>> = {};
      try {
        const { content: tomlRaw } = dependencies.readConfigTomlRaw();
        const projectPattern = new RegExp(
          `\\[\\[projects\\]\\]\\s*\\n(?:[^\\[]*?)?name\\s*=\\s*"${escapeRegExp(bindProject)}"[^\\[]*?(?=\\[\\[projects\\]\\]|$)`,
          's'
        );
        const projectSection = projectPattern.exec(tomlRaw);
        if (projectSection) {
          const section = projectSection[0];
          const idleMatch = /^reset_on_idle_mins\s*=\s*(\d+)/m.exec(section);
          if (idleMatch) resetOnIdleMins = Number(idleMatch[1]);
          const platformBlocks = section.matchAll(
            /\[\[projects\.platforms\]\]\s*\n([^\[]*?)(?=\[\[|$)/gs
          );
          for (const block of platformBlocks) {
            const content = block[1];
            const typeMatch = /^type\s*=\s*"([^"]*)"/m.exec(content);
            if (!typeMatch) continue;
            const platformType = typeMatch[1];
            const parsedOptions: Record<string, string> = {};
            const optionSection = /\[projects\.platforms\.options\]\s*\n([^\[]*?)(?=\[|$)/s.exec(
              content
            );
            if (optionSection) {
              for (const line of optionSection[1].split('\n')) {
                const keyValue = /^\s*(\w+)\s*=\s*(?:"([^"]*)"|(\w+))/.exec(line);
                if (keyValue) parsedOptions[keyValue[1]] = keyValue[2] ?? keyValue[3];
              }
            }
            if (Object.keys(parsedOptions).length > 0) {
              platformOptions[platformType] = {
                ...platformOptions[platformType],
                ...parsedOptions,
              };
            }
          }
        }
      } catch {
        // TOML may not exist.
      }
      return {
        name,
        color,
        projectPath: project.work_dir || '',
        description,
        agentType: project.agent_type,
        workDir: project.work_dir ?? '',
        language: resolvedLanguage,
        managedSources: resolvedManagedSources,
        disabledCommands: resolvedDisabledCommands,
        showContextIndicator: resolvedShowContextIndicator,
        replyFooter: resolvedReplyFooter,
        injectSender: resolvedInjectSender,
        permissionMode: resolvedPermissionMode,
        platformAllowFrom: resolvedPlatformAllowFrom,
        platformAllowChat: resolvedPlatformAllowChat,
        providerRefs,
        globalProviders,
        resetOnIdleMins,
        platformOptions,
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
      };
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  app.patch<{ Params: { name: string } }>('/api/teams/:name/config', async (request, reply) => {
    try {
      return await applyTeamConfigUpdate(
        request.params.name,
        (request.body as Record<string, unknown>) ?? {},
        dependencies
      );
    } catch (error) {
      return reply.code(400).send(dependencies.reply500(error));
    }
  });
}

function registerPutRoute(app: FastifyInstance, dependencies: TeamConfigRouteDependencies): void {
  app.put<{ Params: { name: string } }>('/api/teams/:name/config', async (request, reply) => {
    try {
      return await applyTeamConfigUpdate(
        request.params.name,
        (request.body as Record<string, unknown>) ?? {},
        dependencies
      );
    } catch (error) {
      return reply.code(400).send(dependencies.reply500(error));
    }
  });
}

export function registerTeamConfigRoutes(
  app: FastifyInstance,
  dependencies: TeamConfigRouteDependencies,
  options: TeamConfigRouteOptions = {}
): void {
  const routes = new Set(options.routes ?? ['core', 'put']);
  if (routes.has('core')) registerCoreRoutes(app, dependencies);
  if (routes.has('put')) registerPutRoute(app, dependencies);
}
