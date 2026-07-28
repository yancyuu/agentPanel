/**
 * Hermit standalone server (cc-connect sidecar mode).
 *
 * 这是 hermit 的"正式"后端入口(取代 bin/hermit-mvp/server.mjs)。
 *
 * 职责:
 *   1. 团队管理(/api/teams /api/teams/:slug/messages /api/teams/:slug/tasks ...)
 *   2. 群聊 SSE(/api/teams/:slug/group-send,通过 cc-connect Bridge WS 转发)
 *   3. cc-connect 原子能力 proxy(/api/cc/* → cc-connect:9820/api/v1/*)
 *   4. 静态资源托管(serve src/renderer 的 vite build 产物)
 *
 * 启动:
 *   pnpm dev:server         # 仅后端
 *   pnpm dev                # 后端 + vite dev(前端 5174,代理 /api 到 5680)
 *
 * 环境变量:
 *   HOST                       默认 0.0.0.0
 *   PORT                       默认 5680
 *   HERMIT_HOME                默认 ~/.hermit
 *   CC_CONNECT_BASE_URL        默认 http://127.0.0.1:9820
 *   CC_CONNECT_TOKEN           cc-connect Management API token(必填)
 *   CC_CONNECT_BRIDGE_URL      默认 ws://127.0.0.1:9810/bridge/ws
 *   CC_CONNECT_BRIDGE_TOKEN    cc-connect Bridge token(必填)
 *   STATIC_DIR                 静态资源目录,默认 dist-renderer/(若不存在,/ 返回 503 提示)
 */

// Windows spawn sites pass { shell: true } to execute .cmd shims, which makes
// Node print DEP0190 into the server logs. Not actionable — suppress.
process.noDeprecation = true;

