import fs from 'node:fs/promises';
import path from 'node:path';

import { createDashboardRecentProjectsLoader } from '@features/recent-projects/main';
import {
  SYSTEM_MANAGER_BIND_PROJECT,
  SYSTEM_MANAGER_DISPLAY_NAME,
  SYSTEM_MANAGER_TEAM_NAME,
} from '@shared/types/team';

import { normalizePlatformAllowFrom } from './routes/teamRouteUtils';
import { createTeamRuntimeOperations } from './routes/teamRuntimeRoutes';
import { httpsGetFollowRedirects } from './services/extensions/catalog/PluginCatalogService';
import {
  type ProjectUsageStats,
  scanProjectStats,
} from './services/session-intelligence/SessionUsageParser';
import { DEFAULT_HERMIT_CC_SETTINGS } from './services/settings/HermitCcSettingsService';
import { ensureAdminLoopInitialized as runAdminLoopInit } from './services/system-manager/AdminLoopInitializer';
import { adminWorkDir } from './services/system-manager/SystemManagerConfigService';
import { HERMIT_OPS_GUIDE_URL } from './services/team-management/OpsRunbookContext';
import { getUsageTelemetryWorkerPaths, isUsageTelemetryWorkerPidRunning } from './telemetry/worker';
import {
  isExternalPlatformSessionKey,
  resolveExternalPlatformSessionTeamSlug,
} from './utils/externalPlatformSessionRouting';
import { resolveCcProjectName } from './utils/teamProjectResolution';
import { registerServerEventHandlers } from './serverEventHandlers';

import type { ServerEnvironment } from './serverConfig';
import type { ServerContext } from './serverContext';
import type { SystemManagerSummary, TelemetryConfig } from '@shared/types/team';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';

const SYSTEM_MANAGER_DESCRIPTION =
  '项目级 Claude Code Helm Loop，负责插件、MCP、Env、数字员工和统计数据的托管管理。';
const TEAM_STATS_CACHE_TTL_MS = 30_000;
const BRIDGE_SESSION_TEAM_CACHE_TTL_MS = 60_000;
const EXTERNAL_PLATFORM_ROUTE_RETRY_COUNT = 6;
const EXTERNAL_PLATFORM_ROUTE_RETRY_DELAY_MS = 1_000;
const HARNESS_BRIDGE_CONNECT_TIMEOUT_MS = 10_000;

export interface ServerOperations {
  broadcastSse: (eventName: string, data: unknown) => void;
  ensureSystemManager: () => Promise<SystemManagerSummary>;
  ensureAdminLoopInitialized: () => Promise<void>;
  getProjectStatsSnapshot: (workDir: string) => ProjectUsageStats | null;
  resolveRouteCcProjectName: (teamName: string) => Promise<string>;
  restartBridge: () => Promise<void>;
  readSavedTelemetryConfig: () => Promise<TelemetryConfig | null>;
  isExternalTelemetryWorkerRunning: () => Promise<boolean>;
  initializeTelemetryFromSettings: () => Promise<void>;
  resolveTeamSlugForMention: (rawName: string) => Promise<string | null>;
  persistPlatformRoutingMetadataForProject: (
    projectName: string,
    platformType: string,
    options: Record<string, unknown>
  ) => Promise<void>;
  readEffectiveCcSettings: () => Promise<Record<string, unknown>>;
  buildFallbackSessionKey: (teamName: string) => string;
  sendHarnessMessageViaBridge: (params: {
    teamName: string;
    text: string;
    sessionKey?: string;
    msgId?: string;
  }) => Promise<string>;
  assertTrustedBrowserOrigin: (request: FastifyRequest) => void;
  isTrustedBrowserOrigin: (origin: string | undefined) => boolean;
  dashboardRecentProjectsLoader: ReturnType<typeof createDashboardRecentProjectsLoader>;
  teamRuntimeOperations: ReturnType<typeof createTeamRuntimeOperations>;
  reply500: (error: unknown) => { ok: false; error: string };
}

