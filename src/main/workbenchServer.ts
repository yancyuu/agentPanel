import cors from '@fastify/cors';
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
import { ClaudeBinaryResolver } from './services/team/ClaudeBinaryResolver';
import { readUsageTelemetryWorkerStatus } from './telemetry/worker';
import { createServerOperations } from './serverOperations';
import { createWorkbenchShutdown } from './serverProcessLifecycle';

import type { HermitBridgeAgentType } from '../shared/types/hermitBridge';
import type { DirectCliMessageInput } from './routes/teamRuntimeRoutes';
import type { HermitConfig, HermitConfigStore, ServerEnvironment } from './serverConfig';
import type { ServerContext } from './serverContext';
import type { ServerOperations } from './serverOperations';
import type { TeamProvisioningService } from './services/team-management';
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

  await app.register(cors, {
    origin: environment.allowedCorsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.addHook('preHandler', async (request, reply) => {
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
    workflowPrompt: services.workflowPrompt,
    assertTrustedBrowserOrigin: operations.assertTrustedBrowserOrigin,
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
    dispatchTask: (
      teamName: string,
      task: Parameters<TeamProvisioningService['dispatchTask']>[1]
    ) => svc.dispatchTask(teamName, task),
    listProjects: () => cc.listProjects(),
    readTeamManifest: (teamName: string) => svc.readTeamManifest(teamName),
    reply500: operations.reply500,
  };
  registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['core'] });

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
  registerMcpRoutes(app, {
    readTasks: (teamSlug) => svc.readTasks(teamSlug),
    patchTask: (teamSlug, taskId, patch) => svc.patchTask(teamSlug, taskId, patch),
  });
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
  registerReviewCompatibilityRoutes(app);
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