import {
  cpSync,
  existsSync as _existsSync2,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from '@fastify/cors';
import { createDashboardRecentProjectsLoader } from '@features/recent-projects/main/composition/dashboardRecentProjects';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import {
  SYSTEM_MANAGER_BIND_PROJECT,
  SYSTEM_MANAGER_DISPLAY_NAME,
  SYSTEM_MANAGER_TEAM_NAME,
} from '@shared/types/team';
import Fastify from 'fastify';

import {
  extensionHandlers as ext,
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
import { CC_AGENT_TYPES, normalizePlatformAllowFrom } from './routes/teamRouteUtils';
import { createTeamRuntimeOperations, registerTeamRuntimeRoutes } from './routes/teamRuntimeRoutes';
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
import { DirectCliSessionManager } from './services/direct-cli';
import { buildTeamCapabilityTelemetrySnapshots } from './services/extensions/capability-packs/CapabilityPackLoaderService';
import { httpsGetFollowRedirects } from './services/extensions/catalog/PluginCatalogService';
import { HermitBridgeClient } from './services/hermitBridge/HermitBridgeClient';
import { HermitBridgeConnection } from './services/hermitBridge/HermitBridgeConnection';
import { HermitBridgeLauncher } from './services/hermitBridge/HermitBridgeLauncher';
import { LoopAssetsScannerService } from './services/loop-assets/LoopAssetsScannerService';
import { ConversationTelemetryService } from './services/session-intelligence/ConversationTelemetryService';
import { defaultImSessionsDir, ImLiveWatcher } from './services/session-intelligence/ImLiveWatcher';
import { LocalSessionScanner } from './services/session-intelligence/LocalSessionScanner';
import {
  type ProjectUsageStats,
  scanProjectStats,
} from './services/session-intelligence/SessionUsageParser';
import {
  configureUsageTelemetry,
  getTelemetryRuntimeStatus,
  getTelemetryStatus,
  startTelemetry,
  stopTelemetry,
  triggerScan,
} from './services/session-intelligence/UsageTelemetryService';
import {
  DEFAULT_HERMIT_CC_SETTINGS,
  HermitCcSettingsService,
} from './services/settings/HermitCcSettingsService';
import {
  getRuntimeReadiness,
  markBridgeBinaryCheck,
  markBridgeLaunch,
} from './services/system/RuntimeReadiness';
import { ensureAdminLoopInitialized as runAdminLoopInit } from './services/system-manager/AdminLoopInitializer';
import { ensureGlobalWorkflows } from './services/system-manager/BuiltinWorkflowSeeder';
import {
  adminWorkDir,
  SystemManagerConfigService,
} from './services/system-manager/SystemManagerConfigService';
import { WorkflowPromptService } from './services/system-manager/WorkflowPromptService';
import { ClaudeBinaryResolver } from './services/team/ClaudeBinaryResolver';
import { TeamProvisioningService } from './services/team-management';
import { HERMIT_OPS_GUIDE_URL } from './services/team-management/OpsRunbookContext';
import { UpdateService } from './services/UpdateService';
import {
  getUsageTelemetryWorkerPaths,
  isUsageTelemetryWorkerPidRunning,
  readUsageTelemetryWorkerStatus,
} from './telemetry/worker';
import {
  isExternalPlatformSessionKey,
  resolveExternalPlatformSessionTeamSlug,
} from './utils/externalPlatformSessionRouting';
import { resolveCcProjectName } from './utils/teamProjectResolution';
import { createServerContext, createServerRuntimeState } from './serverContext';
import { registerServerEventHandlers } from './serverEventHandlers';
import {
  createServerShutdown,
  createWorkbenchShutdown,
  installServerProcessHandlers,
} from './serverProcessLifecycle';
import { startStandaloneServerRuntime } from './serverStartup';

import type { HermitBridgeAgentType } from '../shared/types/hermitBridge';
import type { TeamManifest } from './services/team-management/TeamWorkspaceService';
import type { SystemManagerSummary, TelemetryConfig } from '@shared/types/team';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the repo root by walking up to the package.json named
// @yancyyu/agentcli. Robust to layout: works when running from source
// (src/main/), from the precompiled bundle (dist/server.bundle.mjs), and later
// from a SEA exe — all of which live somewhere under the package directory.
// (A hardcoded `../..` only worked for the src/main/ layout and broke the
// bundle, which sits in dist/.)
function findAgentCliRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    try {
      if (
        JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')).name ===
        '@yancyyu/agentcli'
      ) {
        return dir;
      }
    } catch {
      // missing or malformed package.json — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: original src/main layout (two levels up).
  return path.resolve(startDir, '..', '..');
}

const REPO_ROOT = findAgentCliRoot(__dirname);
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

// Default to loopback so the daemon is NOT exposed to the LAN by default.
// Set HOST=0.0.0.0 explicitly (and put a reverse proxy / origin allowlist in
// front) to expose it remotely. Combined with the global origin hook below
// this closes the local-service attack surface (DNS rebinding, drive-by pages).
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '5680', 10);
const STATIC_DIR = process.env.STATIC_DIR ?? path.resolve(REPO_ROOT, 'dist-renderer');
const HARNESS_BRIDGE_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS = 180_000;
const hermitBridgeAutoLaunchTimeoutMs = Number.parseInt(
  process.env.HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS ?? '',
  10
);
const HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS = Number.isFinite(hermitBridgeAutoLaunchTimeoutMs)
  ? Math.max(30_000, hermitBridgeAutoLaunchTimeoutMs)
  : DEFAULT_HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS;
const SYSTEM_MANAGER_DESCRIPTION =
  '项目级 Claude Code Helm Loop，负责插件、MCP、Env、数字员工和统计数据的托管管理。';

// ===========================================================================
// Hermit runtime config — ~/.hermit/config.json
// Priority: file > env vars > defaults
// ===========================================================================

const HERMIT_HOME = process.env.HERMIT_HOME ?? path.join(os.homedir(), '.hermit');
const HERMIT_CONFIG_FILE = path.join(HERMIT_HOME, 'config.json');
const HERMIT_APP_CONFIG_FILE = path.join(HERMIT_HOME, 'app-config.json');
// cc-connect is the current canonical dir (matches bin/lib/env.mjs). hermit-bridge
// is the pre-rename legacy dir; bin/lib/runtime.mjs migrates it forward on boot.
// Keep this in sync with env.mjs / branding.mjs (runtimeBridgeName = 'cc-connect').
const HERMIT_BRIDGE_DIR = path.join(HERMIT_HOME, 'cc-connect');
const LEGACY_CC_CONNECT_DIR = path.join(HERMIT_HOME, 'hermit-bridge');
const HERMIT_BRIDGE_CONFIG_FILE = path.join(HERMIT_BRIDGE_DIR, 'config.toml');
const LEGACY_CC_CONNECT_CONFIG_FILE = path.join(LEGACY_CC_CONNECT_DIR, 'config.toml');
const HERMIT_BRIDGE_DATA_DIR = path.join(HERMIT_BRIDGE_DIR, 'data');
const LEGACY_CC_CONNECT_DATA_DIR = path.join(LEGACY_CC_CONNECT_DIR, 'data');
const HERMIT_SETTINGS_FILE = path.join(HERMIT_HOME, 'settings.json');

interface HermitConfig {
  ccBaseUrl: string;
  ccToken: string;
  ccBridgeUrl: string;
  ccBridgeToken: string;
}

function normalizeMigratedHermitBridgeConfig(raw: string): string {
  return raw
    .split(LEGACY_CC_CONNECT_DATA_DIR)
    .join(HERMIT_BRIDGE_DATA_DIR)
    .split('~/.hermit/hermit-bridge/data')
    .join('~/.hermit/cc-connect/data');
}

function migrateLegacyHermitBridgeDataIfNeeded(): boolean {
  if (_existsSync2(HERMIT_BRIDGE_DATA_DIR) || !_existsSync2(LEGACY_CC_CONNECT_DATA_DIR))
    return false;
  mkdirSync(path.dirname(HERMIT_BRIDGE_DATA_DIR), { recursive: true });
  try {
    renameSync(LEGACY_CC_CONNECT_DATA_DIR, HERMIT_BRIDGE_DATA_DIR);
  } catch {
    cpSync(LEGACY_CC_CONNECT_DATA_DIR, HERMIT_BRIDGE_DATA_DIR, { recursive: true });
    rmSync(LEGACY_CC_CONNECT_DATA_DIR, { recursive: true, force: true });
  }
  return true;
}

function normalizeHermitBridgeConfigFileIfNeeded(): boolean {
  if (!_existsSync2(HERMIT_BRIDGE_CONFIG_FILE)) return false;
  const raw = readFileSync(HERMIT_BRIDGE_CONFIG_FILE, 'utf-8');
  const normalized = normalizeMigratedHermitBridgeConfig(raw);
  if (normalized === raw) return false;
  writeFileSync(HERMIT_BRIDGE_CONFIG_FILE, normalized, 'utf-8');
  return true;
}

function migrateLegacyHermitBridgeConfigIfNeeded(): void {
  const migratedData = migrateLegacyHermitBridgeDataIfNeeded();
  let migratedConfig = false;
  if (!_existsSync2(HERMIT_BRIDGE_CONFIG_FILE) && _existsSync2(LEGACY_CC_CONNECT_CONFIG_FILE)) {
    mkdirSync(path.dirname(HERMIT_BRIDGE_CONFIG_FILE), { recursive: true });
    const migrated = normalizeMigratedHermitBridgeConfig(
      readFileSync(LEGACY_CC_CONNECT_CONFIG_FILE, 'utf-8')
    );
    writeFileSync(HERMIT_BRIDGE_CONFIG_FILE, migrated, 'utf-8');
    rmSync(LEGACY_CC_CONNECT_CONFIG_FILE, { force: true });
    migratedConfig = true;
  }
  const normalizedConfig = normalizeHermitBridgeConfigFileIfNeeded();
  if (migratedData || migratedConfig || normalizedConfig) {
    console.info('[Hermit] migrated runtime files to ~/.hermit/cc-connect/');
  }
}

function ensureWritableHermitBridgeConfigFile(): string {
  migrateLegacyHermitBridgeConfigIfNeeded();
  if (_existsSync2(HERMIT_BRIDGE_CONFIG_FILE)) {
    return HERMIT_BRIDGE_CONFIG_FILE;
  }
  throw new Error('hermit-bridge 配置文件不存在: ~/.hermit/cc-connect/config.toml');
}

function readHermitBridgeConfigTomlRaw(): { path: string; content: string } {
  const configFile = ensureWritableHermitBridgeConfigFile();
  return {
    path: configFile,
    content: readFileSync(configFile, 'utf-8'),
  };
}

async function writeHermitBridgeConfigTomlRaw(content: string): Promise<void> {
  await atomicWriteAsync(ensureWritableHermitBridgeConfigFile(), content);
}

function readHermitBridgeTomlToken(section: 'bridge' | 'management'): string {
  try {
    const configFile = ensureWritableHermitBridgeConfigFile();
    const raw = readFileSync(configFile, 'utf-8');
    const match = new RegExp(`\\[${section}\\][^\\[]*token\\s*=\\s*"([^"]+)"`, 's').exec(raw);
    return match?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

function loadConfig(): HermitConfig {
  const tomlManagementToken = readHermitBridgeTomlToken('management');
  const tomlBridgeToken = readHermitBridgeTomlToken('bridge');
  const defaults: HermitConfig = {
    ccBaseUrl:
      process.env.HERMIT_BRIDGE_BASE_URL ??
      process.env.CC_CONNECT_BASE_URL ??
      'http://127.0.0.1:9820',
    ccToken:
      process.env.HERMIT_BRIDGE_TOKEN ||
      process.env.HERMIT_BRIDGE_MANAGEMENT_TOKEN ||
      process.env.CC_CONNECT_TOKEN ||
      process.env.HERMIT_BRIDGE_MANAGEMENT_TOKEN ||
      process.env.CC_CONNECT_MANAGEMENT_TOKEN ||
      tomlManagementToken,
    ccBridgeUrl:
      process.env.HERMIT_BRIDGE_WS_URL ??
      process.env.CC_CONNECT_BRIDGE_URL ??
      'ws://127.0.0.1:9810/bridge/ws',
    ccBridgeToken:
      process.env.CC_CONNECT_BRIDGE_TOKEN ||
      tomlBridgeToken ||
      process.env.HERMIT_BRIDGE_TOKEN ||
      process.env.HERMIT_BRIDGE_MANAGEMENT_TOKEN ||
      process.env.CC_CONNECT_TOKEN ||
      process.env.HERMIT_BRIDGE_MANAGEMENT_TOKEN ||
      process.env.CC_CONNECT_MANAGEMENT_TOKEN ||
      tomlManagementToken,
  };
  let merged = { ...defaults };
  try {
    if (_existsSync2(HERMIT_CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(HERMIT_CONFIG_FILE, 'utf-8')) as Partial<HermitConfig>;
      merged = { ...defaults, ...raw };
    }
  } catch (err) {
    const msg =
      err instanceof SyntaxError
        ? `${HERMIT_CONFIG_FILE} 格式错误: ${err.message}。将使用默认配置并覆盖修复。`
        : `读取 ${HERMIT_CONFIG_FILE} 失败: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[Hermit] ${msg}`);
    // Auto-heal: rewrite the config file with valid defaults + any readable env overrides
    mkdirSync(HERMIT_HOME, { recursive: true });
    writeFileSync(HERMIT_CONFIG_FILE, JSON.stringify(defaults, null, 2), 'utf-8');
  }
  if (!merged.ccBridgeToken.trim()) {
    merged = { ...merged, ccBridgeToken: tomlBridgeToken || merged.ccToken };
  }
  return merged;
}

function saveConfig(patch: Partial<HermitConfig>): HermitConfig {
  const current = loadConfig();
  const next = { ...current, ...patch };
  mkdirSync(HERMIT_HOME, { recursive: true });
  writeFileSync(HERMIT_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

function readHermitConfigRaw(): { path: string; content: string } {
  if (_existsSync2(HERMIT_CONFIG_FILE)) {
    return {
      path: HERMIT_CONFIG_FILE,
      content: readFileSync(HERMIT_CONFIG_FILE, 'utf-8'),
    };
  }
  return {
    path: HERMIT_CONFIG_FILE,
    content: `${JSON.stringify(loadConfig(), null, 2)}\n`,
  };
}

function writeHermitConfigRaw(content: string): HermitConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(
        `配置文件 JSON 格式错误: ${err.message}。请检查是否有尾逗号、单引号或注释等非法 JSON 语法。`
      );
    }
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Hermit 配置必须是 JSON 对象');
  }
  mkdirSync(HERMIT_HOME, { recursive: true });
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  writeFileSync(HERMIT_CONFIG_FILE, normalized, 'utf-8');
  return loadConfig();
}

// Construct the Fastify instance before any background bridge work or event
// listener registration. Several legacy callbacks close over app.log, so this
// ordering prevents them from observing an uninitialized app during startup.
const app = Fastify({
  logger: { level: process.env.HERMIT_LOG_LEVEL ?? 'warn' },
  disableRequestLogging: true,
});

const serverRuntimeState = createServerRuntimeState();
const { sseClients, bridgeSessionTeamCache, teamStatsCache } = serverRuntimeState;

// Mutable runtime config — updated via /api/hermit-config POST
let runtimeConfig = loadConfig();

const cc = new HermitBridgeClient({
  baseUrl: runtimeConfig.ccBaseUrl,
  token: runtimeConfig.ccToken,
  bridgeUrl: runtimeConfig.ccBridgeUrl,
});
const bridge = new HermitBridgeConnection({
  bridgeUrl: runtimeConfig.ccBridgeUrl,
  bridgeToken: runtimeConfig.ccBridgeToken || runtimeConfig.ccToken,
});
// Auto-launches the cc-connect bridge (via the bundled `hermit-bridge` binary)
// when no management API is reachable; a no-op when cc-connect already runs.
const bridgeLauncher = new HermitBridgeLauncher();
const svc = new TeamProvisioningService(cc, bridge, undefined, {
  restartCcConnect: restartHermitBridgeAndReconnect,
});
const systemManagerConfig = new SystemManagerConfigService();
const workflowPromptService = new WorkflowPromptService();

async function getSystemManagerWorkDir(): Promise<string> {
  // Canonical Helm Loop runtime path. System Manager is a normal Claude Code
  // workspace rooted at ~/.hermit: commands are read from .claude/commands and
  // CLAUDE.md from the same root, with no separate system-only command source.
  const dir = adminWorkDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  return dir;
}

let systemManagerEnsurePromise: Promise<SystemManagerSummary> | null = null;

async function ensureSystemManagerUncached(): Promise<SystemManagerSummary> {
  const workDir = await getSystemManagerWorkDir();
  let ccConnectProjectStatus: SystemManagerSummary['ccConnectProjectStatus'] = 'bound';
  try {
    await cc.getProject(SYSTEM_MANAGER_BIND_PROJECT);
  } catch {
    ccConnectProjectStatus = 'missing';
  }

  let manifest: TeamManifest;
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
}

async function ensureSystemManager(): Promise<SystemManagerSummary> {
  systemManagerEnsurePromise ??= ensureSystemManagerUncached().finally(() => {
    systemManagerEnsurePromise = null;
  });
  return systemManagerEnsurePromise;
}

/**
 * Helm Loop bootstrap wrapper. On first open, fetch the ops guide and feed it to
 * the admin lead session as the first turn so the agent seeds its own CLAUDE.md.
 * Idempotent + failure-retrying (see AdminLoopInitializer). The bootstrap user
 * message is also appended to the team inbox so it is visible in the console.
 * Invoked fire-and-forget from the ensure endpoint — never blocks open.
 */
async function ensureAdminLoopInitialized(): Promise<void> {
  const sessionKey = `${SYSTEM_MANAGER_TEAM_NAME}:lead`;
  await runAdminLoopInit({
    getConfig: () => systemManagerConfig.getConfig(),
    updateConfig: (patch) => systemManagerConfig.updateConfig(patch),
    hasExistingBootstrap: async () => {
      const workDir = await getSystemManagerWorkDir();
      try {
        const content = await fs.readFile(path.join(workDir, 'CLAUDE.md'), 'utf8');
        return content.trim().length > 0;
      } catch {
        return false;
      }
    },
    writeBootstrapArtifact: async (guideText: string) => {
      // Persist the guide as the workspace CLAUDE.md directly — the durable
      // marker the gate keys on — so init is recorded even if the agent session
      // fails to start on this pass.
      const workDir = await getSystemManagerWorkDir();
      await fs.writeFile(path.join(workDir, 'CLAUDE.md'), guideText, 'utf8');
    },
    fetchGuide: () => httpsGetFollowRedirects(HERMIT_OPS_GUIDE_URL),
    log: (message) => app.log.warn({ sessionKey }, message),
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
        .catch((err) =>
          app.log.warn({ err, sessionKey }, 'helm loop init: append user message failed')
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
}

const conversationTelemetry = new ConversationTelemetryService({
  cc,
  listTeams: () => svc.listTeams(),
  readTeamManifest: (teamName) => svc.readTeamManifest(teamName),
});
configureUsageTelemetry();
const localSessionScanner = new LocalSessionScanner();
const loopAssetsScanner = new LoopAssetsScannerService();
const TEAM_STATS_CACHE_TTL_MS = 30_000;

function getProjectStatsSnapshot(workDir: string): ProjectUsageStats | null {
  const normalizedWorkDir = workDir.trim();
  if (!normalizedWorkDir) return null;

  const now = Date.now();
  const cached = teamStatsCache.get(normalizedWorkDir);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.value;

  const promise = scanProjectStats(normalizedWorkDir)
    .catch((err) => {
      app.log.warn({ err, workDir: normalizedWorkDir }, 'scan project stats failed');
      return null;
    })
    .then((value) => {
      teamStatsCache.set(normalizedWorkDir, {
        expiresAt: Date.now() + TEAM_STATS_CACHE_TTL_MS,
        value,
      });
      return value;
    });

  teamStatsCache.set(normalizedWorkDir, {
    expiresAt: now + TEAM_STATS_CACHE_TTL_MS,
    value: cached?.value ?? null,
    promise,
  });
  void promise;
  return cached?.value ?? null;
}

async function resolveRouteCcProjectName(teamName: string): Promise<string> {
  return resolveCcProjectName(teamName, (name) => svc.readTeamManifestByProject(name));
}

/**
 * Read the current management/bridge tokens from cc-connect's config.toml.
 * The rescue relaunch must inject THESE (like the boot path does) rather than
 * the server process's boot-time env: if the config was rewritten after the
 * server started, the env tokens are stale and cc-connect comes up
 * misconfigured or fails silently.
 */
async function readCcConnectConfigTokens(): Promise<{
  managementToken: string;
  bridgeToken: string;
}> {
  try {
    const raw = await fs.readFile(HERMIT_BRIDGE_CONFIG_FILE, 'utf-8');
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
}

async function restartHermitBridgeAndReconnect(): Promise<void> {
  // Brief settle delay: this is typically called right after a platform bind /
  // QR save that just WROTE cc-connect's config. Restarting before the write
  // fully lands makes the respawned process race the file. The web UI's manual
  // restart button doesn't hit this (cc-connect is idle), which is why web
  // restart is clean while create-digital-worker restart misbehaves. 1.5s is
  // enough for the config write + fsync on Windows without being noticeable.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Two-stage restart for cross-platform reliability + no black box:
  //   1. On macOS/Linux, try cc.restart() first — cc-connect re-execs cleanly
  //      and the respawn pops no window. Fast path.
  //   2. On Windows, cc.restart()'s self-respawn loses windowsHide, so the
  //      respawned cc-connect.exe pops a console window (the "black box" users
  //      see after creating a digital worker) that stays open for the runtime's
  //      lifetime — closing it kills the runtime. Skip cc.restart() there and
  //      go straight to killing by port + re-launching via the launcher (whose
  //      defaultSpawn sets windowsHide). The same rescue path also runs on
  //      macOS/Linux if cc.restart() doesn't bring the API back within ~15s.
  let managementReady = false;
  if (process.platform !== 'win32') {
    try {
      await cc.restart();
      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          await cc.listProjects();
          managementReady = true;
          break;
        } catch {
          /* not back yet */
        }
      }
    } catch {
      /* cc.restart() threw — fall through to launcher rescue */
    }
  }

  if (!managementReady) {
    app.log.warn('restarting runtime via launcher rescue (kill by port + re-launch)');
    const ccLogFile = path.join(HERMIT_HOME, 'cc-connect', 'cc-connect.log');
    // Back up cc-connect's config BEFORE force-killing: taskkill /F can land
    // mid-write (the QR save that triggered this restart just wrote the file),
    // and a truncated config.toml makes every relaunch exit on parse — the
    // runtime then never comes back, on this or any later boot.
    const configBackup = `${HERMIT_BRIDGE_CONFIG_FILE}.agentcli-bak`;
    try {
      await fs.copyFile(HERMIT_BRIDGE_CONFIG_FILE, configBackup);
    } catch {
      /* best effort */
    }
    bridgeLauncher.stop();
    await stopRuntimeSidecarProcesses();
    await waitForRuntimePortsFree(5_000);
    const tryRelaunch = async (): Promise<boolean> => {
      try {
        // Mirror the boot path: inject the CURRENT config tokens, not the
        // server process's possibly-stale boot-time env.
        const tokens = await readCcConnectConfigTokens();
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (tokens.managementToken) {
          env.HERMIT_BRIDGE_TOKEN = tokens.managementToken;
          env.HERMIT_BRIDGE_MANAGEMENT_TOKEN = tokens.managementToken;
        }
        if (tokens.bridgeToken) {
          env.HERMIT_BRIDGE_WS_TOKEN = tokens.bridgeToken;
        }
        await bridgeLauncher.ensureRunning({
          client: cc,
          configPath: HERMIT_BRIDGE_CONFIG_FILE,
          extraArgs: ['--force'],
          logFile: ccLogFile,
          timeoutMs: HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS,
          env,
        });
      } catch (err) {
        app.log.error({ err }, 'launcher rescue also failed');
      }
      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          await cc.listProjects();
          return true;
        } catch {
          /* not back yet */
        }
      }
      return false;
    };
    managementReady = await tryRelaunch();

    if (!managementReady) {
      // The relaunched cc-connect's stdout/stderr goes to cc-connect.log — its
      // own startup error (config parse, port bind, …) is the decisive
      // evidence, so surface it in OUR log instead of dying silently.
      try {
        const raw = await fs.readFile(ccLogFile, 'utf-8');
        const tail = raw.trimEnd().split(/\r?\n/).slice(-30).join('\n');
        if (tail)
          app.log.error({ ccConnectLogTail: tail }, 'runtime rescue failed; cc-connect.log tail');
      } catch {
        /* no log file */
      }
      // If the config got truncated by the force-kill, restore the pre-restart
      // backup and retry once. Sanity check: a valid config must declare the
      // [management] section we boot with.
      try {
        const current = await fs.readFile(HERMIT_BRIDGE_CONFIG_FILE, 'utf-8');
        if (!current.includes('[management]')) {
          app.log.warn(
            'cc-connect config looks truncated after force-kill; restoring backup and retrying'
          );
          await fs.copyFile(configBackup, HERMIT_BRIDGE_CONFIG_FILE);
          await stopRuntimeSidecarProcesses();
          await waitForRuntimePortsFree(5_000);
          managementReady = await tryRelaunch();
        }
      } catch (err) {
        app.log.warn({ err }, 'config backup restore check failed');
      }
    }
  }
  if (!managementReady) {
    throw new Error('hermit-bridge did not come back within 30s');
  }

  // After hermit-bridge restarts, force Hermit's Bridge adapter to reconnect and re-register.
  // Otherwise Feishu/Lark may show connected in hermit-bridge but Hermit is not listening yet.
  bridge.reconnect();
  await waitForHarnessBridgeConnected(15_000);
}

/**
 * Kill any process listening on the cc-connect management (9820) and bridge
 * ws (9810) ports. Used when re-launching cc-connect ourselves: after stopping
 * the launcher's own child, there may still be a self-restarted cc-connect or
 * an externally-managed one holding the ports. Cross-platform: lsof on unix,
 * netstat+taskkill on Windows.
 */
async function stopRuntimeSidecarProcesses(): Promise<void> {
  const ports = [9820, 9810];
  for (const p of ports) {
    try {
      if (process.platform === 'win32') {
        const { execSync } = await import('node:child_process');
        const listenersOn = (port: number): number[] => {
          const out = execSync(`netstat -ano -p TCP`, { encoding: 'utf-8', windowsHide: true });
          const pids: number[] = [];
          for (const line of out.split(/\r?\n/)) {
            const cols = line.trim().split(/\s+/);
            if (!cols.includes('LISTENING')) continue;
            const localPort = Number(cols[1]?.split(':').pop());
            const pid = Number(cols[cols.length - 1]);
            if (localPort === port && Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
              pids.push(pid);
            }
          }
          return pids;
        };
        const taskkill = (pid: number, force: boolean) => {
          try {
            execSync(`taskkill /PID ${pid}${force ? ' /F' : ''}`, {
              windowsHide: true,
              stdio: 'ignore',
            });
          } catch {
            /* best effort */
          }
        };
        // Graceful first: plain taskkill (CTRL_CLOSE) lets cc-connect flush its
        // config; /F mid-write can truncate config.toml and then every relaunch
        // exits on parse. Force-kill only whatever still listens after a grace
        // period.
        for (const pid of listenersOn(p)) taskkill(pid, false);
        const graceDeadline = Date.now() + 3_000;
        while (Date.now() < graceDeadline && listenersOn(p).length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        for (const pid of listenersOn(p)) taskkill(pid, true);
      } else {
        const { execSync } = await import('node:child_process');
        try {
          const pids = execSync(`lsof -tiTCP:${p} -sTCP:LISTEN`, { encoding: 'utf-8' })
            .split(/\s+/)
            .filter(Boolean);
          for (const pid of pids) {
            if (Number(pid) !== process.pid) {
              try {
                process.kill(Number(pid), 'SIGTERM');
              } catch {
                /* best effort */
              }
            }
          }
        } catch {
          /* no listener */
        }
      }
    } catch {
      /* platform tool unavailable — best effort */
    }
  }
}

/**
 * Wait until both runtime ports (9820, 9810) are free, up to timeoutMs.
 * Polls every 200ms.
 */
async function waitForRuntimePortsFree(timeoutMs = 5_000): Promise<void> {
  const ports = [9820, 9810];
  const deadline = Date.now() + timeoutMs;
  // ESM module — no require(); dynamic import matches the surrounding helpers.
  const { execSync } = await import('node:child_process');
  const isFree = (port: number): boolean => {
    try {
      if (process.platform === 'win32') {
        const out = execSync(`netstat -ano -p TCP`, { encoding: 'utf-8', windowsHide: true });
        return !out.split(/\r?\n/).some((line) => {
          const cols = line.trim().split(/\s+/);
          return cols.includes('LISTENING') && Number(cols[1]?.split(':').pop()) === port;
        });
      }
      execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return false;
    } catch {
      return true;
    }
  };
  while (Date.now() < deadline) {
    if (ports.every(isFree)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  /* timeout — proceed anyway; ensureRunning will surface a bind failure */
}

async function readSavedTelemetryConfig(): Promise<TelemetryConfig | null> {
  try {
    const raw = await fs.readFile(HERMIT_SETTINGS_FILE, 'utf-8');
    const settings = JSON.parse(raw) as { taskBus?: TelemetryConfig };
    return settings.taskBus ?? null;
  } catch {
    return null;
  }
}

async function isExternalTelemetryWorkerRunning(): Promise<boolean> {
  try {
    const pidRaw = await fs.readFile(getUsageTelemetryWorkerPaths(HERMIT_HOME).pidPath, 'utf-8');
    const pid = Number.parseInt(pidRaw.trim(), 10);
    return isUsageTelemetryWorkerPidRunning(pid);
  } catch {
    return false;
  }
}

async function initializeTelemetryFromSettings(): Promise<void> {
  const config = await readSavedTelemetryConfig();
  if (!config) return;

  if (config.telemetry?.enabled) {
    if (await isExternalTelemetryWorkerRunning()) {
      app.log.info('usage telemetry worker already running — server telemetry interval skipped');
    } else {
      await startTelemetry(config).catch((err) => {
        app.log.warn({ err }, 'telemetry startup failed');
      });
    }
  }
}

async function resolveTeamSlugForMention(rawName: string): Promise<string | null> {
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
  const matched = teams.find((team) => {
    const slug = team.slug.toLowerCase();
    const displayName = (team.displayName ?? '').toLowerCase();
    return slug === lower || displayName === lower;
  });
  return matched?.slug ?? null;
}

function readStringOption(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

async function persistPlatformRoutingMetadataForProject(
  projectName: string,
  platformType: string,
  options: Record<string, unknown>
): Promise<void> {
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
    // Team metadata may not exist for a cc-connect-only project yet.
  }

  const patch: Record<string, unknown> = {};
  if (allowFrom) patch.platformAllowFrom = { ...existingFrom, [platform]: allowFrom };
  if (allowChat) patch.platformAllowChat = { ...existingChat, [platform]: allowChat };

  try {
    await svc.updateTeam(teamSlug, patch);
  } catch (err) {
    app.log.warn(
      { err, project, teamSlug, platform },
      'failed to persist platform routing metadata'
    );
  }
}

// ===========================================================================
// SSE 客户端管理器 — 广播 bridge 事件到所有连接的前端客户端
// ===========================================================================

function broadcastSse(eventName: string, data: unknown): void {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Direct-CLI execution layer.
// In-app Loop consoles (admin + team lead) and team-member DMs spawn the local
// `claude` CLI directly as a long-lived stream-json subprocess, bypassing
// cc-connect (which is now reserved for external IM). cc-connect's project/
// work_dir/platform layer was the root cause of "❌ 错误: 启动 Agent 会话失败".
// Manager events relay to SSE for token-level streaming; the `result` event
// persists the final reply into the team inbox (same appendMessage path as the
// bridge reply handler), so the existing renderer refresh Just Works.
// ---------------------------------------------------------------------------
const directCliManager = new DirectCliSessionManager();
// IM live workers: re-scan hermit-bridge session files on change (+ 5s watchdog)
// and push detected workers to the renderer via the 'im-live-workers' SSE event,
// mirroring the team-change push model.
const imLiveWatcher = new ImLiveWatcher({
  sessionsDir: defaultImSessionsDir(),
  emit: (workers) => broadcastSse('im-live-workers', workers),
});
const hermitCcSettings = new HermitCcSettingsService(HERMIT_SETTINGS_FILE);
const updateService = new UpdateService();

const serverContext = createServerContext({
  services: {
    bridgeClient: cc,
    bridgeConnection: bridge,
    bridgeLauncher,
    teamProvisioning: svc,
    systemManagerConfig,
    workflowPrompt: workflowPromptService,
    conversationTelemetry,
    localSessionScanner,
    loopAssetsScanner,
    directCli: directCliManager,
    imLiveWatcher,
    ccSettings: hermitCcSettings,
    update: updateService,
    extensions: ext,
  },
  state: serverRuntimeState,
});

const teamRuntimeOperations = createTeamRuntimeOperations({
  teamProvisioning: serverContext.services.teamProvisioning,
  bridgeClient: serverContext.services.bridgeClient,
  directCliManager: serverContext.services.directCli,
  directCliRoutes: serverContext.state.directCliRoutes,
  ensureSystemManager,
  restartBridge: restartHermitBridgeAndReconnect,
  logger: app.log,
});

async function readEffectiveCcSettings(): Promise<Record<string, unknown>> {
  const localSettings = await hermitCcSettings.read();
  try {
    const remoteSettings = await cc.getGlobalSettings();
    return { ...DEFAULT_HERMIT_CC_SETTINGS, ...remoteSettings, ...localSettings };
  } catch {
    return { ...DEFAULT_HERMIT_CC_SETTINGS, ...localSettings };
  }
}

// Auto-allow rules (autoAllowAll / file edits / safe-but-not-dangerous bash) live in the
// shared, unit-tested `toolApprovalRules` util — copied verbatim from the multi-agent
// reference impl so the rule set (incl. DANGEROUS_PATTERNS that override safe prefixes,
// e.g. `git rm`) stays byte-identical. Only `can_use_tool` is a real gate; other control
// subtypes must be auto-allowed or the stream deadlocks on stdin.

const disposeServerEventHandlers = registerServerEventHandlers({
  state: serverContext.state,
  directCliManager: serverContext.services.directCli,
  bridge: serverContext.services.bridgeConnection,
  appendMessage: (teamName, message) =>
    serverContext.services.teamProvisioning.appendMessage(teamName, message),
  resolveTeamFromBridgeMessage: resolveTeamFromBridgeMessageWithRetry,
  broadcastSse,
  logger: app.log,
});
serverContext.lifecycle.listenerDisposers.push(disposeServerEventHandlers);

const BRIDGE_SESSION_TEAM_CACHE_TTL_MS = 60_000;
const EXTERNAL_PLATFORM_ROUTE_RETRY_COUNT = 6;
const EXTERNAL_PLATFORM_ROUTE_RETRY_DELAY_MS = 1_000;

/**
 * 从 bridge message/session_key 解析 Hermit team slug。
 *
 * cc-connect 的外部平台 session_key 通常是 `feishu:{chat}:{user}`，不能当作
 * Hermit teamName 使用；否则消息会落到 `~/.hermit/teams/feishu:*` 这类错误目录。
 */
async function resolveTeamFromBridgeMessage(msg: unknown): Promise<string | null> {
  const sessionKey = (msg as { session_key?: string }).session_key ?? '';
  if (!sessionKey) return null;

  const explicitProject = getBridgeMessageProject(msg);
  if (explicitProject) {
    const teamName = await resolveTeamSlugFromCcProject(explicitProject);
    if (teamName) {
      cacheBridgeSessionTeam(sessionKey, teamName);
      return teamName;
    }
  }

  const parsedTeamName = parseHermitTeamFromSessionKey(sessionKey);
  if (parsedTeamName) return resolveTeamSlugFromTeamName(parsedTeamName);

  const cached = bridgeSessionTeamCache.get(sessionKey);
  if (cached && cached.expiresAt > Date.now()) return cached.teamName;

  if (isExternalPlatformSessionKey(sessionKey)) {
    const teamName = await resolveTeamSlugFromCcSessions(sessionKey);
    if (teamName) {
      cacheBridgeSessionTeam(sessionKey, teamName);
      return teamName;
    }
    return null;
  }

  return resolveTeamSlugFromTeamName(sessionKey);
}

async function resolveTeamFromBridgeMessageWithRetry(msg: unknown): Promise<string | null> {
  const sessionKey = (msg as { session_key?: string }).session_key ?? '';
  if (!isExternalPlatformSessionKey(sessionKey)) return resolveTeamFromBridgeMessage(msg);

  for (let attempt = 0; attempt <= EXTERNAL_PLATFORM_ROUTE_RETRY_COUNT; attempt++) {
    const teamName = await resolveTeamFromBridgeMessage(msg);
    if (teamName) return teamName;
    if (attempt < EXTERNAL_PLATFORM_ROUTE_RETRY_COUNT) {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_PLATFORM_ROUTE_RETRY_DELAY_MS));
    }
  }

  app.log.warn(
    { sessionKey },
    'external platform bridge message could not be mapped to a Hermit team slug'
  );
  return null;
}

function getBridgeMessageProject(msg: unknown): string {
  const raw = msg as { project?: unknown; project_name?: unknown };
  const value = typeof raw.project === 'string' ? raw.project : raw.project_name;
  return typeof value === 'string' ? value.trim() : '';
}

function cacheBridgeSessionTeam(sessionKey: string, teamName: string): void {
  bridgeSessionTeamCache.set(sessionKey, {
    teamName,
    expiresAt: Date.now() + BRIDGE_SESSION_TEAM_CACHE_TTL_MS,
  });
}

async function resolveTeamSlugFromCcProject(projectName: string): Promise<string | null> {
  try {
    const manifest = await svc.readTeamManifestByProject(projectName);
    return manifest.slug || projectName;
  } catch {
    return null;
  }
}

async function resolveTeamSlugFromTeamName(teamName: string): Promise<string | null> {
  try {
    const manifest = await svc.readTeamManifest(teamName);
    return manifest.slug || teamName;
  } catch {
    return teamName;
  }
}

async function resolveTeamSlugFromCcSessions(sessionKey: string): Promise<string | null> {
  const projects = await cc.listProjects().catch(() => []);
  for (const project of projects) {
    const sessions = await cc.listSessions(project.name).catch(() => []);
    if (!sessions.some((session) => session.session_key === sessionKey)) continue;
    return resolveTeamSlugFromCcProject(project.name);
  }

  const manifests = await svc.listTeams().catch(() => []);
  return resolveExternalPlatformSessionTeamSlug(sessionKey, manifests);
}

/**
 * 解析 Hermit 自己生成的 session_key。
 * 约定格式:
 *   hermit:{teamName}:session  (老格式)
 *   hermit:{teamName}:lead     (新格式)
 *   bridge:hermit-{team}:{member}
 */
function parseHermitTeamFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey) return null;
  const hermitMatch = /^hermit:([^:]+):/.exec(sessionKey);
  if (hermitMatch) return hermitMatch[1];
  const bridgeMatch = /^bridge:hermit-([^:]+):/.exec(sessionKey);
  if (bridgeMatch) return bridgeMatch[1];
  return null;
}

const dashboardRecentProjectsLoader = createDashboardRecentProjectsLoader({
  extraRoots: [REPO_ROOT, adminWorkDir()],
  logger: {
    info: (...args: unknown[]) => app.log.info({ args }, 'recent-projects'),
    warn: (...args: unknown[]) => app.log.warn({ args }, 'recent-projects'),
    error: (...args: unknown[]) => app.log.error({ args }, 'recent-projects'),
  },
});

// ===========================================================================
// Plugins
// ===========================================================================

const configuredCorsOrigins = process.env.CORS_ORIGIN?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const defaultWebPort = process.env.WEB_PORT?.trim() || '5174';
const allowedCorsOrigins = configuredCorsOrigins?.length
  ? configuredCorsOrigins
  : [
      `http://127.0.0.1:${PORT}`,
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${defaultWebPort}`,
      `http://localhost:${defaultWebPort}`,
    ];
const allowedOriginSet = new Set(allowedCorsOrigins);

function isLoopbackBrowserOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isTrustedBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOriginSet.has(origin)) return true;
  return isLoopbackBrowserOrigin(origin);
}

