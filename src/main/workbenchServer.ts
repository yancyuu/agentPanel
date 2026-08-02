import { timingSafeEqual } from 'node:crypto';

import cors from '@fastify/cors';
import {
  AdvancedConnectionService,
  registerAdvancedConnectionRoutes,
} from '@features/advanced-connections/main';
import {
  CollaborationOrchestrator,
  CollaborationWorkspaceService,
  registerCollaborationRoutes,
} from '@features/team-collaboration/main';
import { DEFAULT_OPENHERMIT_CLOUD_BASE_URL } from '@shared/constants/cloudConfig.mjs';
import { DESKTOP_SESSION_HEADER } from '@shared/constants/desktop';
import Fastify from 'fastify';

import {
  getCapabilityPacks,
  setCapabilityPackLocalSource,
  setSkillsWatcherEmitter,
} from './ipc/extensions';
import { registerAppConfigRoutes } from './routes/appConfigRoutes';
import { registerBridgeConfigRoutes } from './routes/bridgeConfigRoutes';
import { registerBridgeProxyRoutes } from './routes/bridgeProxyRoutes';
import { registerCapabilityPackRoutes } from './routes/capabilityPackRoutes';
import { registerCommentReadStateRoutes } from './routes/commentReadStateRoutes';
import { registerConversationTelemetryRoutes } from './routes/conversationTelemetryRoutes';
import { registerEditorRoutes } from './routes/editorRoutes';
import { registerExtensionCredentialRoutes } from './routes/extensionCredentialRoutes';
import { registerExtensionMcpStoreRoutes } from './routes/extensionMcpStoreRoutes';
import { registerExtensionPluginRoutes } from './routes/extensionPluginRoutes';
import { registerExtensionSkillRoutes } from './routes/extensionSkillRoutes';
import { registerGraphRoutes } from './routes/graphRoutes';
import { registerHarnessRoutes } from './routes/harnessRoutes';
import { registerHeartbeatRoutes } from './routes/heartbeatRoutes';
import { registerHermitConfigRoutes } from './routes/hermitConfigRoutes';
import { registerMcpRoutes } from './routes/mcpRoutes';
import { registerWorkbenchNotFoundHandler } from './routes/notFoundHandler';
import { registerPlatformSetupRoutes } from './routes/platformSetupRoutes';
import { registerReviewCompatibilityRoutes } from './routes/reviewCompatibilityRoutes';
import { registerRuntimeRoutes } from './routes/runtimeRoutes';
import { registerScheduleRoutes } from './routes/scheduleRoutes';
import { registerSseRoutes } from './routes/sseRoutes';
import { registerStaticRoutes } from './routes/staticRoutes';
import { registerSystemManagerRoutes } from './routes/systemManagerRoutes';
import { registerTaskBusSettingsRoutes } from './routes/taskBusSettingsRoutes';
import {
  registerTeamActionCompatibilityRoutes,
  registerTeamCompatibilityRoutes,
  registerTeamMemberCompatibilityRoutes,
  registerTeamMemberStatsRoutes,
  registerTeamProvisioningCompatibilityRoutes,
} from './routes/teamCompatibilityRoutes';
import { registerTeamConfigRoutes } from './routes/teamConfigRoutes';
import { registerFeishuAssistantRoutes } from './routes/feishuAssistantRoutes';
import { registerTeamAssetRoutes } from './routes/teamAssetRoutes';
import { registerTeamDirectoryRoutes } from './routes/teamDirectoryRoutes';
import { registerTeamMessageRoutes } from './routes/teamMessageRoutes';
import { CC_AGENT_TYPES } from './routes/teamRouteUtils';
import { registerTeamRuntimeRoutes } from './routes/teamRuntimeRoutes';
import { registerTeamSessionRoutes } from './routes/teamSessionRoutes';
import { registerTeamTaskRoutes } from './routes/teamTaskRoutes';
import { registerTerminalRoutes } from './routes/terminalRoutes';
import { registerToolApprovalRoutes } from './routes/toolApprovalRoutes';
import { createUsageTelemetryPresenter } from './routes/usageTelemetryPresenter';
import {
  readTaskBusSettingsFromFile,
  registerUsageTelemetryRoutes,
  registerUsageTelemetryStatusRoutes,
} from './routes/usageTelemetryRoutes';
import { registerVersionUpdateRoutes } from './routes/versionUpdateRoutes';
import { registerWorkbenchStatusRoutes } from './routes/workbenchStatusRoutes';
import { registerWorkerRoutes } from './routes/workerRoutes';
import { registerWorkspaceRoutes } from './routes/workspaceRoutes';
import { resolveLoopbackWorkbenchUrl } from './services/agentcli/workbenchRuntimeEnv';
import { buildTeamCapabilityTelemetrySnapshots } from './services/extensions/capability-packs/CapabilityPackLoaderService';
import {
  getTelemetryRuntimeStatus,
  getTelemetryStatus,
  startTelemetry,
  stopTelemetry,
  triggerScan,
} from './services/session-intelligence/UsageTelemetryService';
import { DEFAULT_HERMIT_CC_SETTINGS } from './services/settings/HermitCcSettingsService';
import { getRuntimeReadiness } from './services/system/RuntimeReadiness';
import { ensureGlobalWorkflows } from './services/system-manager/BuiltinWorkflowSeeder';
import { SystemDiagnosticRunService } from './services/system-manager/SystemDiagnosticRunService';
import { WorkspaceCleanupService } from './services/system-manager/WorkspaceCleanupService';
import { ClaudeBinaryResolver } from './services/team/ClaudeBinaryResolver';
import { CommentReadStateService } from './services/team-management/CommentReadStateService';
import {
  ensureOpenspecProject,
  pointerFileForHarness,
} from './services/team-management/openspecProject';
import { ensureOpenspecWrapperCommand } from './services/team-management/openspecRuntime';
import {
  getPiRuntimeStatus,
  refreshPiRuntimeStatus,
} from './services/system-manager/PiRuntimeStatus';
import { materializeTaskInputs } from './services/team-management/TaskInputMaterializer';
import { readUsageTelemetryWorkerStatus } from './telemetry/worker';
import { createServerOperations } from './serverOperations';
import { createWorkbenchShutdown } from './serverProcessLifecycle';