interface CreateServerOperationsOptions {
  context: ServerContext;
  environment: ServerEnvironment;
  logger: Pick<FastifyBaseLogger, 'error' | 'info' | 'warn'>;
  startTelemetry: (config: TelemetryConfig) => Promise<unknown>;
  setRestartBridge?: (restart: () => Promise<void>) => void;
}

export function createServerOperations({
  context,
  environment,
  logger,
  startTelemetry,
  setRestartBridge = () => undefined,
}: CreateServerOperationsOptions): ServerOperations {
  const { services, state } = context;
  const cc = services.bridgeClient;
  const bridge = services.bridgeConnection;
  const bridgeLauncher = services.bridgeLauncher;
  const svc = services.teamProvisioning;

  const broadcastSse = (eventName: string, data: unknown): void => {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of state.sseClients) {
      try {
        client.res.write(payload);
      } catch {
        state.sseClients.delete(client);
      }
    }
  };

  const getSystemManagerWorkDir = async (): Promise<string> => {
    const directory = adminWorkDir();
    await fs.mkdir(directory, { recursive: true }).catch(() => undefined);
    return directory;
  };

  let systemManagerEnsurePromise: Promise<SystemManagerSummary> | null = null;
  const ensureSystemManagerUncached = async (): Promise<SystemManagerSummary> => {
    const workDir = await getSystemManagerWorkDir();
    let ccConnectProjectStatus: SystemManagerSummary['ccConnectProjectStatus'] = 'bound';
    try {
      await cc.getProject(SYSTEM_MANAGER_BIND_PROJECT);
    } catch {
      ccConnectProjectStatus = 'missing';
    }

    let manifest;
    try {
      manifest = await svc.readTeamManifest(SYSTEM_MANAGER_TEAM_NAME);
    } catch {
      const created = await svc.createTeam({
        displayName: SYSTEM_MANAGER_TEAM_NAME,
        bindProject: SYSTEM_MANAGER_BIND_PROJECT,
        harness: 'claudecode',
        workDir,
        color: 'slate',
        description: SYSTEM_MANAGER_DESCRIPTION,
        collaboration: false,
        createCcProject: false,
        injectInstructions: false,
      });
      manifest = created.manifest;
    }

    if (
      manifest.displayName !== SYSTEM_MANAGER_DISPLAY_NAME ||
      manifest.bindProject !== SYSTEM_MANAGER_BIND_PROJECT ||
      manifest.description !== SYSTEM_MANAGER_DESCRIPTION ||
      manifest.color !== 'slate' ||
      manifest.collaboration !== false ||
      manifest.workDir !== workDir
    ) {
      manifest = await svc.updateTeam(manifest.slug, {
        displayName: SYSTEM_MANAGER_DISPLAY_NAME,
        bindProject: SYSTEM_MANAGER_BIND_PROJECT,
        color: 'slate',
        description: SYSTEM_MANAGER_DESCRIPTION,
        collaboration: false,
        workDir,
      });
    }

    return {
      teamName: SYSTEM_MANAGER_TEAM_NAME,
      displayName: SYSTEM_MANAGER_DISPLAY_NAME,
      bindProject: SYSTEM_MANAGER_BIND_PROJECT,
      workDir: manifest.workDir || workDir,
      projectPath: manifest.workDir || workDir,
      description: manifest.description || SYSTEM_MANAGER_DESCRIPTION,
      localStatus: 'ready',
      ccConnectProjectStatus,
      feishuStatus: 'unbound',
    };
  };

  const ensureSystemManager = (): Promise<SystemManagerSummary> => {
    systemManagerEnsurePromise ??= ensureSystemManagerUncached().finally(() => {
      systemManagerEnsurePromise = null;
    });
    return systemManagerEnsurePromise;
  };

  const getProjectStatsSnapshot = (workDir: string): ProjectUsageStats | null => {
    const normalizedWorkDir = workDir.trim();
    if (!normalizedWorkDir) return null;
    const now = Date.now();
    const cached = state.teamStatsCache.get(normalizedWorkDir);
    if (cached && cached.expiresAt > now) return cached.value;
    if (cached?.promise) return cached.value;
    const promise = scanProjectStats(normalizedWorkDir)
      .catch((error) => {
        logger.warn({ err: error, workDir: normalizedWorkDir }, 'scan project stats failed');
        return null;
      })
      .then((value) => {
        state.teamStatsCache.set(normalizedWorkDir, {
          expiresAt: Date.now() + TEAM_STATS_CACHE_TTL_MS,
          value,
        });
        return value;
      });
    state.teamStatsCache.set(normalizedWorkDir, {
      expiresAt: now + TEAM_STATS_CACHE_TTL_MS,
      value: cached?.value ?? null,
      promise,
    });
    void promise;
    return cached?.value ?? null;
  };

  const resolveRouteCcProjectName = (teamName: string): Promise<string> =>
    resolveCcProjectName(teamName, (name) => svc.readTeamManifestByProject(name));

  const waitForHarnessBridgeConnected = async (
    timeoutMs = HARNESS_BRIDGE_CONNECT_TIMEOUT_MS
  ): Promise<void> => {
    if (bridge.connected) return;
    bridge.start();
    if (bridge.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('cc-connect Bridge 连接超时，无法发送到 harness'));
      }, timeoutMs);
      const onConnected = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        bridge.off('connected', onConnected);
      };
      bridge.on('connected', onConnected);
    });
  };

  const buildFallbackSessionKey = (teamName: string): string => `hermit:${teamName}:session`;
  const sendHarnessMessageViaBridge = async (params: {
    teamName: string;
    text: string;
    sessionKey?: string;
    msgId?: string;
  }): Promise<string> => {
    await waitForHarnessBridgeConnected();
    const sessionKey = params.sessionKey?.trim() || buildFallbackSessionKey(params.teamName);
    const projectName = await resolveRouteCcProjectName(params.teamName);
    bridge.sendUserMessage({
      sessionKey,
      userId: 'hermit-user',
      userName: 'User',
      content: params.text,
      msgId: params.msgId,
      project: projectName,
    });
    return sessionKey;
  };

  const readCcConnectConfigTokens = async (): Promise<{
    managementToken: string;
    bridgeToken: string;
  }> => {
    try {
      const raw = await fs.readFile(environment.hermitBridgeConfigFile, 'utf8');
      const section = (name: string): string =>
        new RegExp(`\\[${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(raw)?.[1] ?? '';
      const tokenOf = (body: string): string => /token\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? '';
      return {
        managementToken: tokenOf(section('management')),
        bridgeToken: tokenOf(section('bridge')),
      };
    } catch {
      return { managementToken: '', bridgeToken: '' };
    }
  };

  const stopRuntimeSidecarProcesses = async (): Promise<void> => {
    for (const port of [9820, 9810]) {
      try {
        const { execSync } = await import('node:child_process');
        if (process.platform === 'win32') {
          const listenersOn = (candidatePort: number): number[] => {
            const output = execSync('netstat -ano -p TCP', {
              encoding: 'utf8',
              windowsHide: true,
            });
            const pids: number[] = [];
            for (const line of output.split(/\r?\n/)) {
              const columns = line.trim().split(/\s+/);
              if (!columns.includes('LISTENING')) continue;
              const localPort = Number(columns[1]?.split(':').pop());
              const pid = Number(columns[columns.length - 1]);
              if (
                localPort === candidatePort &&
                Number.isFinite(pid) &&
                pid > 0 &&
                pid !== process.pid
              ) {
                pids.push(pid);
              }
            }
            return pids;
          };
          const taskkill = (pid: number, force: boolean): void => {
            try {
              execSync(`taskkill /PID ${pid}${force ? ' /F' : ''}`, {
                windowsHide: true,
                stdio: 'ignore',
              });
            } catch {
              // Best effort.
            }
          };
          for (const pid of listenersOn(port)) taskkill(pid, false);
          const deadline = Date.now() + 3_000;
          while (Date.now() < deadline && listenersOn(port).length > 0) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          for (const pid of listenersOn(port)) taskkill(pid, true);
        } else {
          try {
            const pids = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8' })
              .split(/\s+/)
              .filter(Boolean);
            for (const pid of pids) {
              if (Number(pid) !== process.pid) {
                try {
                  process.kill(Number(pid), 'SIGTERM');
                } catch {
                  // Best effort.
                }
              }
            }
          } catch {
            // No listener.
          }
        }
      } catch {
        // Platform tool unavailable.
      }
    }
  };

  const waitForRuntimePortsFree = async (timeoutMs = 5_000): Promise<void> => {
    const { execSync } = await import('node:child_process');
    const isFree = (port: number): boolean => {
      try {
        if (process.platform === 'win32') {
          const output = execSync('netstat -ano -p TCP', {
            encoding: 'utf8',
            windowsHide: true,
          });
          return !output.split(/\r?\n/).some((line) => {
            const columns = line.trim().split(/\s+/);
            return columns.includes('LISTENING') && Number(columns[1]?.split(':').pop()) === port;
          });
        }
        execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return false;
      } catch {
        return true;
      }
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ([9820, 9810].every(isFree)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const restartBridge = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let managementReady = false;
    if (process.platform !== 'win32') {
      try {
        await cc.restart();
        for (let index = 0; index < 15; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          try {
            await cc.listProjects();
            managementReady = true;
            break;
          } catch {
            // Not back yet.
          }
        }
      } catch {
        // Fall through to launcher rescue.
      }
    }

    if (!managementReady) {
      logger.warn('restarting runtime via launcher rescue (kill by port + re-launch)');
      const configBackup = `${environment.hermitBridgeConfigFile}.agentcli-bak`;
      try {
        await fs.copyFile(environment.hermitBridgeConfigFile, configBackup);
      } catch {
        // Best effort.
      }
      bridgeLauncher.stop();
      await stopRuntimeSidecarProcesses();
      await waitForRuntimePortsFree();
      const tryRelaunch = async (): Promise<boolean> => {
        try {
          const tokens = await readCcConnectConfigTokens();
          const launchEnv: NodeJS.ProcessEnv = { ...process.env };
          if (tokens.managementToken) {
            launchEnv.HERMIT_BRIDGE_TOKEN = tokens.managementToken;
            launchEnv.HERMIT_BRIDGE_MANAGEMENT_TOKEN = tokens.managementToken;
          }
          if (tokens.bridgeToken) launchEnv.HERMIT_BRIDGE_WS_TOKEN = tokens.bridgeToken;
          await bridgeLauncher.ensureRunning({
            client: cc,
            configPath: environment.hermitBridgeConfigFile,
            extraArgs: ['--force'],
            logFile: environment.bridgeLogFile,
            timeoutMs: environment.bridgeAutoLaunchTimeoutMs,
            env: launchEnv,
          });
        } catch (error) {
          logger.error({ err: error }, 'launcher rescue also failed');
        }
        for (let index = 0; index < 15; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          try {
            await cc.listProjects();
            return true;
          } catch {
            // Not back yet.
          }
        }
        return false;
      };
      managementReady = await tryRelaunch();
      if (!managementReady) {
        try {
          const raw = await fs.readFile(environment.bridgeLogFile, 'utf8');
          const tail = raw.trimEnd().split(/\r?\n/).slice(-30).join('\n');
          if (tail) {
            logger.error({ ccConnectLogTail: tail }, 'runtime rescue failed; cc-connect.log tail');
          }
        } catch {
          // No log file.
        }
        try {
          const current = await fs.readFile(environment.hermitBridgeConfigFile, 'utf8');
          if (!current.includes('[management]')) {
            logger.warn(
              'cc-connect config looks truncated after force-kill; restoring backup and retrying'
            );
            await fs.copyFile(configBackup, environment.hermitBridgeConfigFile);
            await stopRuntimeSidecarProcesses();
            await waitForRuntimePortsFree();
            managementReady = await tryRelaunch();
          }
        } catch (error) {
          logger.warn({ err: error }, 'config backup restore check failed');
        }
      }
    }
    if (!managementReady) throw new Error('hermit-bridge did not come back within 30s');
    bridge.reconnect();
    await waitForHarnessBridgeConnected(15_000);
  };
  setRestartBridge(restartBridge);

  const teamRuntimeOperations = createTeamRuntimeOperations({
    teamProvisioning: svc,
    bridgeClient: cc,
    directCliManager: services.directCli,
    directCliRoutes: state.directCliRoutes,
    ensureSystemManager,
    restartBridge,
    logger,
  });

  const ensureAdminLoopInitialized = async (): Promise<void> => {
    const sessionKey = `${SYSTEM_MANAGER_TEAM_NAME}:lead`;
    await runAdminLoopInit({
      getConfig: () => services.systemManagerConfig.getConfig(),
      updateConfig: (patch) => services.systemManagerConfig.updateConfig(patch),
      hasExistingBootstrap: async () => {
        try {
          return (
            (
              await fs.readFile(path.join(await getSystemManagerWorkDir(), 'CLAUDE.md'), 'utf8')
            ).trim().length > 0
          );
        } catch {
          return false;
        }
      },
      writeBootstrapArtifact: async (guideText) => {
        await fs.writeFile(
          path.join(await getSystemManagerWorkDir(), 'CLAUDE.md'),
          guideText,
          'utf8'
        );
      },
      fetchGuide: () => httpsGetFollowRedirects(HERMIT_OPS_GUIDE_URL),
      log: (message) => logger.warn({ sessionKey }, message),
      dispatch: async ({ text, messageId }) => {
        const workDir = await getSystemManagerWorkDir();
        await svc
          .appendMessage(SYSTEM_MANAGER_TEAM_NAME, {
            from: 'user',
            to: SYSTEM_MANAGER_TEAM_NAME,
            role: 'user',
            content: text,
            meta: { sessionKey, source: 'admin-init' },
          })
          .catch((error) =>
            logger.warn({ err: error, sessionKey }, 'helm loop init: append user message failed')
          );
        await teamRuntimeOperations.dispatchDirectCliMessage({
          teamName: SYSTEM_MANAGER_TEAM_NAME,
          sessionKey,
          workDir,
          from: SYSTEM_MANAGER_TEAM_NAME,
          to: 'user',
          text,
          messageId,
        });
        broadcastSse('team-change', { type: 'inbox', teamName: SYSTEM_MANAGER_TEAM_NAME });
      },
    });
  };

  const readSavedTelemetryConfig = async (): Promise<TelemetryConfig | null> => {
    try {
      const settings = JSON.parse(await fs.readFile(environment.hermitSettingsFile, 'utf8')) as {
        taskBus?: TelemetryConfig;
      };
      return settings.taskBus ?? null;
    } catch {
      return null;
    }
  };

  const isExternalTelemetryWorkerRunning = async (): Promise<boolean> => {
    try {
      const pidRaw = await fs.readFile(
        getUsageTelemetryWorkerPaths(environment.hermitHome).pidPath,
        'utf8'
      );
      return isUsageTelemetryWorkerPidRunning(Number.parseInt(pidRaw.trim(), 10));
    } catch {
      return false;
    }
  };

  const initializeTelemetryFromSettings = async (): Promise<void> => {
    const config = await readSavedTelemetryConfig();
    if (!config?.telemetry?.enabled) return;
    if (await isExternalTelemetryWorkerRunning()) {
      logger.info('usage telemetry worker already running — server telemetry interval skipped');
      return;
    }
    await startTelemetry(config).catch((error) => {
      logger.warn({ err: error }, 'telemetry startup failed');
    });
  };

  const resolveTeamSlugForMention = async (rawName: string): Promise<string | null> => {
    const normalized = rawName.trim().replace(/^@/, '');
    if (!normalized) return null;
    try {
      await svc.readTeamManifest(normalized);
      return normalized;
    } catch {
      // Try display name / case-insensitive slug match.
    }
    const lower = normalized.toLowerCase();
    const teams = await svc.listTeams().catch(() => []);
    return (
      teams.find(
        (team) =>
          team.slug.toLowerCase() === lower || (team.displayName ?? '').toLowerCase() === lower
      )?.slug ?? null
    );
  };

  const readStringOption = (record: Record<string, unknown>, keys: readonly string[]): string => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  const persistPlatformRoutingMetadataForProject = async (
    projectName: string,
    platformType: string,
    options: Record<string, unknown>
  ): Promise<void> => {
    const project = projectName.trim();
    const platform = platformType.trim();
    if (!project || !platform) return;
    const allowFrom = readStringOption(options, [
      'allow_from',
      'owner_open_id',
      'owner_user_id',
      'owner_union_id',
      'user_id',
      'open_id',
    ]);
    const explicitAllowChat = readStringOption(options, ['allow_chat', 'chat_id', 'open_chat_id']);
    const allowChat = explicitAllowChat || (allowFrom ? '*' : '');
    if (!allowFrom && !allowChat) return;
    let teamSlug: string;
    try {
      const manifest = await svc.readTeamManifestByProject(project);
      teamSlug = manifest.slug || project;
    } catch {
      teamSlug = project === SYSTEM_MANAGER_BIND_PROJECT ? SYSTEM_MANAGER_TEAM_NAME : project;
    }
    let existingFrom: Record<string, string> = {};
    let existingChat: Record<string, string> = {};
    try {
      const manifest = await svc.readTeamManifest(teamSlug);
      existingFrom = normalizePlatformAllowFrom(manifest.platformAllowFrom);
      existingChat = normalizePlatformAllowFrom(manifest.platformAllowChat);
    } catch {
      // Team metadata may not exist yet.
    }
    const patch: Record<string, unknown> = {};
    if (allowFrom) patch.platformAllowFrom = { ...existingFrom, [platform]: allowFrom };
    if (allowChat) patch.platformAllowChat = { ...existingChat, [platform]: allowChat };
    try {
      await svc.updateTeam(teamSlug, patch);
    } catch (error) {
      logger.warn(
        { err: error, project, teamSlug, platform },
        'failed to persist platform routing metadata'
      );
    }
  };

  const readEffectiveCcSettings = async (): Promise<Record<string, unknown>> => {
    const localSettings = await services.ccSettings.read();
    try {
      const remoteSettings = await cc.getGlobalSettings();
      return { ...DEFAULT_HERMIT_CC_SETTINGS, ...remoteSettings, ...localSettings };
    } catch {
      return { ...DEFAULT_HERMIT_CC_SETTINGS, ...localSettings };
    }
  };

  const resolveTeamSlugFromCcProject = async (projectName: string): Promise<string | null> => {
    try {
      const manifest = await svc.readTeamManifestByProject(projectName);
      return manifest.slug || projectName;
    } catch {
      return null;
    }
  };
  const resolveTeamSlugFromTeamName = async (teamName: string): Promise<string | null> => {
    try {
      const manifest = await svc.readTeamManifest(teamName);
      return manifest.slug || teamName;
    } catch {
      return teamName;
    }
  };
  const resolveTeamSlugFromCcSessions = async (sessionKey: string): Promise<string | null> => {
    const projects = await cc.listProjects().catch(() => []);
    for (const project of projects) {
      const sessions = await cc.listSessions(project.name).catch(() => []);
      if (sessions.some((session) => session.session_key === sessionKey)) {
        return resolveTeamSlugFromCcProject(project.name);
      }
    }
    return resolveExternalPlatformSessionTeamSlug(
      sessionKey,
      await svc.listTeams().catch(() => [])
    );
  };
  const parseHermitTeamFromSessionKey = (sessionKey: string): string | null => {
    if (!sessionKey) return null;
    return (
      /^hermit:([^:]+):/.exec(sessionKey)?.[1] ??
      /^bridge:hermit-([^:]+):/.exec(sessionKey)?.[1] ??
      null
    );
  };
  const resolveTeamFromBridgeMessage = async (message: unknown): Promise<string | null> => {
    const sessionKey = (message as { session_key?: string }).session_key ?? '';
    if (!sessionKey) return null;
    const raw = message as { project?: unknown; project_name?: unknown };
    const rawProject = typeof raw.project === 'string' ? raw.project : raw.project_name;
    const explicitProject = typeof rawProject === 'string' ? rawProject.trim() : '';
    if (explicitProject) {
      const teamName = await resolveTeamSlugFromCcProject(explicitProject);
      if (teamName) {
        state.bridgeSessionTeamCache.set(sessionKey, {
          teamName,
          expiresAt: Date.now() + BRIDGE_SESSION_TEAM_CACHE_TTL_MS,
        });
        return teamName;
      }
    }
    const parsedTeamName = parseHermitTeamFromSessionKey(sessionKey);
    if (parsedTeamName) return resolveTeamSlugFromTeamName(parsedTeamName);
    const cached = state.bridgeSessionTeamCache.get(sessionKey);
    if (cached && cached.expiresAt > Date.now()) return cached.teamName;
    if (isExternalPlatformSessionKey(sessionKey)) {
      const teamName = await resolveTeamSlugFromCcSessions(sessionKey);
      if (teamName) {
        state.bridgeSessionTeamCache.set(sessionKey, {
          teamName,
          expiresAt: Date.now() + BRIDGE_SESSION_TEAM_CACHE_TTL_MS,
        });
      }
      return teamName;
    }
    return resolveTeamSlugFromTeamName(sessionKey);
  };
  const resolveTeamFromBridgeMessageWithRetry = async (
    message: unknown
  ): Promise<string | null> => {
    const sessionKey = (message as { session_key?: string }).session_key ?? '';
    if (!isExternalPlatformSessionKey(sessionKey)) return resolveTeamFromBridgeMessage(message);
    for (let attempt = 0; attempt <= EXTERNAL_PLATFORM_ROUTE_RETRY_COUNT; attempt += 1) {
      const teamName = await resolveTeamFromBridgeMessage(message);
      if (teamName) return teamName;
      if (attempt < EXTERNAL_PLATFORM_ROUTE_RETRY_COUNT) {
        await new Promise((resolve) => setTimeout(resolve, EXTERNAL_PLATFORM_ROUTE_RETRY_DELAY_MS));
      }
    }
    logger.warn(
      { sessionKey },
      'external platform bridge message could not be mapped to a Hermit team slug'
    );
    return null;
  };

  const disposeServerEventHandlers = registerServerEventHandlers({
    state,
    directCliManager: services.directCli,
    bridge,
    appendMessage: (teamName, message) => svc.appendMessage(teamName, message),
    resolveTeamFromBridgeMessage: resolveTeamFromBridgeMessageWithRetry,
    broadcastSse,
    logger,
  });
  context.lifecycle.listenerDisposers.push(disposeServerEventHandlers);

  const allowedOriginSet = new Set(environment.allowedCorsOrigins);
  const isLoopbackBrowserOrigin = (origin: string): boolean => {
    try {
      const parsed = new URL(origin);
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      );
    } catch {
      return false;
    }
  };
  const isTrustedBrowserOrigin = (origin: string | undefined): boolean =>
    !origin || allowedOriginSet.has(origin) || isLoopbackBrowserOrigin(origin);
  const assertTrustedBrowserOrigin = (request: FastifyRequest): void => {
    const rawOrigin: unknown = request.headers.origin;
    const origin = Array.isArray(rawOrigin)
      ? typeof rawOrigin[0] === 'string'
        ? rawOrigin[0]
        : undefined
      : typeof rawOrigin === 'string'
        ? rawOrigin
        : undefined;
    if (!isTrustedBrowserOrigin(origin)) throw new Error(`Forbidden origin: ${origin ?? ''}`);
  };

  const dashboardRecentProjectsLoader = createDashboardRecentProjectsLoader({
    extraRoots: [environment.repoRoot, adminWorkDir()],
    logger: {
      info: (...args: unknown[]) => logger.info({ args }, 'recent-projects'),
      warn: (...args: unknown[]) => logger.warn({ args }, 'recent-projects'),
      error: (...args: unknown[]) => logger.error({ args }, 'recent-projects'),
    },
  });

  return {
    broadcastSse,
    ensureSystemManager,
    ensureAdminLoopInitialized,
    getProjectStatsSnapshot,
    resolveRouteCcProjectName,
    restartBridge,
    readSavedTelemetryConfig,
    isExternalTelemetryWorkerRunning,
    initializeTelemetryFromSettings,
    resolveTeamSlugForMention,
    persistPlatformRoutingMetadataForProject,
    readEffectiveCcSettings,
    buildFallbackSessionKey,
    sendHarnessMessageViaBridge,
    assertTrustedBrowserOrigin,
    isTrustedBrowserOrigin,
    dashboardRecentProjectsLoader,
    teamRuntimeOperations,
    reply500: (error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  };
}