function assertTrustedBrowserOrigin(request: import('fastify').FastifyRequest): void {
  const origin = Array.isArray(request.headers.origin)
    ? request.headers.origin[0]
    : request.headers.origin;
  if (!isTrustedBrowserOrigin(origin)) {
    throw new Error(`Forbidden origin: ${origin}`);
  }
}

await app.register(cors, {
  origin: allowedCorsOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

// Security: reject any request carrying an untrusted `Origin` header, applied
// globally so every route is covered (previously only 5 of ~102 routes called
// assertTrustedBrowserOrigin). Browser same-origin requests and local
// non-browser tools (curl, CLI integrations) either omit Origin or send a
// loopback origin and pass; malicious cross-origin pages (DNS rebinding,
// drive-by) always send a foreign Origin on cross-origin writes and are blocked.
// Paired with the default loopback bind this is the local-service security boundary.
app.addHook('preHandler', async (request, reply) => {
  const origin = Array.isArray(request.headers.origin)
    ? request.headers.origin[0]
    : request.headers.origin;
  if (origin && !isTrustedBrowserOrigin(origin)) {
    return reply.code(403).send({ ok: false, error: 'Forbidden origin' });
  }
});

// ===========================================================================
// /api/bridge/* → hermit-bridge /api/v1/* (canonical proxy with token)
// /api/cc/*     → hermit-bridge /api/v1/* (legacy alias)
// /api/v1/*     → hermit-bridge /api/v1/* (兼容旧 renderer 直接打 /api/v1 的代码)
// ===========================================================================

registerBridgeProxyRoutes(app, {
  getRuntimeConfig: () => ({
    ccBaseUrl: runtimeConfig.ccBaseUrl,
    ccToken: runtimeConfig.ccToken,
  }),
});

// ===========================================================================
// Hermit config (read/write ~/.hermit/config.json)
// ===========================================================================

registerHermitConfigRoutes(app, {
  getConfig: () => runtimeConfig,
  saveConfig: (patch) => (runtimeConfig = saveConfig(patch)),
  readRaw: readHermitConfigRaw,
  writeRaw: (content) => (runtimeConfig = writeHermitConfigRaw(content)),
  updateBridgeClient: (config) => serverContext.services.bridgeClient.updateConfig(config),
  updateBridgeConnection: (config) => serverContext.services.bridgeConnection.updateConfig(config),
});

// ===========================================================================
// hermit-bridge config (Hermit-managed: ~/.hermit/cc-connect/config.toml)
// ===========================================================================

registerBridgeConfigRoutes(app, {
  readRaw: readHermitBridgeConfigTomlRaw,
  writeRaw: writeHermitBridgeConfigTomlRaw,
});

// ===========================================================================
// Health / cc-connect status (alias)
// ===========================================================================

registerRuntimeRoutes(app, {
  getStatus: () => serverContext.services.bridgeClient.getStatus(),
  getRuntimeReadiness,
  readEffectiveSettings: readEffectiveCcSettings,
  patchLocalSettings: (patch) => serverContext.services.ccSettings.patch(patch),
  patchRemoteSettings: (patch) => serverContext.services.bridgeClient.patchGlobalSettings(patch),
  defaultSettings: DEFAULT_HERMIT_CC_SETTINGS,
  restartBridge: restartHermitBridgeAndReconnect,
  reloadBridge: () => serverContext.services.bridgeClient.reload(),
  logger: app.log,
});

// ===========================================================================
// Teams — cc-connect projects 即团队，本地 ~/.hermit/teams/ 仅存 tasks + 额外元数据
// ===========================================================================

registerSystemManagerRoutes(app, {
  ensureSystemManager,
  ensureAdminLoopInitialized,
  systemManagerConfig: serverContext.services.systemManagerConfig,
  workflowPrompt: serverContext.services.workflowPrompt,
  assertTrustedBrowserOrigin,
});

registerTerminalRoutes(app, {
  assertTrustedBrowserOrigin,
  getSessionId: (sessionKey) => serverContext.services.directCli.getSessionId(sessionKey),
  resolveWorkDir: teamRuntimeOperations.resolveDirectCliWorkDir,
  resolveClaudeBinary: () => ClaudeBinaryResolver.resolve(),
});

// Worker Society REST 路由（/api/society/*）—— worker 自治社会的 HTTP 接口（workers/needs/social/feed）。

registerTeamDirectoryRoutes(
  app,
  {
    teamProvisioning: serverContext.services.teamProvisioning,
    bridgeClient: serverContext.services.bridgeClient,
    resolveProjectName: resolveRouteCcProjectName,
    getProjectStatsSnapshot,
    reply500,
  },
  { routes: ['core'] }
);

// ===========================================================================
// Tasks — 存储在 ~/.hermit/teams/:name/tasks/board.json
// 双向映射：TeamTask(pending/in_progress/completed) ↔ Task(todo/doing/done)
// 任务创建/指派只更新看板；只有显式点击开始才投递给 runtime/目标团队。
// ===========================================================================

const teamTaskRouteDependencies = {
  readTasks: (teamName: string) => svc.readTasks(teamName),
  createTask: (teamName: string, payload: Parameters<TeamProvisioningService['createTask']>[1]) =>
    svc.createTask(teamName, payload),
  patchTask: (
    teamName: string,
    taskId: string,
    patch: Parameters<TeamProvisioningService['patchTask']>[2]
  ) => svc.patchTask(teamName, taskId, patch),
  dispatchTask: (teamName: string, task: Parameters<TeamProvisioningService['dispatchTask']>[1]) =>
    svc.dispatchTask(teamName, task),
  listProjects: () => cc.listProjects(),
  reply500,
};

registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['core'] });