import type { HermitBridgeAgentType } from '../shared/types/hermitBridge';
import type { DirectCliMessageInput } from './routes/teamRuntimeRoutes';
import type { HermitConfig, HermitConfigStore, ServerEnvironment } from './serverConfig';
import type { ServerContext } from './serverContext';
import type { ServerOperations } from './serverOperations';
import type { TeamProvisioningService } from './services/team-management';
import type { AppendGroupMessageInput } from './services/team-management/TeamWorkspaceService';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

export interface WorkbenchServerOptions {
  environment: ServerEnvironment;
  configStore: HermitConfigStore;
  getRuntimeConfig: () => HermitConfig;
  updateRuntimeConfig: (config: HermitConfig) => void;
  setRestartBridge?: (restart: () => Promise<void>) => void;
  fastifyOptions?: FastifyServerOptions;
  appFactory?: (options: FastifyServerOptions) => FastifyInstance;
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

export interface WorkbenchServer {
  app: FastifyInstance;
  context: ServerContext;
  operations: ServerOperations;
  shutdown: () => Promise<void>;
  initializeTelemetryFromSettings: () => Promise<void>;
  ensureGlobalWorkflows: () => Promise<unknown>;
}

const serversByContext = new WeakMap<ServerContext, Promise<WorkbenchServer>>();

export function createWorkbenchServer(
  context: ServerContext,
  options: WorkbenchServerOptions
): Promise<WorkbenchServer> {
  const existing = serversByContext.get(context);
  if (existing) return existing;
  const listenerStartIndex = context.lifecycle.listenerDisposers.length;
  const creation = createWorkbenchServerUncached(context, options).catch((error) => {
    const addedDisposers = context.lifecycle.listenerDisposers.splice(listenerStartIndex);
    for (const dispose of addedDisposers) dispose();
    serversByContext.delete(context);
    throw error;
  });
  serversByContext.set(context, creation);
  return creation;
}

async function createWorkbenchServerUncached(
  context: ServerContext,
  options: WorkbenchServerOptions
): Promise<WorkbenchServer> {
  const { environment, configStore } = options;
  const app = (options.appFactory ?? Fastify)({
    logger: { level: environment.logLevel },
    disableRequestLogging: true,
    ...options.fastifyOptions,
  });
  if (options.onRoute) {
    app.addHook('onRoute', (routeOptions) => {
      options.onRoute?.({ method: routeOptions.method, url: routeOptions.url });
    });
  }
  const operations = createServerOperations({
    context,
    environment,
    logger: app.log,
    startTelemetry,
    setRestartBridge: options.setRestartBridge,
  });
  const { services, state } = context;
  const svc = services.teamProvisioning;
  const cc = services.bridgeClient;
  const collaborationWorkspace = new CollaborationWorkspaceService(environment.hermitHome);
  // agent 会话的 openspec 命令入口（~/.hermit/bin/openspec，幂等安装）
  ensureOpenspecWrapperCommand(environment.hermitHome);
  const collaborationOrchestrator = new CollaborationOrchestrator({
    workspace: collaborationWorkspace,
    teams: svc,
    directCli: services.directCli,
    workbenchUrl: resolveLoopbackWorkbenchUrl(environment.host, environment.port),
    dispatchAgentMessage: (params) =>
      operations.teamRuntimeOperations.dispatchDirectCliMessage(params),
    broadcastRunChange: (runId) =>
      operations.broadcastSse('team-change', { type: 'collaboration-run', runId }),
  });
  context.lifecycle.listenerDisposers.push(() => collaborationOrchestrator.dispose());
  const interruptedCollaborationRuns = await collaborationOrchestrator.recoverInterruptedRuns();
  if (interruptedCollaborationRuns.length > 0) {
    app.log.warn(
      { runIds: interruptedCollaborationRuns },
      'automatically resumed interrupted collaboration runs after service restart'
    );
  }
  const diagnosticRuns = new SystemDiagnosticRunService({
    hermitHome: environment.hermitHome,
    directCli: services.directCli,
    ensureSystemManager: operations.ensureSystemManager,
    dispatchMessage: (params) => operations.teamRuntimeOperations.dispatchDirectCliMessage(params),
    broadcast: (run) =>
      operations.broadcastSse('team-change', { type: 'diagnostic-run', runId: run.id }),
  });
  context.lifecycle.listenerDisposers.push(() => diagnosticRuns.dispose());

  const buildAdvancedConnectionLocalSnapshot = async () => {
    const manifests = (await svc.listTeams()).filter((manifest) => !manifest.deletedAt);
    const taskGroups = await Promise.all(
      manifests.map(async (manifest) => ({
        teamSlug: manifest.slug,
        tasks: await svc.readTasks(manifest.slug),
      }))
    );
    const persistedTelemetry = await readUsageTelemetryWorkerStatus(environment.hermitHome);
    const localTelemetry =
      (await getTelemetryStatus()) ??
      (await triggerScan({
        enabled: false,
        telemetry: {
          enabled: true,
          platform: 'claudecode',
          uploadProviders: ['claudecode', 'codex'],
          conversationUploadEnabled: false,
        },
      }));
    const capabilityPacks = await getCapabilityPacks().list();
    return {
      generatedAt: new Date().toISOString(),
      teams: manifests.map((manifest) => ({
        slug: manifest.slug,
        displayName: manifest.displayName,
        description: manifest.description,
        harness: manifest.harness,
        online: true,
      })),
      tasks: taskGroups.flatMap(({ teamSlug, tasks }) =>
        tasks
          .filter((task) => task.taskKind !== 'subtask')
          .map((task) => ({
            id: task.id,
            teamSlug,
            title: task.title,
            status: task.status,
            updatedAt: task.updatedAt,
          }))
      ),
      usage: (localTelemetry ?? persistedTelemetry) as unknown as Record<string, unknown>,
      capabilities: capabilityPacks.packs.map((pack) => ({
        id: pack.manifest.id,
        name: pack.manifest.name,
        description: pack.manifest.description,
      })),
    };
  };

  const advancedConnections = new AdvancedConnectionService({
    hermitHome: environment.hermitHome,
    onAuthenticated: async (connectionId) => {
      await advancedConnections.syncAuthorizedData(
        connectionId,
        await buildAdvancedConnectionLocalSnapshot()
      );
    },
  });
  if (process.env.NODE_ENV !== 'test') {
    await advancedConnections
      .ensureDefaultConnection(DEFAULT_OPENHERMIT_CLOUD_BASE_URL)
      .catch((error) => app.log.warn({ err: error }, 'default AgentBus provisioning failed'));
  }

  let usageSyncRunning = false;
  const usageSyncTimer = setInterval(
    () => {
      if (usageSyncRunning) return;
      usageSyncRunning = true;
      void advancedConnections
        .list()
        .then(async (connections) => {
          const eligible = connections.filter(
            (connection) =>
              ['authenticated', 'ready', 'connected'].includes(connection.state) &&
              connection.permissions['usage.aggregates'] === 'granted'
          );
          if (eligible.length === 0) return;
          const snapshot = await buildAdvancedConnectionLocalSnapshot();
          await Promise.allSettled(
            eligible.map((connection) =>
              advancedConnections.syncAuthorizedData(connection.id, snapshot)
            )
          );
        })
        .finally(() => {
          usageSyncRunning = false;
        });
    },
    5 * 60 * 1000
  );
  usageSyncTimer.unref();
  context.lifecycle.listenerDisposers.push(() => clearInterval(usageSyncTimer));

  const commentReadState = new CommentReadStateService(environment.hermitHome);
  const workspaceCleanup = new WorkspaceCleanupService({ hermitHome: environment.hermitHome });

  await app.register(cors, {
    origin: environment.allowedCorsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  const desktopSessionToken = environment.desktopSessionToken;
  app.addHook('preHandler', async (request, reply) => {
    if (desktopSessionToken) {
      const rawToken = request.headers[DESKTOP_SESSION_HEADER];
      const presentedToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
      const expected = Buffer.from(desktopSessionToken);
      const presented = Buffer.from(typeof presentedToken === 'string' ? presentedToken : '');
      if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
        return reply.code(401).send({ ok: false, error: 'Desktop session required' });
      }
    }
    const rawOrigin: unknown = request.headers.origin;
    const origin = Array.isArray(rawOrigin)
      ? typeof rawOrigin[0] === 'string'
        ? rawOrigin[0]
        : undefined
      : typeof rawOrigin === 'string'
        ? rawOrigin
        : undefined;
    if (origin && !operations.isTrustedBrowserOrigin(origin)) {
      return reply.code(403).send({ ok: false, error: 'Forbidden origin' });
    }
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'agentcli-workbench',
    version: environment.version,
  }));

  registerAdvancedConnectionRoutes(app, {
    service: advancedConnections,
    localSnapshot: buildAdvancedConnectionLocalSnapshot,
  });
  registerCommentReadStateRoutes(app, { service: commentReadState });
  registerCollaborationRoutes(app, {
    workspace: collaborationWorkspace,
    orchestrator: collaborationOrchestrator,
    teams: svc,
  });
  registerBridgeProxyRoutes(app, {
    getRuntimeConfig: () => ({
      ccBaseUrl: options.getRuntimeConfig().ccBaseUrl,
      ccToken: options.getRuntimeConfig().ccToken,
    }),
  });
  registerHermitConfigRoutes(app, {
    getConfig: options.getRuntimeConfig,
    saveConfig: (patch) => {
      const config = configStore.save(patch);
      options.updateRuntimeConfig(config);
      return config;
    },
    readRaw: () => configStore.readRaw(),
    writeRaw: (content) => {
      const config = configStore.writeRaw(content);
      options.updateRuntimeConfig(config);
      return config;
    },
    updateBridgeClient: (config) => services.bridgeClient.updateConfig(config),
    updateBridgeConnection: (config) => services.bridgeConnection.updateConfig(config),
  });
  registerBridgeConfigRoutes(app, {
    readRaw: () => configStore.readBridgeRaw(),
    writeRaw: (content) => configStore.writeBridgeRaw(content),
  });
  registerRuntimeRoutes(app, {
    getStatus: () => cc.getStatus(),
    getRuntimeReadiness,
    readEffectiveSettings: operations.readEffectiveCcSettings,
    patchLocalSettings: (patch) => services.ccSettings.patch(patch),
    patchRemoteSettings: (patch) => cc.patchGlobalSettings(patch),
    defaultSettings: DEFAULT_HERMIT_CC_SETTINGS,
    restartBridge: operations.restartBridge,
    reloadBridge: () => cc.reload(),
    logger: app.log,
  });
  registerSystemManagerRoutes(app, {
    ensureSystemManager: operations.ensureSystemManager,
    ensureAdminLoopInitialized: operations.ensureAdminLoopInitialized,
    systemManagerConfig: services.systemManagerConfig,
    diagnosticRuns,
    workspaceCleanup,
    workflowPrompt: services.workflowPrompt,
    assertTrustedBrowserOrigin: operations.assertTrustedBrowserOrigin,
    getPiRuntimeStatus: () => getPiRuntimeStatus({ hermitHome: environment.hermitHome }),
    refreshPiRuntimeStatus: () => refreshPiRuntimeStatus({ hermitHome: environment.hermitHome }),
  });
  registerTerminalRoutes(app, {
    assertTrustedBrowserOrigin: operations.assertTrustedBrowserOrigin,
    getSessionId: (sessionKey) => services.directCli.getSessionId(sessionKey),
    resolveWorkDir: (teamName) =>
      operations.teamRuntimeOperations.resolveDirectCliWorkDir(teamName),
    resolveClaudeBinary: () => ClaudeBinaryResolver.resolve(),
  });
  registerTeamDirectoryRoutes(
    app,
    {
      teamProvisioning: svc,
      bridgeClient: cc,
      resolveProjectName: operations.resolveRouteCcProjectName,
      getProjectStatsSnapshot: operations.getProjectStatsSnapshot,
      reply500: operations.reply500,
    },
    { routes: ['core'] }
  );

  const teamTaskRouteDependencies = {
    readTasks: (teamName: string) => svc.readTasks(teamName),
    createTask: (teamName: string, payload: Parameters<TeamProvisioningService['createTask']>[1]) =>
      svc.createTask(teamName, payload),
    patchTask: (
      teamName: string,
      taskId: string,
      patch: Parameters<TeamProvisioningService['patchTask']>[2]
    ) => svc.patchTask(teamName, taskId, patch),
    addDelivery: (
      teamName: string,
      taskId: string,
      input: Parameters<TeamProvisioningService['addDelivery']>[2]
    ) => svc.addDelivery(teamName, taskId, input),
    addFeedbackItem: (
      teamName: string,
      taskId: string,
      input: Parameters<TeamProvisioningService['addFeedbackItem']>[2]
    ) => svc.addFeedbackItem(teamName, taskId, input),
    appendTaskHistoryEvent: (
      teamName: string,
      taskId: string,
      event: Parameters<TeamProvisioningService['appendTaskHistoryEvent']>[2]
    ) => svc.appendTaskHistoryEvent(teamName, taskId, event),
    dispatchTask: async (
      teamName: string,
      task: Parameters<TeamProvisioningService['dispatchTask']>[1]
    ) => {
      if (!task.assignee) return;
      const targetTeamName = task.assigneeAgentId?.trim() || teamName;
      const workDir = await operations.teamRuntimeOperations
        .resolveDirectCliWorkDir(targetTeamName)
        .catch(() => '');
      if (!workDir) {
        await svc.dispatchTask(teamName, task);
        return;
      }
      const inputs = await materializeTaskInputs(task, workDir);
      const inputSummary = inputs.map((input) => `- ${input.filename}: ${input.path}`).join('\n');
      const openFeedback = (task.feedbackItems ?? [])
        .filter((item) => item.status === 'open')
        .map((item) => `- ${item.text}`)
        .join('\n');
      const hermitHome = process.env.HERMIT_HOME ?? `${process.env.HOME ?? '~'}/.hermit`;
      const cliPath = `${hermitHome}/bin/agentcli`;
      const taskCommand = `${JSON.stringify(cliPath)} --port ${process.env.PORT ?? '5680'} tasks`;
      const text = [
        `/goal 请执行任务：${task.title}`,
        `任务 ID：${task.id}`,
        task.description ? `描述：${task.description}` : null,
        task.prompt ? `补充要求：${task.prompt}` : null,
        inputSummary
          ? `用户提供的本地输入文件已经复制到当前项目的 input/${task.id}/ 目录：\n${inputSummary}\n请先读取这些文件，再开始处理任务。`
          : null,
        openFeedback ? `待处理的修改意见：\n${openFeedback}` : null,
        '',
        '请使用内置 AgentCLI 更新任务状态，不要使用其他任务系统：',
        `${taskCommand} claim --team ${targetTeamName} --id ${task.id}`,
        `${taskCommand} clarify --team ${targetTeamName} --id ${task.id} --target user`,
        `${taskCommand} complete --team ${targetTeamName} --id ${task.id} --result "交付结果"`,
        '',
        '如果信息不足：先标记等待用户回复（clarify --target user）并停止执行，说明还需要什么信息。收到用户回复后继续。完成后必须提交交付结果。',
      ]
        .filter((line): line is string => line !== null)
        .join('\n');
      await operations.teamRuntimeOperations.dispatchDirectCliMessage({
        teamName: targetTeamName,
        sessionKey: `${targetTeamName}:task:${task.id}`,
        workDir,
        from: task.assignee,
        to: 'user',
        text,
        messageId: `task-${task.id}-${Date.now()}`,
        conversationId: `task:${task.id}`,
      });
    },
    listProjects: () => cc.listProjects(),
    listTeams: () => svc.listTeams(),
    readTeamManifest: (teamName: string) => svc.readTeamManifest(teamName),
    broadcastTaskChange: (teamName: string, taskId: string) =>
      operations.broadcastSse('team-change', { type: 'task', teamName, taskId }),
    appendInboxMessage: (teamName: string, input: AppendGroupMessageInput) =>
      svc.appendMessage(teamName, input),
    readInboxMessages: async (teamName: string) => svc.readMessages(teamName, { limit: 5000 }),
    broadcastInboxChange: (teamName: string) =>
      operations.broadcastSse('team-change', { type: 'inbox', teamName }),
    requestCollaborationChanges: (
      runId: string,
      feedback: string,
      beforeStart?: () => Promise<void>
    ) => collaborationOrchestrator.requestChanges(runId, feedback, beforeStart),
    reply500: operations.reply500,
  };
  registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['core'] });

  registerFeishuAssistantRoutes(app);

  registerTeamAssetRoutes(app, {
    readTeamManifest: (teamName: string) => svc.readTeamManifest(teamName),
    ensureAssetsProject: async (workDir: string, harness?: string) => {
      const command = ensureOpenspecWrapperCommand(environment.hermitHome);
      if (command) {
        await ensureOpenspecProject(workDir, command, {
          pointerFile: harness ? pointerFileForHarness(harness) : undefined,
        });
      }
    },
    reply500: operations.reply500,
  });

  const teamRuntimeRouteDependencies = {
    teamProvisioning: svc,
    bridgeClient: cc,
    loopAssetsScanner: services.loopAssetsScanner,
    directCliManager: services.directCli,
    operations: operations.teamRuntimeOperations,
    resolveProjectName: operations.resolveRouteCcProjectName,
    restartBridge: operations.restartBridge,
    reply500: operations.reply500,
  };
  registerTeamRuntimeRoutes(app, teamRuntimeRouteDependencies, { routes: ['collaboration'] });
  registerHeartbeatRoutes(app, {
    bridgeClient: cc,
    resolveProjectName: operations.resolveRouteCcProjectName,
  });
  registerHarnessRoutes(app, {
    agentTypes: CC_AGENT_TYPES,
    listProjects: () => cc.listProjects(),
    packagedDesktop: process.env.AGENTCLI_PACKAGED_DESKTOP === '1',
  });
  registerTeamRuntimeRoutes(app, teamRuntimeRouteDependencies, { routes: ['runtime'] });
  registerPlatformSetupRoutes(app, {
    getRuntimeConfig: () => ({
      ccBaseUrl: options.getRuntimeConfig().ccBaseUrl,
      ccToken: options.getRuntimeConfig().ccToken,
    }),
    persistPlatformMetadata: operations.persistPlatformRoutingMetadataForProject,
    restartBridge: operations.restartBridge,
    getProject: (projectName) => cc.getProject(projectName),
    createProject: (projectName, agentType, workDir, platformType, platformOptions) =>
      cc.createProject(
        projectName,
        agentType as HermitBridgeAgentType,
        workDir,
        platformType,
        platformOptions
      ),
  });
  registerGraphRoutes(app, {
    listProjects: () => cc.listProjects(),
    readTasks: (teamName) => svc.readTasks(teamName),
  });
  registerMcpRoutes(
    app,
    {
      readTasks: (teamSlug) => svc.readTasks(teamSlug),
      createTask: (teamSlug, payload) => svc.createTask(teamSlug, payload),
      patchTask: (teamSlug, taskId, patch) => svc.patchTask(teamSlug, taskId, patch),
      addDelivery: (teamSlug, taskId, input) => svc.addDelivery(teamSlug, taskId, input),
      addFeedbackItem: (teamSlug, taskId, input) => svc.addFeedbackItem(teamSlug, taskId, input),
      appendTaskHistoryEvent: (teamSlug, taskId, event) =>
        svc.appendTaskHistoryEvent(teamSlug, taskId, event),
    },
    {
      appendMessage: (teamSlug, input) => svc.appendMessage(teamSlug, input),
      broadcastInboxChange: (teamName) =>
        operations.broadcastSse('team-change', { type: 'inbox', teamName }),
    }
  );
  registerVersionUpdateRoutes(app, {
    version: environment.version,
    updateService: services.update,
  });
  registerWorkbenchStatusRoutes(app, {
    loadRecentProjects: operations.dashboardRecentProjectsLoader,
  });
  registerAppConfigRoutes(app, {
    configFile: environment.hermitAppConfigFile,
    hermitHome: environment.hermitHome,
    logger: app.log,
  });
  registerScheduleRoutes(app, {
    state,
    bridgeClient: cc,
    readTeamManifest: (teamName) => svc.readTeamManifest(teamName),
    broadcastSse: operations.broadcastSse,
    buildFallbackSessionKey: operations.buildFallbackSessionKey,
    reply500: operations.reply500,
  });
  registerWorkspaceRoutes(app);
  registerEditorRoutes(app);

  const teamMessageRouteDependencies = {
    readMessages: (teamName: string, messageOptions: { limit?: number }) =>
      svc.readMessages(teamName, messageOptions),
    appendMessage: (
      teamName: string,
      message: Parameters<TeamProvisioningService['appendMessage']>[1]
    ) => svc.appendMessage(teamName, message),
    resolveProjectName: operations.resolveRouteCcProjectName,
    listSessions: (projectName: string) => cc.listSessions(projectName),
    buildFallbackSessionKey: operations.buildFallbackSessionKey,
    sendHarnessMessageViaBridge: operations.sendHarnessMessageViaBridge,
    readEffectiveCcSettings: operations.readEffectiveCcSettings,
    resolveDirectCliWorkDir: (teamName: string) =>
      operations.teamRuntimeOperations.resolveDirectCliWorkDir(teamName),
    dispatchDirectCliMessage: (params: DirectCliMessageInput) =>
      operations.teamRuntimeOperations.dispatchDirectCliMessage(params),
    broadcastSse: operations.broadcastSse,
  };
  registerTeamMessageRoutes(app, teamMessageRouteDependencies, { routes: ['read'] });
  registerTeamSessionRoutes(app, {
    readTeamManifest: (teamName) => svc.readTeamManifest(teamName),
    readHiddenSessionIds: (teamName) => svc.readHiddenSessionIds(teamName),
    hideSession: (teamName, sessionId) => svc.hideSession(teamName, sessionId),
    listTeams: () => svc.listTeams(),
    scanSummaries: (workDir, projectId) =>
      services.localSessionScanner.scanSummaries(workDir, projectId),
    readSessionDetail: (workDir, sessionId, sessionOptions) =>
      services.localSessionScanner.readSessionDetail(workDir, sessionId, sessionOptions),
    listSessions: (projectName) => cc.listSessions(projectName),
    getSession: (projectName, sessionId, historyLimit) =>
      cc.getSession(projectName, sessionId, historyLimit),
    deleteSession: (projectName, sessionId) => cc.deleteSession(projectName, sessionId),
    listProjects: () => cc.listProjects(),
    getProject: (projectName) => cc.getProject(projectName),
    resolveProjectName: operations.resolveRouteCcProjectName,
  });
  registerTeamMessageRoutes(app, teamMessageRouteDependencies, { routes: ['process'] });
  registerTeamCompatibilityRoutes(app);
  registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['compatibility'] });
  registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['actions'] });
  registerTeamMemberCompatibilityRoutes(app);
  registerTeamDirectoryRoutes(
    app,
    {
      teamProvisioning: svc,
      bridgeClient: cc,
      resolveProjectName: operations.resolveRouteCcProjectName,
      getProjectStatsSnapshot: operations.getProjectStatsSnapshot,
      reply500: operations.reply500,
    },
    { routes: ['restore'] }
  );

  const teamConfigRouteDependencies = {
    teamProvisioning: svc,
    bridgeClient: cc,
    resolveProjectName: operations.resolveRouteCcProjectName,
    readConfigTomlRaw: () => configStore.readBridgeRaw(),
    writeConfigTomlRaw: (content: string) => configStore.writeBridgeRaw(content),
    reply500: operations.reply500,
    agentTypes: CC_AGENT_TYPES,
  };
  registerTeamConfigRoutes(app, teamConfigRouteDependencies, { routes: ['core'] });
  registerTeamProvisioningCompatibilityRoutes(app);
  registerTeamMessageRoutes(app, teamMessageRouteDependencies, { routes: ['send'] });
  registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['review-aliases'] });
  registerTeamConfigRoutes(app, teamConfigRouteDependencies, { routes: ['put'] });
  registerTeamActionCompatibilityRoutes(app, { routes: ['member-skip'] });
  registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['late-aliases'] });
  registerTeamActionCompatibilityRoutes(app, { routes: ['remaining'] });
  registerTeamMemberStatsRoutes(app, {
    readTeamManifest: (teamName) => svc.readTeamManifest(teamName),
    scanSummaries: (workDir, projectId) =>
      services.localSessionScanner.scanSummaries(workDir, projectId),
    readTasksForStats: (teamName) => {
      // eslint-disable-next-line @typescript-eslint/dot-notation -- intentionally bypass private workspace modifier
      return svc['workspace'].readTasks(teamName);
    },
  });
  registerToolApprovalRoutes(app, {
    state,
    respondPermission: (sessionKey, requestId, allow, message, updatedInput) =>
      services.directCli.respondPermission(sessionKey, requestId, allow, message, updatedInput),
    logger: app.log,
  });
  registerWorkerRoutes(app, {
    discoverTeams: () => svc.discoverTeams(),
    resolveTeamSlugForMention: operations.resolveTeamSlugForMention,
    ensureLoopSessionProjectReady: (teamName) =>
      operations.teamRuntimeOperations.ensureLoopSessionProjectReady(teamName),
    listSessions: (projectName) => cc.listSessions(projectName),
    createSession: (projectName, name, sessionKey) =>
      cc.createSession(projectName, name, sessionKey),
    sendHarnessMessageViaBridge: operations.sendHarnessMessageViaBridge,
    appendMessage: (teamSlug, message) => svc.appendMessage(teamSlug, message),
    broadcastSse: operations.broadcastSse,
    buildFallbackSessionKey: operations.buildFallbackSessionKey,
  });
  registerTaskBusSettingsRoutes(app, {
    settingsFile: environment.hermitSettingsFile,
    bridgeClient: cc,
    teamProvisioning: svc,
    isExternalTelemetryWorkerRunning: operations.isExternalTelemetryWorkerRunning,
    startTelemetry,
    stopTelemetry,
  });

  const usageTelemetryPresenter = createUsageTelemetryPresenter({
    listTeams: () => svc.listTeams(),
    loadCapabilitySnapshots: async () => {
      const listResult = await getCapabilityPacks().list();
      return buildTeamCapabilityTelemetrySnapshots(listResult.packs);
    },
    getRuntimeStatus: getTelemetryRuntimeStatus,
    warn: (error, message) => app.log.warn({ err: error }, message),
  });
  const usageTelemetryRouteDependencies = {
    presenter: usageTelemetryPresenter,
    readTaskBusSettings: () => readTaskBusSettingsFromFile(environment.hermitSettingsFile),
    triggerScan,
    getTelemetryStatus,
    readWorkerStatus: () => readUsageTelemetryWorkerStatus(environment.hermitHome),
  };
  registerUsageTelemetryRoutes(app, usageTelemetryRouteDependencies);
  registerConversationTelemetryRoutes(app, {
    conversationTelemetry: services.conversationTelemetry,
  });
  registerUsageTelemetryStatusRoutes(app, usageTelemetryRouteDependencies);
  registerReviewCompatibilityRoutes(app, {
    reviewDecisions: {
      readReviewDecisions: (teamName) => svc.readReviewDecisions(teamName),
      saveReviewDecision: (teamName, scopeKey, payload) =>
        svc.saveReviewDecision(teamName, scopeKey, payload),
      clearReviewDecision: (teamName, scopeKey) => svc.clearReviewDecision(teamName, scopeKey),
    },
    reply500: operations.reply500,
  });
  registerSseRoutes(app, {
    state,
    assertTrustedBrowserOrigin: operations.assertTrustedBrowserOrigin,
  });

  const extensionHandlers = services.extensions;
  registerExtensionPluginRoutes(app, { handlers: extensionHandlers });
  registerExtensionMcpStoreRoutes(app, { handlers: extensionHandlers });
  registerCapabilityPackRoutes(app, {
    handlers: extensionHandlers,
    localSource: {
      projectPath: environment.repoRoot,
      listCronJobs: () => cc.listCronJobs(),
      listTeams: async () =>
        (await svc.listTeams().catch(() => []))
          .filter((team) => !team.deletedAt)
          .map((team) => ({
            slug: team.slug,
            displayName: team.displayName,
            workDir: team.workDir,
            bindProject: team.bindProject,
          })),
    },
    setLocalSource: setCapabilityPackLocalSource,
    setSkillsWatcherEmitter,
    broadcastSse: operations.broadcastSse,
  });
  registerExtensionSkillRoutes(app, { handlers: extensionHandlers });
  registerExtensionCredentialRoutes(app, { handlers: extensionHandlers });
  registerWorkbenchNotFoundHandler(app, {
    staticDir: environment.staticDir,
    state,
  });
  await registerStaticRoutes(app, { staticDir: environment.staticDir });

  const shutdown = createWorkbenchShutdown({
    app,
    lifecycle: context.lifecycle,
    sseClients: state.sseClients,
    stopTelemetry,
    imLiveWatcher: services.imLiveWatcher,
    directCliManager: services.directCli,
    bridgeLauncher: services.bridgeLauncher,
    bridge: services.bridgeConnection,
  });

  return {
    app,
    context,
    operations,
    shutdown,
    initializeTelemetryFromSettings: operations.initializeTelemetryFromSettings,
    ensureGlobalWorkflows,
  };
}