// ===========================================================================
// 协同开关 — PATCH /api/teams/:name/collaboration
// ===========================================================================

registerTeamRuntimeRoutes(
  app,
  {
    teamProvisioning: serverContext.services.teamProvisioning,
    bridgeClient: serverContext.services.bridgeClient,
    loopAssetsScanner: serverContext.services.loopAssetsScanner,
    directCliManager: serverContext.services.directCli,
    operations: teamRuntimeOperations,
    resolveProjectName: resolveRouteCcProjectName,
    restartBridge: restartHermitBridgeAndReconnect,
    reply500,
  },
  { routes: ['collaboration'] }
);

registerHeartbeatRoutes(app, {
  bridgeClient: serverContext.services.bridgeClient,
  resolveProjectName: resolveRouteCcProjectName,
});

// ===========================================================================
// Harness 列表 — 从 cc-connect projects 提取已用 agent_type，合并固定枚举
// GET /api/harnesses
// ===========================================================================

registerHarnessRoutes(app, {
  agentTypes: CC_AGENT_TYPES,
  listProjects: () => serverContext.services.bridgeClient.listProjects(),
});

registerTeamRuntimeRoutes(
  app,
  {
    teamProvisioning: serverContext.services.teamProvisioning,
    bridgeClient: serverContext.services.bridgeClient,
    loopAssetsScanner: serverContext.services.loopAssetsScanner,
    directCliManager: serverContext.services.directCli,
    operations: teamRuntimeOperations,
    resolveProjectName: resolveRouteCcProjectName,
    restartBridge: restartHermitBridgeAndReconnect,
    reply500,
  },
  { routes: ['runtime'] }
);

// ===========================================================================
// cc-connect setup proxy — QR code & platform binding flows
// These endpoints proxy to cc-connect /api/v1/setup/* APIs
// ===========================================================================

registerPlatformSetupRoutes(app, {
  getRuntimeConfig: () => ({
    ccBaseUrl: runtimeConfig.ccBaseUrl,
    ccToken: runtimeConfig.ccToken,
  }),
  persistPlatformMetadata: persistPlatformRoutingMetadataForProject,
  restartBridge: restartHermitBridgeAndReconnect,
  getProject: (projectName) => serverContext.services.bridgeClient.getProject(projectName),
  createProject: (projectName, agentType, workDir, platformType, options) =>
    serverContext.services.bridgeClient.createProject(
      projectName,
      agentType as HermitBridgeAgentType,
      workDir,
      platformType,
      options
    ),
});

// ===========================================================================
// 组织图 API — GET /api/graph
// 返回 nodes（团队）+ edges（任务 assignee 关系）供前端 Graph 渲染
// ===========================================================================

registerGraphRoutes(app, {
  listProjects: () => serverContext.services.bridgeClient.listProjects(),
  readTasks: (teamName) => serverContext.services.teamProvisioning.readTasks(teamName),
});

// ===========================================================================
// MCP Server — hermit-tasks (MCP over HTTP: SSE + JSON-RPC)
//
// Claude Code / Qoder 等 agent 通过 MCP 协议读取和更新任务。
// MCP 配置在创建团队时自动注入到 workDir/.claude/settings.json。
//
// Tools:
//   list_tasks(team_slug)
//   claim_task(team_slug, task_id)
//   complete_task(team_slug, task_id, result?)
//   create_task(team_slug, title, description?, assignee?)
// ===========================================================================

registerMcpRoutes(app, {
  readTasks: (teamSlug) => serverContext.services.teamProvisioning.readTasks(teamSlug),
  patchTask: (teamSlug, taskId, patch) =>
    serverContext.services.teamProvisioning.patchTask(teamSlug, taskId, patch),
});

// ===========================================================================
// Hermit 主仓 UI 首屏强依赖的几个 stub(占位实现)
// ===========================================================================

registerVersionUpdateRoutes(app, {
  version: pkg.version,
  updateService: serverContext.services.update,
});

registerWorkbenchStatusRoutes(app, {
  loadRecentProjects: dashboardRecentProjectsLoader,
});

registerAppConfigRoutes(app, {
  configFile: HERMIT_APP_CONFIG_FILE,
  hermitHome: HERMIT_HOME,
  logger: app.log,
});

function buildFallbackSessionKey(teamName: string): string {
  return `hermit:${teamName}:session`;
}

async function waitForHarnessBridgeConnected(
  timeoutMs = HARNESS_BRIDGE_CONNECT_TIMEOUT_MS
): Promise<void> {
  if (bridge.connected) return;
  bridge.start();
  if (bridge.connected) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('cc-connect Bridge 连接超时，无法发送到 harness'));
    }, timeoutMs);

    const onConnected = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timer);
      bridge.off('connected', onConnected);
    };

    bridge.on('connected', onConnected);
  });
}

async function sendHarnessMessageViaBridge(params: {
  teamName: string;
  text: string;
  sessionKey?: string;
  msgId?: string;
}): Promise<string> {
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
}

registerScheduleRoutes(app, {
  state: serverContext.state,
  bridgeClient: serverContext.services.bridgeClient,
  readTeamManifest: (teamName) =>
    serverContext.services.teamProvisioning.readTeamManifest(teamName),
  broadcastSse,
  buildFallbackSessionKey,
  reply500,
});

registerWorkspaceRoutes(app);

// ===========================================================================
// Project Editor API (web mode)
// ===========================================================================

registerEditorRoutes(app);

// ===========================================================================
// 团队详情页强依赖的 stubs — 返回正确数据结构防止 store 解析失败
// ===========================================================================

const teamMessageRouteDependencies = {
  readMessages: (teamName: string, options: { limit?: number }) =>
    svc.readMessages(teamName, options),
  appendMessage: (
    teamName: string,
    message: Parameters<TeamProvisioningService['appendMessage']>[1]
  ) => svc.appendMessage(teamName, message),
  resolveProjectName: resolveRouteCcProjectName,
  listSessions: (projectName: string) => cc.listSessions(projectName),
  buildFallbackSessionKey,
  sendHarnessMessageViaBridge,
  readEffectiveCcSettings,
  resolveDirectCliWorkDir: teamRuntimeOperations.resolveDirectCliWorkDir,
  dispatchDirectCliMessage: teamRuntimeOperations.dispatchDirectCliMessage,
  broadcastSse,
};
registerTeamMessageRoutes(app, teamMessageRouteDependencies, { routes: ['read'] });

registerTeamSessionRoutes(app, {
  readTeamManifest: (teamName) => svc.readTeamManifest(teamName),
  readHiddenSessionIds: (teamName) => svc.readHiddenSessionIds(teamName),
  hideSession: (teamName, sessionId) => svc.hideSession(teamName, sessionId),
  listTeams: () => svc.listTeams(),
  scanSummaries: (workDir, projectId) => localSessionScanner.scanSummaries(workDir, projectId),
  readSessionDetail: (workDir, sessionId, options) =>
    localSessionScanner.readSessionDetail(workDir, sessionId, options),
  listSessions: (projectName) => cc.listSessions(projectName),
  getSession: (projectName, sessionId, historyLimit) =>
    cc.getSession(projectName, sessionId, historyLimit),
  deleteSession: (projectName, sessionId) => cc.deleteSession(projectName, sessionId),
  listProjects: () => cc.listProjects(),
  getProject: (projectName) => cc.getProject(projectName),
  resolveProjectName: resolveRouteCcProjectName,
});

registerTeamMessageRoutes(app, teamMessageRouteDependencies, { routes: ['process'] });

registerTeamCompatibilityRoutes(app);
registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['compatibility'] });
registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['actions'] });

registerTeamMemberCompatibilityRoutes(app);

registerTeamDirectoryRoutes(
  app,
  {
    teamProvisioning: serverContext.services.teamProvisioning,
    bridgeClient: serverContext.services.bridgeClient,
    resolveProjectName: resolveRouteCcProjectName,
    getProjectStatsSnapshot,
    reply500,
  },
  { routes: ['restore'] }
);

const teamConfigRouteDependencies = {
  teamProvisioning: serverContext.services.teamProvisioning,
  bridgeClient: serverContext.services.bridgeClient,
  resolveProjectName: resolveRouteCcProjectName,
  readConfigTomlRaw: readHermitBridgeConfigTomlRaw,
  writeConfigTomlRaw: writeHermitBridgeConfigTomlRaw,
  reply500,
  agentTypes: CC_AGENT_TYPES,
};

registerTeamConfigRoutes(app, teamConfigRouteDependencies, { routes: ['core'] });

registerTeamProvisioningCompatibilityRoutes(app);

registerTeamMessageRoutes(app, teamMessageRouteDependencies, { routes: ['send'] });

// ===========================================================================
// 路由别名 — 修正前端调用路径与服务端路径的不匹配
// ===========================================================================

registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['review-aliases'] });

registerTeamConfigRoutes(app, teamConfigRouteDependencies, { routes: ['put'] });

registerTeamActionCompatibilityRoutes(app, { routes: ['member-skip'] });
registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['late-aliases'] });
registerTeamActionCompatibilityRoutes(app, { routes: ['remaining'] });

registerTeamMemberStatsRoutes(app, {
  readTeamManifest: (teamName) => svc.readTeamManifest(teamName),
  scanSummaries: (workDir, projectId) => localSessionScanner.scanSummaries(workDir, projectId),
  readTasksForStats: (teamName) => {
    // eslint-disable-next-line @typescript-eslint/dot-notation -- bracket access intentionally bypasses TS private modifier
    return svc['workspace'].readTasks(teamName);
  },
});

registerToolApprovalRoutes(app, {
  state: serverContext.state,
  respondPermission: (sessionKey, requestId, allow, message, updatedInput) =>
    directCliManager.respondPermission(sessionKey, requestId, allow, message, updatedInput),
  logger: app.log,
});

registerWorkerRoutes(app, {
  discoverTeams: () => svc.discoverTeams(),
  resolveTeamSlugForMention,
  ensureLoopSessionProjectReady: teamRuntimeOperations.ensureLoopSessionProjectReady,
  listSessions: (projectName) => cc.listSessions(projectName),
  createSession: (projectName, name, sessionKey) => cc.createSession(projectName, name, sessionKey),
  sendHarnessMessageViaBridge,
  appendMessage: (teamSlug, message) => svc.appendMessage(teamSlug, message),
  broadcastSse,
  buildFallbackSessionKey,
});

registerTaskBusSettingsRoutes(app, {
  settingsFile: HERMIT_SETTINGS_FILE,
  bridgeClient: serverContext.services.bridgeClient,
  teamProvisioning: serverContext.services.teamProvisioning,
  isExternalTelemetryWorkerRunning,
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
  readTaskBusSettings: () => readTaskBusSettingsFromFile(HERMIT_SETTINGS_FILE),
  triggerScan,
  getTelemetryStatus,
  readWorkerStatus: () => readUsageTelemetryWorkerStatus(HERMIT_HOME),
};

registerUsageTelemetryRoutes(app, usageTelemetryRouteDependencies);

registerConversationTelemetryRoutes(app, {
  conversationTelemetry: serverContext.services.conversationTelemetry,
});

registerUsageTelemetryStatusRoutes(app, usageTelemetryRouteDependencies);

registerReviewCompatibilityRoutes(app);

// ===========================================================================
// SSE 推送端点 — 前端 EventSource 连接此处接收实时事件
// ===========================================================================

registerSseRoutes(app, {
  state: serverContext.state,
  assertTrustedBrowserOrigin,
});

// ── Extension Store routes (wired to extensionHandlers) ────────────────

const extensionHandlers = serverContext.services.extensions;

registerExtensionPluginRoutes(app, { handlers: extensionHandlers });
registerExtensionMcpStoreRoutes(app, { handlers: extensionHandlers });
registerCapabilityPackRoutes(app, {
  handlers: extensionHandlers,
  localSource: {
    projectPath: REPO_ROOT,
    listCronJobs: () => cc.listCronJobs(),
    listTeams: async () => {
      const manifests = await svc.listTeams().catch(() => []);
      return manifests
        .filter((team) => !team.deletedAt)
        .map((team) => ({
          slug: team.slug,
          displayName: team.displayName,
          workDir: team.workDir,
          bindProject: team.bindProject,
        }));
    },
  },
  setLocalSource: setCapabilityPackLocalSource,
  setSkillsWatcherEmitter,
  broadcastSse,
});
registerExtensionSkillRoutes(app, { handlers: extensionHandlers });
registerExtensionCredentialRoutes(app, { handlers: extensionHandlers });

registerWorkbenchNotFoundHandler(app, {
  staticDir: STATIC_DIR,
  state: serverContext.state,
});

// ===========================================================================
// Static resources(vite build 产物)— 必须最后注册,放在 setNotFoundHandler 之后
// ===========================================================================

await registerStaticRoutes(app, { staticDir: STATIC_DIR });

// ===========================================================================
// Helpers
// ===========================================================================

function reply500(err: unknown) {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

// ===========================================================================
// Start
// ===========================================================================

await startStandaloneServerRuntime({
  app,
  bridgeLauncher: serverContext.services.bridgeLauncher,
  bridgeClient: serverContext.services.bridgeClient,
  bridge: serverContext.services.bridgeConnection,
  imLiveWatcher: serverContext.services.imLiveWatcher,
  initializeTelemetryFromSettings,
  ensureGlobalWorkflows,
  markBridgeBinaryCheck,
  markBridgeLaunch,
  processTarget: process,
  bridgeConfigPath: HERMIT_BRIDGE_CONFIG_FILE,
  bridgeLogFile: path.join(HERMIT_HOME, 'cc-connect', 'cc-connect.log'),
  bridgeAutoLaunchTimeoutMs: HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS,
  host: HOST,
  port: PORT,
  staticDir: STATIC_DIR,
  bridgeBaseUrl:
    process.env.HERMIT_BRIDGE_BASE_URL ??
    process.env.CC_CONNECT_BASE_URL ??
    'http://127.0.0.1:9820',
  bridgeWsUrl:
    process.env.HERMIT_BRIDGE_WS_URL ??
    process.env.CC_CONNECT_BRIDGE_URL ??
    'ws://127.0.0.1:9810/bridge/ws',
});

const shutdownWorkbenchServer = createWorkbenchShutdown({
  app,
  lifecycle: serverContext.lifecycle,
  sseClients: serverContext.state.sseClients,
  stopTelemetry,
  imLiveWatcher: serverContext.services.imLiveWatcher,
  directCliManager: serverContext.services.directCli,
  bridgeLauncher: serverContext.services.bridgeLauncher,
  bridge: serverContext.services.bridgeConnection,
});
let removeProcessHandlers: () => void = () => undefined;
const shutdown = createServerShutdown({
  shutdownWorkbenchServer,
  processTarget: process,
  removeProcessHandlers: () => removeProcessHandlers(),
});

// Last-resort safety net: log unhandled rejections instead of letting them
// kill the process, and reap direct-CLI subprocesses on any exit path that
// skips the asynchronous shutdown path.
removeProcessHandlers = installServerProcessHandlers({
  app,
  directCliManager: serverContext.services.directCli,
  processTarget: process,
  shutdown,
});
