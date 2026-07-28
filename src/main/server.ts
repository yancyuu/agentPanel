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
import { buildDirectReplyMessageId, DirectCliSessionManager } from './services/direct-cli';
import { buildTeamCapabilityTelemetrySnapshots } from './services/extensions/capability-packs/CapabilityPackLoaderService';
import { httpsGetFollowRedirects } from './services/extensions/catalog/PluginCatalogService';
import { HermitBridgeClient } from './services/hermitBridge/HermitBridgeClient';
import { HermitBridgeConnection } from './services/hermitBridge/HermitBridgeConnection';
import { HermitBridgeLauncher } from './services/hermitBridge/HermitBridgeLauncher';
import {
  isPlaceholderWorkDir,
  needsWorkDirReconcile,
} from './services/hermitBridge/workDirReconcile';
import { LoopAssetsScannerService } from './services/loop-assets/LoopAssetsScannerService';
import {
  ConversationTelemetryService,
  shouldIncludeContent,
} from './services/session-intelligence/ConversationTelemetryService';
import { defaultImSessionsDir, ImLiveWatcher } from './services/session-intelligence/ImLiveWatcher';
import { LocalSessionScanner } from './services/session-intelligence/LocalSessionScanner';
import {
  type ProjectUsageStats,
  scanProjectStats,
} from './services/session-intelligence/SessionUsageParser';
import {
  filterHiddenTeamSessions,
  mergeLocalAndCcSessions,
} from './services/session-intelligence/teamSessionListMapper';
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
import { createServerContext, createServerRuntimeState } from './serverContext';
import { registerAppConfigRoutes } from './routes/appConfigRoutes';
import { registerBridgeConfigRoutes } from './routes/bridgeConfigRoutes';
import { registerBridgeProxyRoutes } from './routes/bridgeProxyRoutes';
import { registerGraphRoutes } from './routes/graphRoutes';
import { registerHarnessRoutes } from './routes/harnessRoutes';
import { registerHermitConfigRoutes } from './routes/hermitConfigRoutes';
import { registerMcpRoutes } from './routes/mcpRoutes';
import { registerPlatformSetupRoutes } from './routes/platformSetupRoutes';
import { registerEditorRoutes } from './routes/editorRoutes';
import { registerHeartbeatRoutes } from './routes/heartbeatRoutes';
import { registerWorkbenchNotFoundHandler } from './routes/notFoundHandler';
import { registerReviewCompatibilityRoutes } from './routes/reviewCompatibilityRoutes';
import { registerRuntimeRoutes } from './routes/runtimeRoutes';
import { registerScheduleRoutes } from './routes/scheduleRoutes';
import { registerSseRoutes } from './routes/sseRoutes';
import { registerStaticRoutes } from './routes/staticRoutes';
import { registerSystemManagerRoutes } from './routes/systemManagerRoutes';
import { registerTerminalRoutes } from './routes/terminalRoutes';
import { registerToolApprovalRoutes } from './routes/toolApprovalRoutes';
import { registerVersionUpdateRoutes } from './routes/versionUpdateRoutes';
import { registerWorkbenchStatusRoutes } from './routes/workbenchStatusRoutes';
import { registerWorkerRoutes } from './routes/workerRoutes';
import { registerWorkspaceRoutes } from './routes/workspaceRoutes';
import { registerServerEventHandlers } from './serverEventHandlers';
import {
  createServerShutdown,
  createWorkbenchShutdown,
  installServerProcessHandlers,
} from './serverProcessLifecycle';
import { startStandaloneServerRuntime } from './serverStartup';
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

import type {
  HermitBridgeAgentType,
  HermitBridgeProjectPlatform,
  HermitBridgeSessionDetail,
  HermitBridgeSessionListItem,
} from '../shared/types/hermitBridge';
import type {
  UsageTelemetryStatus,
  UsageUnresolvedSummary,
  UserUsageTelemetryRow,
} from './services/session-intelligence/usageTypes';
import type { TeamManifest } from './services/team-management/TeamWorkspaceService';
import type { CcSessionDetail } from '@shared/types/api';
import type {
  CapabilityCommandPromptRequest,
  CapabilityPackExportRequest,
  CapabilityPackImportRequest,
  CapabilityTelemetrySummary,
  McpCustomInstallRequest,
  McpLibraryImportRequest,
  McpLibraryUpsertRequest,
  PluginInstallRequest,
  SkillDeleteRequest,
  SkillImportRequest,
  SkillUpsertRequest,
  TeamCapabilityTelemetrySnapshot,
} from '@shared/types/extensions';
import type {
  AttachmentFileData,
  AttachmentMeta,
  AttachmentPayload,
  SystemManagerSummary,
  TeamLaunchRequest,
  TelemetryConfig,
} from '@shared/types/team';

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
const CC_AGENT_TYPES: readonly HermitBridgeAgentType[] = [
  'claudecode',
  'codex',
  'cursor',
  'gemini',
  'iflow',
  'kimi',
  'devin',
  'opencode',
  'qoder',
  'pi',
  'acp',
  'tmux',
];
const SYSTEM_MANAGER_DESCRIPTION =
  '项目级 Claude Code Helm Loop，负责插件、MCP、Env、数字员工和统计数据的托管管理。';

function toHermitBridgeAgentType(value: string | undefined): HermitBridgeAgentType {
  return CC_AGENT_TYPES.includes(value as HermitBridgeAgentType)
    ? (value as HermitBridgeAgentType)
    : 'claudecode';
}

function isReservedSystemTeamName(teamName: string): boolean {
  return (
    teamName === 'default' ||
    teamName === SYSTEM_MANAGER_BIND_PROJECT ||
    teamName === SYSTEM_MANAGER_TEAM_NAME
  );
}

function isAttachmentPayload(value: unknown): value is AttachmentPayload {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as Partial<AttachmentPayload>;
  return (
    typeof attachment.id === 'string' &&
    typeof attachment.filename === 'string' &&
    typeof attachment.mimeType === 'string' &&
    typeof attachment.size === 'number' &&
    typeof attachment.data === 'string'
  );
}

function toAttachmentMeta(attachment: AttachmentPayload): AttachmentMeta {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    filePath: attachment.filePath,
  };
}

function toAttachmentFileData(attachment: AttachmentPayload): AttachmentFileData {
  return {
    id: attachment.id,
    data: attachment.data,
    mimeType: attachment.mimeType,
  };
}

function shouldSendAttachmentsToAgent(settings: Record<string, unknown>): boolean {
  return settings.attachment_send !== 'off';
}

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
const { sseClients, directCliRoutes, bridgeSessionTeamCache, teamStatsCache } = serverRuntimeState;

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
      await dispatchDirectCliMessage({
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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
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

function normalizePlatformAllowFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(
      ([platform, allowFrom]) =>
        [platform.trim(), typeof allowFrom === 'string' ? allowFrom.trim() : ''] as const
    )
    .filter(([platform, allowFrom]) => platform.length > 0 && allowFrom.length > 0);
  return Object.fromEntries(entries);
}

function hasPlatformAllowDeleteMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([platform, allowFrom]) =>
      platform.trim().length > 0 && (typeof allowFrom !== 'string' || allowFrom.trim().length === 0)
  );
}

function normalizePlatformAllowUpdate(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const normalized = normalizePlatformAllowFrom(value);
  if (Object.keys(normalized).length > 0) {
    if (normalized.lark !== undefined) delete normalized.feishu;
    return normalized;
  }
  return Object.keys(value).length === 0 || hasPlatformAllowDeleteMarker(value) ? {} : undefined;
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

function isCcProjectNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /project not found:/i.test(message);
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
  resolveWorkDir: resolveDirectCliWorkDir,
  resolveClaudeBinary: () => ClaudeBinaryResolver.resolve(),
});

// Worker Society REST 路由（/api/society/*）—— worker 自治社会的 HTTP 接口（workers/needs/social/feed）。

// GET /api/teams → Hermit 本地团队优先，裸 cc-connect project 作为历史兼容显示；过滤飞书/系统项目
app.get('/api/teams', async () => {
  try {
    const [projects, localTeams] = await Promise.all([
      cc.listProjects().catch(() => []),
      svc.listTeams().catch(() => []),
    ]);
    const projectByName = new Map(projects.map((project) => [project.name, project]));
    const shouldHideProject = (name: string): boolean =>
      isReservedSystemTeamName(name) || name.startsWith('feishu:');

    const summaries = await Promise.all(
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
          // Keep the list endpoint fast: per-team cc.getProject calls are slow and
          // block first paint. Runtime liveness is loaded separately via aliveList.
          const workDir = (meta.workDir || '').trim();
          const projectPath = (meta.workDir || '').trim();
          const harness = toHermitBridgeAgentType(project?.agent_type || meta.harness);
          const color = meta.color || 'blue';
          const displayName = meta.displayName || meta.slug;
          const usageStats = workDir ? getProjectStatsSnapshot(workDir) : null;

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

    return summaries;
  } catch {
    return [];
  }
});

// POST /api/teams/create → 直接在 cc-connect 创建 project
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

    // Validate bindProject is ASCII-safe (for URL routing and cc-connect project name)
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(bindProject)) {
      return reply.code(400).send({
        error: '项目标识只能包含小写英文字母、数字、连字符和下划线，且必须以字母或数字开头',
      });
    }

    // Check for duplicate bindProject (unique identifier, replaces displayName duplicate check)
    const existingTeams = await svc.listTeams().catch(() => []);
    const duplicateProject = existingTeams.find(
      (t) => t.bindProject?.toLowerCase() === bindProject.toLowerCase()
    );
    if (duplicateProject) {
      return reply.code(409).send({
        error: `项目标识"${bindProject}"已被"${duplicateProject.displayName}"使用，请换一个。`,
      });
    }

    // Normalize path: fullwidth tilde → regular tilde, expand ~ to home
    workDir = workDir.replace(/\uff5e/g, '~');
    if (workDir.startsWith('~')) {
      workDir = path.join(os.homedir(), workDir.slice(1));
    }

    // 本地创建只落 Hermit 团队目录；飞书/微信等外部平台在团队内按需绑定。
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
  } catch (err) {
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/teams/:name/data → TeamViewSnapshot (cc-connect project 为主，本地 tasks 为辅)
app.get<{ Params: { name: string } }>('/api/teams/:name/data', async (request, reply) => {
  const { name } = request.params;

  // 本地元数据（始终尝试读取）
  let displayName = name; // 默认使用 team ID
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
    if (typeof meta.replyFooter === 'boolean') {
      replyFooter = meta.replyFooter;
    }
    if (typeof meta.injectSender === 'boolean') {
      injectSender = meta.injectSender;
    }
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
    /* no local manifest */
  }

  // 本地任务
  const rawTasks = activeTasks(await svc.readTasks(name).catch(() => []));
  const teamTasks = rawTasks.map(toTeamTask);

  try {
    bindProject = await resolveRouteCcProjectName(name);
    const p = await cc.getProject(bindProject);
    const isOnline = Array.isArray(p.platforms) && p.platforms.some((pl) => pl.connected);
    const projectSettings = (p.settings ?? {}) as Record<string, unknown>;
    const resolvedLanguage =
      typeof projectSettings.language === 'string' && projectSettings.language.trim().length > 0
        ? projectSettings.language.trim()
        : language;
    const resolvedManagedSources =
      typeof projectSettings.admin_from === 'string' && projectSettings.admin_from.trim().length > 0
        ? projectSettings.admin_from.trim()
        : managedSources;
    const resolvedDisabledCommands =
      Array.isArray(projectSettings.disabled_commands) &&
      normalizeStringArray(projectSettings.disabled_commands).length > 0
        ? normalizeStringArray(projectSettings.disabled_commands)
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
    const resolvedPlatformAllowFrom = (() => {
      const normalized = normalizePlatformAllowFrom(projectSettings.platform_allow_from);
      if (Object.keys(normalized).length > 0) {
        return normalized;
      }
      return platformAllowFrom;
    })();
    const resolvedPlatformAllowChat = (() => {
      const normalized = normalizePlatformAllowFrom(projectSettings.platform_allow_chat);
      if (Object.keys(normalized).length > 0) {
        return normalized;
      }
      return platformAllowChat;
    })();
    const resolvedPermissionMode =
      typeof p.agent_mode === 'string' && p.agent_mode.trim().length > 0
        ? p.agent_mode.trim()
        : permissionMode;
    const [providerRefs, globalProviders] = await Promise.all([
      cc.getProviderRefs(bindProject).catch(() => []),
      cc.listProviders().catch(() => []),
    ]);

    return {
      teamName: name,
      config: {
        name: displayName, // 使用 displayName 作为展示名称
        color,
        description,
        language: resolvedLanguage,
        agentType: p.agent_type,
        permissionMode: resolvedPermissionMode,
        showContextIndicator: resolvedShowContextIndicator,
        replyFooter: resolvedReplyFooter,
        injectSender: resolvedInjectSender,
        managedSources: resolvedManagedSources,
        disabledCommands: resolvedDisabledCommands,
        platformAllowFrom: resolvedPlatformAllowFrom,
        platformAllowChat: resolvedPlatformAllowChat,
        projectPath: workDir || p.work_dir,
        members: [{ name: displayName, role: 'lead' }],
      },
      tasks: teamTasks,
      members: [
        {
          name: displayName,
          agentId: p.agent_type,
          agentType: p.agent_type,
          role: 'lead',
          color,
          currentTaskId: null,
          taskCount: teamTasks.length,
        },
      ],
      kanbanState: { teamName: name, reviewers: [], tasks: {} },
      processes: [],
      isAlive: isOnline,
      platforms: p.platforms ?? [],
      harness: p.agent_type,
      bindProject,
      collaboration,
      description,
      workDir: workDir || p.work_dir,
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
      heartbeat: p.heartbeat,
      activeSessions: p.active_session_keys ?? [],
    };
  } catch {
    // Project deleted from cc-connect (e.g., after stop) — return offline team data from local metadata
    return {
      teamName: name,
      config: {
        name: displayName, // 使用 displayName 作为展示名称
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

// PATCH /api/teams/:name — 更新团队元数据
app.patch<{
  Params: { name: string };
  Body: { displayName?: string; color?: string; description?: string };
}>('/api/teams/:name', async (request, reply) => {
  try {
    const updated = await svc.updateTeam(request.params.name, request.body ?? {});
    return { ok: true, data: updated };
  } catch (err) {
    return reply.code(404).send(reply500(err));
  }
});

// DELETE /api/teams/:name
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
        // Team may only exist in cc-connect or local metadata may already be gone.
      }
      if (isReservedSystemTeamName(ccProjectName) || isReservedSystemTeamName(localTeamName)) {
        return reply.code(403).send({ error: 'Helm Loop 不可删除' });
      }
      try {
        await svc.deleteTeam(localTeamName, { deleteFiles: request.query.deleteFiles === 'true' });
      } catch (err) {
        request.log.warn(
          { err, teamName, localTeamName },
          'delete local team metadata failed or already missing'
        );
      }

      return { ok: true, restartRequired };
    } catch (err) {
      return reply.code(500).send(reply500(err));
    }
  }
);

// ===========================================================================
// Tasks — 存储在 ~/.hermit/teams/:name/tasks/board.json
// 双向映射：TeamTask(pending/in_progress/completed) ↔ Task(todo/doing/done)
// 任务创建/指派只更新看板；只有显式点击开始才投递给 runtime/目标团队。
// ===========================================================================

/** TeamTask status → internal Task status */
function toTaskStatus(s: string): 'todo' | 'doing' | 'done' {
  if (s === 'in_progress') return 'doing';
  if (s === 'completed') return 'done';
  return 'todo';
}

function isManualInProgressExitBlocked(
  currentStatus: string | undefined,
  nextStatus: 'todo' | 'doing' | 'done' | undefined
): boolean {
  return currentStatus === 'doing' && nextStatus !== undefined && nextStatus !== 'doing';
}

/** internal Task → TeamTask shape (for UI consumption) */
function toTeamTask(task: {
  id: string;
  title?: string;
  subject?: string;
  description?: string;
  status: string;
  assignee?: string | null;
  result?: string | null;
  createdAt: string;
  updatedAt: string;
  order: number;
  teamSlug: string;
}) {
  const statusMap: Record<string, string> = {
    todo: 'pending',
    doing: 'in_progress',
    done: 'completed',
  };
  return {
    id: task.id,
    displayId: task.id.slice(0, 8),
    subject: task.title ?? task.subject ?? '',
    description: task.description ?? '',
    status: statusMap[task.status] ?? 'pending',
    owner: task.assignee ?? undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    result: task.result ?? undefined,
  };
}

function isSoftDeletedTask(task: { result?: string | null }): boolean {
  return task.result === '__deleted__';
}

function activeTasks<T extends { result?: string | null }>(tasks: T[]): T[] {
  return tasks.filter((task) => !isSoftDeletedTask(task));
}

app.get<{ Params: { name: string } }>('/api/teams/:name/tasks', async (request) => {
  try {
    const tasks = activeTasks(await svc.readTasks(request.params.name));
    return tasks.map(toTeamTask);
  } catch {
    return [];
  }
});

app.post<{ Params: { name: string }; Body: Record<string, unknown> }>(
  '/api/teams/:name/tasks',
  async (request, reply) => {
    const body = request.body ?? {};
    // 支持 subject（TeamTask）或 title（内部）
    const title = (body.subject ?? body.title) as string | undefined;
    if (!title) return reply.code(400).send({ error: 'title/subject required' });
    const task = await svc.createTask(request.params.name, {
      title,
      description: body.description as string | undefined,
      assignee: (body.owner ?? body.assignee) as string | null | undefined,
      status: body.status ? toTaskStatus(body.status as string) : 'todo',
    });
    return toTeamTask(task);
  }
);

app.patch<{ Params: { name: string; id: string }; Body: Record<string, unknown> }>(
  '/api/teams/:name/tasks/:id',
  async (request, reply) => {
    const body = request.body ?? {};
    const patch: Record<string, unknown> = {};
    const nextStatus = body.status !== undefined ? toTaskStatus(body.status as string) : undefined;
    if (body.subject !== undefined) patch.title = body.subject;
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (nextStatus !== undefined) patch.status = nextStatus;
    if (body.owner !== undefined) patch.assignee = body.owner;
    if (body.assignee !== undefined) patch.assignee = body.assignee;
    if (body.result !== undefined) patch.result = body.result;

    const tasks = await svc.readTasks(request.params.name);
    const existingTask = tasks.find((task) => task.id === request.params.id);
    if (isManualInProgressExitBlocked(existingTask?.status, nextStatus)) {
      return reply.code(409).send({
        ok: false,
        error: 'Agent 正在处理中，不能手动完成或取消。请等待 agent 调用 complete_task。',
      });
    }

    const task = await svc.patchTask(request.params.name, request.params.id, patch);
    return toTeamTask(task);
  }
);

app.delete<{ Params: { name: string; id: string } }>(
  '/api/teams/:name/tasks/:id',
  async (request, reply) => {
    try {
      const tasks = await svc.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (existingTask?.status === 'doing') {
        return reply.code(409).send({
          ok: false,
          error: 'Agent 正在处理中，不能手动删除任务。',
        });
      }
      await svc.patchTask(request.params.name, request.params.id, {
        status: 'done',
        result: '__deleted__',
      });
      return { ok: true };
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  }
);

// ===========================================================================
// 协同开关 — PATCH /api/teams/:name/collaboration
// ===========================================================================

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
    } catch (err) {
      return reply.code(404).send(reply500(err));
    }
  }
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

app.get<{ Params: { name: string } }>('/api/teams/:name/loop-assets', async (request, reply) => {
  try {
    const name = request.params.name;
    const manifest = await svc.readTeamManifest(name);
    let bindProject = manifest.bindProject || name;
    let workDir = manifest.workDir || '';
    let platforms: { type: string; connected?: boolean }[] = [];

    try {
      bindProject = await resolveRouteCcProjectName(name);
      const project = await cc.getProject(bindProject).catch(() => null);
      if (!workDir && project?.work_dir) workDir = project.work_dir;
      platforms = Array.isArray(project?.platforms)
        ? project.platforms.map((platform) => ({
            type: platform.type,
            connected: platform.connected,
          }))
        : [];
    } catch {
      /* Local manifest data is enough for a best-effort scan. */
    }

    const [tasks, messages] = await Promise.all([
      svc.readTasks(name).catch(() => []),
      svc.readMessages(name).catch(() => []),
    ]);

    return await loopAssetsScanner.scanTeam({
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
  } catch (err) {
    return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function ensureLoopSessionProjectReady(teamName: string): Promise<{
  bindProject: string;
  projectExists: boolean;
  isOnline: boolean;
}> {
  if (teamName === SYSTEM_MANAGER_TEAM_NAME) {
    await ensureSystemManager();
  }

  let manifest: TeamManifest | null = null;
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
      Array.isArray(project.platforms) && project.platforms.some((platform) => platform.connected);
    if (typeof project.work_dir === 'string') projectWorkDir = project.work_dir.trim();
    // Only inherit the project's work_dir when the manifest has none AND it isn't the
    // cc-connect default template placeholder — adopting the placeholder would keep the
    // agent pointed at a non-existent directory and break every session.
    if (!workDir && !isPlaceholderWorkDir(projectWorkDir)) {
      workDir = projectWorkDir;
    }
  } catch {
    // Project can be missing after cc-connect reset; create it below when possible.
  }

  // Reconcile work_dir: cc-connect spawns the agent with chdir(work_dir), so a stale or
  // placeholder work_dir makes every session fail with "启动 Agent 会话失败" — the session
  // record is created (so the user sees the success message) but the agent never starts.
  // This runs whether or not the project is "online": the Helm Loop's bind project is
  // `my-project`, which is online via bridge yet still carries the template placeholder
  // work_dir, so the isOnline branch below would skip it. The PATCH updates the live agent
  // immediately and persists to config.toml (no restart required).
  if (projectExists && workDir && needsWorkDirReconcile(projectWorkDir, workDir)) {
    try {
      await cc.updateProject(bindProject, { work_dir: workDir });
      projectWorkDir = workDir;
    } catch (err) {
      app.log.warn({ err, bindProject, workDir }, 'cc-connect work_dir reconcile failed');
    }
  }

  if (!isOnline) {
    if (!projectExists) {
      if (!workDir) {
        throw new Error('团队缺少项目路径，无法启动 Loop runtime');
      }
      await cc.createProject(bindProject, harness, workDir, platformType, platformOptions);
      projectExists = true;
    }

    await restartHermitBridgeAndReconnect();
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

/**
 * Resolve the work_dir for a direct-CLI session WITHOUT cc-connect side effects (no
 * project create / restart). Prefers the team manifest's workDir; falls back to the
 * cc-connect project work_dir only when it is a real path (never the template
 * placeholder). The system-manager workDir is synced into its manifest from the runtime
 * config, so this reads the same source for admin and team loops.
 */
async function resolveDirectCliWorkDir(teamName: string): Promise<string> {
  if (teamName === SYSTEM_MANAGER_TEAM_NAME) {
    await ensureSystemManager().catch(() => undefined);
  }
  let manifest: TeamManifest | null = null;
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

/**
 * Register a direct-CLI session route and dispatch a user turn to it. The subprocess
 * spawns lazily (resuming a persisted claude session when possible) and this resolves
 * once the turn is on stdin; the streamed reply arrives later via the manager event
 * listener above.
 */
async function dispatchDirectCliMessage(params: {
  teamName: string;
  sessionKey: string;
  workDir: string;
  from: string;
  to: string;
  text: string;
  attachments?: AttachmentPayload[];
  messageId: string;
}): Promise<void> {
  directCliRoutes.set(params.sessionKey, {
    teamName: params.teamName,
    from: params.from,
    to: params.to,
  });
  await directCliManager.send(params.sessionKey, {
    text: params.text,
    attachments: params.attachments,
    messageId: params.messageId,
    workDir: params.workDir,
  });
}

app.post<{
  Params: { name: string };
  Body: { sessionName?: unknown; message?: unknown; reuse?: unknown };
}>('/api/teams/:name/loop-session', async (request, reply) => {
  try {
    const teamName = request.params.name;
    const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';
    const reuse = request.body?.reuse === true;
    const requestedSessionName =
      typeof request.body?.sessionName === 'string' ? request.body.sessionName.trim() : '';
    const sessionName =
      requestedSessionName || `Loop ${new Date().toISOString().replace(/[:.]/g, '-')}`;

    const workDir = await resolveDirectCliWorkDir(teamName);
    if (!workDir) {
      return reply.code(400).send({ error: '团队缺少项目路径，无法启动 Loop runtime' });
    }

    // One long-lived lead subprocess per team, resumed across sends (--resume keeps the
    // claude conversation continuous, like an interactive terminal session).
    const sessionKey = `${teamName}:lead`;
    // "Reused" means the claude conversation continues (--resume), which is true
    // whenever a session id is known — in-memory OR persisted in the store. The
    // in-memory-only `has()` would wrongly report false right after a Hermit
    // restart even though the subprocess resumes the same conversation.
    const reused = reuse && directCliManager.getSessionId(sessionKey) != null;

    let messageSent = false;
    if (message) {
      const messageId = buildDirectReplyMessageId(sessionKey);
      await dispatchDirectCliMessage({
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
        id: directCliManager.getSessionId(sessionKey) ?? sessionKey,
        name: sessionName,
        session_key: sessionKey,
        title: sessionName,
      },
      reused,
      messageSent,
    };
  } catch (err) {
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ===========================================================================
// 团队启动 — 直接通过 cc-connect 激活 project/runtime
// POST /api/teams/:name/launch  → 补建 project（如缺失）并 restart cc-connect
// POST /api/teams/:name/stop    → 无需操作（cc-connect 自管理），返回 ok
// ===========================================================================

app.post<{ Params: { name: string }; Body: Partial<TeamLaunchRequest> }>(
  '/api/teams/:name/launch',
  async (request, reply) => {
    try {
      const name = request.params.name;
      const body = request.body ?? {};
      let manifest: TeamManifest | null = null;
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
        const p = await cc.getProject(bindProject);
        projectExists = true;
        isOnline = Array.isArray(p.platforms) && p.platforms.some((pl) => pl.connected);
      } catch {
        /* project 不存在 */
      }

      if (!isOnline) {
        if (!projectExists) {
          if (!workDir) {
            return reply.code(400).send({ error: '团队缺少项目路径，无法启动 cc-connect project' });
          }
          try {
            await cc.createProject(bindProject, harness, workDir, platformType, platformOptions);
            projectExists = true;
          } catch {
            /* CC Connect project creation is best-effort */
          }
        }
        // Restart cc-connect to (re-)activate platform connections.
        // Covers: newly created project, existing project with disconnected platform,
        // Feishu/Lark IM that lost connection after cc-connect restart, etc.
        try {
          await restartHermitBridgeAndReconnect();
        } catch (err) {
          request.log.warn(
            { err, bindProject },
            'cc-connect restart/bridge reconnect failed during team launch'
          );
        }
      }

      return {
        runId: `cc-connect:${bindProject}:${Date.now()}`,
        ok: true,
        data: { teamName: name, bindProject, projectExists, isOnline },
      };
    } catch (err) {
      return reply.code(404).send(reply500(err));
    }
  }
);

app.post<{ Params: { name: string } }>('/api/teams/:name/stop', async (request) => {
  const name = request.params.name;
  const bindProject = await resolveRouteCcProjectName(name);
  // Stop = delete project from cc-connect (best-effort, no restart)
  try {
    await cc.deleteProject(bindProject);
  } catch {
    /* project may not exist in cc-connect */
  }
  // Keep local team metadata intact by not deleting it
  // The team will show as offline (isAlive: false) on next data fetch
  return { ok: true };
});

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

// 消息分页 — store 期望 MessagesPage 结构
app.get<{ Params: { name: string; messageId: string } }>(
  '/api/teams/:name/messages/:messageId/attachments',
  async (request) => {
    const msgs = await svc.readMessages(request.params.name, { limit: 5000 });
    const message = msgs.find((msg) => msg.id === request.params.messageId);
    const attachments = Array.isArray(message?.meta?.attachmentData)
      ? (message.meta.attachmentData as AttachmentFileData[])
      : [];
    return attachments.filter(
      (attachment): attachment is AttachmentFileData =>
        typeof attachment?.id === 'string' &&
        typeof attachment.data === 'string' &&
        typeof attachment.mimeType === 'string'
    );
  }
);

app.get<{ Params: { name: string }; Querystring: { cursor?: string; limit?: string } }>(
  '/api/teams/:name/messages',
  async (request) => {
    const { name } = request.params;
    const requestedLimit = Number(request.query.limit ?? 50);
    const limit = Math.min(
      Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50),
      100
    );
    const rawCursor = request.query.cursor;
    const offset = Math.max(
      0,
      Number.isFinite(Number(rawCursor)) ? Math.floor(Number(rawCursor)) : 0
    );
    try {
      // Keep a bounded history snapshot in memory for pagination safety.
      const bindProject = await resolveRouteCcProjectName(name);
      const msgs = await svc.readMessages(name, { limit: 5000 });
      const sessions = await cc.listSessions(bindProject).catch(() => []);
      const sessionByKey = new Map(sessions.map((session) => [session.session_key, session]));
      const newestFirstMessages = [...msgs].reverse();
      const pageSlice = newestFirstMessages.slice(offset, offset + limit);
      const page = pageSlice.map((m) => {
        const explicitSessionKey =
          typeof m.meta?.sessionKey === 'string'
            ? m.meta.sessionKey
            : typeof m.meta?.session_key === 'string'
              ? m.meta.session_key
              : undefined;
        const sessionKey = explicitSessionKey ?? buildFallbackSessionKey(name);
        const session = sessionKey ? sessionByKey.get(sessionKey) : undefined;
        return {
          messageId: m.id,
          from: m.from,
          to: m.to,
          text: m.content,
          timestamp: m.ts,
          read: true,
          source:
            typeof m.meta?.source === 'string'
              ? m.meta.source
              : ((m.role === 'user' ? 'user_sent' : 'inbox') as string),
          taskRefs: Array.isArray(m.meta?.taskRefs) ? m.meta.taskRefs : undefined,
          summary: typeof m.meta?.summary === 'string' ? m.meta.summary : undefined,
          conversationId:
            typeof m.meta?.conversationId === 'string' ? m.meta.conversationId : undefined,
          replyToConversationId:
            typeof m.meta?.replyToConversationId === 'string'
              ? m.meta.replyToConversationId
              : undefined,
          attachments: Array.isArray(m.meta?.attachments)
            ? (m.meta.attachments as AttachmentMeta[])
            : undefined,
          session: sessionKey
            ? {
                id: session?.id,
                key: sessionKey,
                platform: session?.platform,
                title: session?.name || session?.user_name || session?.chat_name || sessionKey,
                chatName: session?.chat_name,
                userName: session?.user_name,
              }
            : undefined,
        };
      });
      // feedRevision = count:lastId で変更を確実に検出
      const lastMsg = msgs[msgs.length - 1];
      const firstMsg = msgs[0];
      const feedRevision = `${msgs.length}:${firstMsg?.id ?? '0'}:${lastMsg?.id ?? '0'}`;
      const nextOffset = offset + page.length;
      const hasMore = nextOffset < newestFirstMessages.length;
      return {
        messages: page,
        nextCursor: hasMore ? String(nextOffset) : null,
        hasMore,
        feedRevision,
      };
    } catch {
      return { messages: [], nextCursor: null, hasMore: false, feedRevision: '0' };
    }
  }
);

// 消息 head（messages-head 不是标准路由，storeok调 getMessagesPage 的同路由带 limit）
// member-activity-meta
app.get<{ Params: { name: string } }>('/api/teams/:name/member-activity-meta', async (request) => {
  const { name } = request.params;
  return {
    teamName: name,
    computedAt: new Date().toISOString(),
    members: {},
    feedRevision: '0',
  };
});

// member-activity — GET /api/teams/:name/member-activity
app.get<{ Params: { name: string } }>('/api/teams/:name/member-activity', async (request) => {
  const { name } = request.params;
  return {
    teamName: name,
    computedAt: new Date().toISOString(),
    members: {},
    feedRevision: '0',
  };
});

// member-spawn-statuses — GET /api/teams/:name/member-spawn-statuses
app.get<{ Params: { name: string } }>('/api/teams/:name/member-spawn-statuses', async (request) => {
  const { name } = request.params;
  return {
    statuses: {},
    runId: null,
  };
});

// agent-runtime — GET /api/teams/:name/agent-runtime
app.get<{ Params: { name: string } }>('/api/teams/:name/agent-runtime', async (request) => {
  const { name } = request.params;
  return {
    teamName: name,
    updatedAt: new Date().toISOString(),
    runId: null,
    members: {},
  };
});

// lead-activity — GET /api/teams/:name/lead-activity
app.get<{ Params: { name: string } }>('/api/teams/:name/lead-activity', async () => {
  return { state: 'offline', updatedAt: new Date().toISOString() };
});

// lead-context — GET /api/teams/:name/lead-context
app.get<{ Params: { name: string } }>('/api/teams/:name/lead-context', async () => {
  return { usage: null };
});

// sessions — scan local JSONL files, optionally enrich with cc-connect identity metadata
app.get<{ Params: { name: string } }>('/api/teams/:name/sessions', async (request) => {
  try {
    const team = await svc.readTeamManifest(request.params.name);
    const workDir = team.workDir || team.bindProject || request.params.name;
    const hiddenSessionIds = await svc.readHiddenSessionIds(request.params.name);
    const localSessions = await localSessionScanner.scanSummaries(workDir, request.params.name);

    // Merge cc-connect sessions into the response. External platform sessions (Feishu/Lark/etc.)
    // may not have a local Claude JSONL yet, but users still expect to see them as listening sessions.
    let ccSessions: HermitBridgeSessionListItem[] = [];
    try {
      const bindProject = await resolveRouteCcProjectName(request.params.name);
      ccSessions = await cc.listSessions(bindProject);
    } catch {
      /* cc-connect unavailable — local-only data */
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

// GET session detail — read local JSONL file for session history with pagination
app.get<{
  Params: { name: string; sessionId: string };
  Querystring: { history_limit?: string; offset?: string };
}>('/api/teams/:name/sessions/:sessionId', async (request, reply) => {
  const limit = request.query.history_limit ? parseInt(request.query.history_limit, 10) : 500;
  const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;
  const team = await svc.readTeamManifest(request.params.name);
  const workDir = team.workDir || team.bindProject || request.params.name;
  const detail = await localSessionScanner.readSessionDetail(workDir, request.params.sessionId, {
    offset,
    limit,
  });
  if (detail) return detail;

  try {
    const bindProject = await resolveRouteCcProjectName(request.params.name);
    const ccDetail = await cc.getSession(bindProject, request.params.sessionId, limit);
    return mapCcSessionDetail(ccDetail);
  } catch {
    return reply.code(404).send({ error: 'Session not found' });
  }
});

// DELETE session — archive in Hermit and best-effort close cc-connect live session.
app.delete<{ Params: { name: string; sessionId: string } }>(
  '/api/teams/:name/sessions/:sessionId',
  async (request, reply) => {
    try {
      await svc.hideSession(request.params.name, request.params.sessionId);
    } catch (err) {
      return reply
        .code(500)
        .send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    try {
      const bindProject = await resolveRouteCcProjectName(request.params.name);
      await cc.deleteSession(bindProject, request.params.sessionId);
      return { ok: true, archived: true, ccDeleted: true };
    } catch (err) {
      const warning = err instanceof Error ? err.message : String(err);
      app.log.warn(
        { err, teamName: request.params.name, sessionId: request.params.sessionId },
        'archived session locally but cc-connect delete failed'
      );
      return { ok: true, archived: true, ccDeleted: false, warning };
    }
  }
);

// runtime/alive — 从 cc-connect 获取真实在线状态
app.get('/api/teams/runtime/alive', async () => {
  try {
    const [projects, localTeams] = await Promise.all([
      cc.listProjects(),
      svc.listTeams().catch(() => []),
    ]);
    const localByProject = new Map(localTeams.map((team) => [team.bindProject, team]));
    return await Promise.all(
      projects.map(async (p) => {
        let isAlive = false;
        try {
          const detail = await cc.getProject(p.name);
          isAlive = Array.isArray(detail.platforms) && detail.platforms.some((pl) => pl.connected);
        } catch {
          /* degraded */
        }
        return { teamName: localByProject.get(p.name)?.slug ?? p.name, isAlive, runId: p.name };
      })
    );
  } catch {
    return [];
  }
});

// process-alive — 查询 cc-connect project 在线状态
app.get<{ Params: { name: string } }>('/api/teams/:name/process-alive', async (request) => {
  try {
    const bindProject = await resolveRouteCcProjectName(request.params.name);
    const p = await cc.getProject(bindProject);
    return Array.isArray(p.platforms) && p.platforms.some((pl) => pl.connected);
  } catch {
    return false;
  }
});

// process-send — 从 Hermit UI 注入到 harness，不回发到 IM 平台。
app.post<{ Params: { name: string }; Body: { text?: string; message?: string } }>(
  '/api/teams/:name/process-send',
  async (request, reply) => {
    try {
      const text = request.body?.text ?? request.body?.message ?? '';
      if (text) {
        await sendHarnessMessageViaBridge({
          teamName: request.params.name,
          text,
        });
      }
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: err instanceof Error ? err.message : '发送到 harness 失败',
      });
    }
  }
);

// saved-request — 新版无此概念
app.get<{ Params: { name: string } }>('/api/teams/:name/saved-request', async () => null);

// kanban state — 返回空看板状态
app.get<{ Params: { name: string } }>('/api/teams/:name/kanban', async (request) => ({
  teamName: request.params.name,
  reviewers: [],
  tasks: {},
}));

// task-change-presence — 返回 {}
app.get<{ Params: { name: string } }>('/api/teams/:name/task-change-presence', async () => ({}));

// kanban column order — no-op
app.post<{ Params: { name: string } }>('/api/teams/:name/kanban-column-order', async () => ({
  ok: true,
}));

// teams/tasks (全局任务列表 — 跨所有团队)
app.get('/api/teams/tasks', async () => {
  try {
    const allTasks: ReturnType<typeof toTeamTask>[] = [];
    const projects = await cc.listProjects();
    for (const p of projects) {
      try {
        const tasks = activeTasks(await svc.readTasks(p.name));
        allTasks.push(...tasks.map(toTeamTask));
      } catch {
        /* skip */
      }
    }
    return allTasks;
  } catch {
    return [];
  }
});

// 团队任务子操作 — 全部委托给 svc.patchTask
app.post<{ Params: { name: string; id: string } }>(
  '/api/teams/:name/tasks/:id/request-review',
  async (request, reply) => {
    try {
      const tasks = await svc.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (existingTask?.status === 'doing') {
        return reply.code(409).send({
          ok: false,
          error: 'Agent 正在处理中，不能手动提交审核。请等待 agent 调用 complete_task。',
        });
      }
      const task = await svc.patchTask(request.params.name, request.params.id, { status: 'done' });
      return { ok: true, data: toTeamTask(task) };
    } catch {
      return { ok: true };
    }
  }
);
app.patch<{ Params: { name: string; id: string }; Body: Record<string, unknown> }>(
  '/api/teams/:name/tasks/:id/kanban',
  async (request) => {
    // kanban metadata — stored in board.json via patchTask (no-op for now, column tracked client-side)
    return { ok: true };
  }
);
app.patch<{ Params: { name: string; id: string }; Body: { status?: string } }>(
  '/api/teams/:name/tasks/:id/status',
  async (request, reply) => {
    try {
      const { status } = request.body ?? {};
      const nextStatus = status ? toTaskStatus(status) : undefined;
      const tasks = await svc.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (isManualInProgressExitBlocked(existingTask?.status, nextStatus)) {
        return reply.code(409).send({
          ok: false,
          error: 'Agent 正在处理中，不能手动完成或取消。请等待 agent 调用 complete_task。',
        });
      }
      const task = await svc.patchTask(request.params.name, request.params.id, {
        status: nextStatus,
      });
      return toTeamTask(task);
    } catch {
      return { ok: true };
    }
  }
);
app.patch<{ Params: { name: string; id: string }; Body: { owner?: string } }>(
  '/api/teams/:name/tasks/:id/owner',
  async (request) => {
    try {
      const body = request.body ?? {};
      const task = await svc.patchTask(request.params.name, request.params.id, {
        assignee: body.owner ?? null,
      });
      return toTeamTask(task);
    } catch {
      return { ok: true };
    }
  }
);
app.patch<{ Params: { name: string; id: string }; Body: Record<string, unknown> }>(
  '/api/teams/:name/tasks/:id/fields',
  async (request) => {
    try {
      const body = request.body ?? {};
      const patch: Record<string, unknown> = {};
      if (body.subject !== undefined) patch.title = body.subject;
      if (body.description !== undefined) patch.description = body.description;
      const task = await svc.patchTask(request.params.name, request.params.id, patch);
      return toTeamTask(task);
    } catch {
      return { ok: true };
    }
  }
);
app.post<{ Params: { name: string; id: string } }>(
  '/api/teams/:name/tasks/:id/start',
  async (request) => {
    try {
      const task = await svc.patchTask(request.params.name, request.params.id, { status: 'doing' });
      if (task.assignee) {
        await svc.dispatchTask(request.params.name, task).catch(() => {});
        return { notifiedOwner: true };
      }
      return { notifiedOwner: false };
    } catch {
      return { notifiedOwner: false };
    }
  }
);
app.post<{ Params: { name: string; id: string } }>(
  '/api/teams/:name/tasks/:id/start-by-user',
  async (request) => {
    try {
      const task = await svc.patchTask(request.params.name, request.params.id, { status: 'doing' });
      if (task.assignee) {
        await svc.dispatchTask(request.params.name, task).catch(() => {});
        return { notifiedOwner: true };
      }
      return { notifiedOwner: false };
    } catch {
      return { notifiedOwner: false };
    }
  }
);
app.post<{ Params: { name: string; id: string } }>(
  '/api/teams/:name/tasks/:id/soft-delete',
  async (request, reply) => {
    try {
      const tasks = await svc.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (existingTask?.status === 'doing') {
        return reply.code(409).send({
          ok: false,
          error: 'Agent 正在处理中，不能手动删除任务。',
        });
      }
      await svc.patchTask(request.params.name, request.params.id, {
        status: 'done',
        result: '__deleted__',
      });
      return { ok: true };
    } catch (err) {
      return reply.code(404).send(reply500(err));
    }
  }
);
app.post<{ Params: { name: string; id: string } }>(
  '/api/teams/:name/tasks/:id/restore',
  async (request, reply) => {
    try {
      await svc.patchTask(request.params.name, request.params.id, { status: 'todo', result: null });
      return { ok: true };
    } catch (err) {
      return reply.code(404).send(reply500(err));
    }
  }
);
app.get<{ Params: { name: string } }>('/api/teams/:name/deleted-tasks', async (request) => {
  try {
    const tasks = await svc.readTasks(request.params.name);
    return tasks.filter((t) => t.result === '__deleted__').map(toTeamTask);
  } catch {
    return [];
  }
});
app.post<{ Params: { name: string; id: string }; Body: { text?: string } }>(
  '/api/teams/:name/tasks/:id/comments',
  async () => ({ ok: true })
);
app.post<{ Params: { name: string; id: string } }>(
  '/api/teams/:name/tasks/:id/clarification',
  async () => ({ ok: true })
);
app.post<{ Params: { name: string; id: string } }>(
  '/api/teams/:name/tasks/:id/relationships',
  async () => ({ ok: true })
);

// 成员相关 stubs
app.post<{ Params: { name: string } }>('/api/teams/:name/members', async () => ({ ok: true }));
app.delete<{ Params: { name: string; memberName: string } }>(
  '/api/teams/:name/members/:memberName',
  async () => ({ ok: true })
);
app.patch<{ Params: { name: string; memberName: string } }>(
  '/api/teams/:name/members/:memberName/role',
  async () => ({ ok: true })
);
app.post<{ Params: { name: string; memberName: string } }>(
  '/api/teams/:name/members/:memberName/restart',
  async () => ({ ok: true })
);
app.post<{ Params: { name: string; memberName: string } }>(
  '/api/teams/:name/members/:memberName/skip-launch',
  async () => ({ ok: true })
);

// claude logs
app.get<{ Params: { name: string } }>('/api/teams/:name/claude-logs', async () => ({
  logs: [],
  total: 0,
}));

// restore / permanent delete
app.post<{ Params: { name: string } }>('/api/teams/:name/restore', async (request, reply) => {
  try {
    await svc.restoreTeam(request.params.name);
    return { ok: true };
  } catch (err) {
    return reply.code(404).send(reply500(err));
  }
});
app.delete<{
  Params: { name: string };
  Querystring: { strictExternal?: string };
}>('/api/teams/:name/permanent', async (request, reply) => {
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
    } catch (err) {
      if (isCcProjectNotFoundError(err)) {
        request.log.info(
          { teamName, ccProjectName },
          'cc-connect project already missing while permanently deleting team'
        );
      } else if (strictExternal) {
        request.log.warn(
          { err, teamName, ccProjectName },
          'strict cc-connect project deletion failed'
        );
        return reply.code(502).send({
          error: `删除渠道项目失败，本地团队已保留：${err instanceof Error ? err.message : String(err)}`,
        });
      } else {
        request.log.warn({ err, teamName, ccProjectName }, 'delete cc-connect project failed');
      }
    }
    await svc.deleteTeam(manifest.slug, { deleteFiles: true });
    return { ok: true, restartRequired };
  } catch (err) {
    return reply.code(500).send(reply500(err));
  }
});

// config operations
async function applyTeamConfigUpdate(
  teamName: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
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

  // Validate agent type before checking CLI availability.
  if (agentType && !CC_AGENT_TYPES.includes(agentType as HermitBridgeAgentType)) {
    throw new Error(`${agentType} 不是支持的运行时类型。`);
  }
  if (agentType && agentType !== 'claudecode') {
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

  const localPatch: Record<string, unknown> = {};
  if (name) localPatch.displayName = name;
  if (description) localPatch.description = description;
  if (color) localPatch.color = color;
  if (agentType) localPatch.harness = agentType;
  if (workDir) {
    localPatch.workDir = workDir;
  }
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
      // If the team only exists in cc-connect, create Hermit metadata now so displayName can persist.
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
    bindProject = await resolveRouteCcProjectName(teamName);
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
          /* best effort */
        }
      }
    } catch (err) {
      if (!isCcProjectNotFoundError(err)) {
        ccSyncError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  if (providerRefs !== undefined) {
    try {
      await cc.setProviderRefs(bindProject, providerRefs);
    } catch (err) {
      if (!isCcProjectNotFoundError(err)) {
        ccSyncError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (resetOnIdleMins !== undefined) {
    try {
      const { content: tomlRaw } = readHermitBridgeConfigTomlRaw();
      const projectPattern = new RegExp(
        `(\\[\\[projects\\]\\]\\s*\\n(?:[^\\[]*?)?name\\s*=\\s*"${bindProject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^\\[]*?)(?=\\[\\[|$)`,
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
        const updatedToml = tomlRaw.replace(projectPattern, section);
        writeHermitBridgeConfigTomlRaw(updatedToml);
        try {
          await cc.reload();
        } catch {
          /* best effort */
        }
      }
    } catch (err) {
      if (!ccSyncError) {
        ccSyncError = `reset_on_idle_mins: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  if (platformOptionsUpdate && Object.keys(platformOptionsUpdate).length > 0) {
    try {
      const { content: tomlRaw } = readHermitBridgeConfigTomlRaw();
      let updatedToml = tomlRaw;
      for (const [pType, opts] of Object.entries(platformOptionsUpdate)) {
        for (const [key, value] of Object.entries(opts)) {
          const platformSection = new RegExp(
            `(\\[\\[projects\\.platforms\\]\\]\\s*\\ntype\\s*=\\s*"${pType}"[^\\[]*?\\[projects\\.platforms\\.options\\]\\s*\\n)([^\\[]*)`,
            's'
          ).exec(updatedToml);
          if (platformSection) {
            const optContent = platformSection[2];
            const tomlValue = value === 'true' || value === 'false' ? value : `"${value}"`;
            if (new RegExp(`^${key}\\s*=`, 'm').exec(optContent)) {
              updatedToml = updatedToml.replace(
                new RegExp(
                  `(\\[\\[projects\\.platforms\\]\\]\\s*\\ntype\\s*=\\s*"${pType}"[^\\[]*?\\[projects\\.platforms\\.options\\]\\s*\\n[^\\[]*?)^(${key}\\s*=\\s*).*$`,
                  'ms'
                ),
                `$1$2${tomlValue}`
              );
            } else {
              updatedToml = updatedToml.replace(
                new RegExp(
                  `(\\[\\[projects\\.platforms\\]\\]\\s*\\ntype\\s*=\\s*"${pType}"[^\\[]*?\\[projects\\.platforms\\.options\\]\\s*\\n)`,
                  's'
                ),
                `$1${key} = ${tomlValue}\n`
              );
            }
          }
        }
      }
      if (updatedToml !== tomlRaw) {
        writeHermitBridgeConfigTomlRaw(updatedToml);
        try {
          await cc.reload();
        } catch {
          /* best effort */
        }
      }
    } catch (err) {
      if (!ccSyncError) {
        ccSyncError = `platformOptions: ${err instanceof Error ? err.message : String(err)}`;
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

app.get<{ Params: { name: string } }>('/api/teams/:name/config', async (request, reply) => {
  try {
    const name = request.params.name;
    const bindProject = await resolveRouteCcProjectName(name);
    const p = await cc.getProject(bindProject);
    // local metadata overlay
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
      /* ok */
    }
    const projectSettings = (p.settings ?? {}) as Record<string, unknown>;
    const resolvedLanguage =
      typeof projectSettings.language === 'string' && projectSettings.language.trim().length > 0
        ? projectSettings.language.trim()
        : language;
    const resolvedManagedSources =
      typeof projectSettings.admin_from === 'string' && projectSettings.admin_from.trim().length > 0
        ? projectSettings.admin_from.trim()
        : managedSources;
    const resolvedDisabledCommands =
      Array.isArray(projectSettings.disabled_commands) &&
      normalizeStringArray(projectSettings.disabled_commands).length > 0
        ? normalizeStringArray(projectSettings.disabled_commands)
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
    const resolvedPlatformAllowFrom = (() => {
      const normalized = normalizePlatformAllowFrom(projectSettings.platform_allow_from);
      if (Object.keys(normalized).length > 0) {
        return normalized;
      }
      return platformAllowFrom;
    })();
    const resolvedPlatformAllowChat = (() => {
      const normalized = normalizePlatformAllowFrom(projectSettings.platform_allow_chat);
      if (Object.keys(normalized).length > 0) {
        return normalized;
      }
      return platformAllowChat;
    })();
    const resolvedPermissionMode =
      typeof p.agent_mode === 'string' && p.agent_mode.trim().length > 0
        ? p.agent_mode.trim()
        : permissionMode;
    const [providerRefs, globalProviders] = await Promise.all([
      cc.getProviderRefs(bindProject).catch(() => []),
      cc.listProviders().catch(() => []),
    ]);
    let resetOnIdleMins: number | undefined;
    const platformOptions: Record<string, Record<string, string>> = {};
    try {
      const { content: tomlRaw } = readHermitBridgeConfigTomlRaw();
      const projectPattern = new RegExp(
        `\\[\\[projects\\]\\]\\s*\\n(?:[^\\[]*?)?name\\s*=\\s*"${bindProject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^\\[]*?(?=\\[\\[projects\\]\\]|$)`,
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
          const pType = typeMatch[1];
          const opts: Record<string, string> = {};
          const optSection = /\[projects\.platforms\.options\]\s*\n([^\[]*?)(?=\[|$)/s.exec(
            content
          );
          if (optSection) {
            const optLines = optSection[1];
            for (const line of optLines.split('\n')) {
              const kv = /^\s*(\w+)\s*=\s*(?:"([^"]*)"|(\w+))/.exec(line);
              if (kv) opts[kv[1]] = kv[2] ?? kv[3];
            }
          }
          if (Object.keys(opts).length > 0) {
            platformOptions[pType] = { ...platformOptions[pType], ...opts };
          }
        }
      }
    } catch {
      /* TOML read may fail if file missing */
    }
    return {
      name,
      color,
      projectPath: p.work_dir || '',
      description,
      agentType: p.agent_type,
      workDir: p.work_dir ?? '',
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
    const data = await applyTeamConfigUpdate(
      request.params.name,
      (request.body as Record<string, unknown>) ?? {}
    );
    return data;
  } catch (err) {
    return reply.code(400).send(reply500(err));
  }
});

// provisioning stubs (新版无 provisioning 概念)
app.post('/api/teams/provisioning/prepare', async () => ({
  runId: null,
  warnings: [],
}));
app.get<{ Params: { runId: string } }>('/api/teams/provisioning/:runId', async () => ({
  runId: '',
  phase: 'done',
  progress: 100,
  message: '',
  done: true,
  error: null,
}));
app.post<{ Params: { runId: string } }>('/api/teams/provisioning/:runId/cancel', async () => ({
  ok: true,
}));

// 团队创建已由上方 /api/teams/create 处理（cc-connect 直接调用）

// templates stubs
app.get('/api/teams/templates', async () => ({ sources: [], templates: [] }));
app.post('/api/teams/templates/save', async () => ({ sources: [], templates: [] }));
app.post('/api/teams/templates/refresh', async () => ({ sources: [], templates: [] }));

// replace members
app.put<{ Params: { name: string } }>('/api/teams/:name/members', async () => ({ ok: true }));

// draft
app.delete<{ Params: { name: string } }>('/api/teams/:name/draft', async () => ({ ok: true }));

// send-message — 从 Hermit 会话面板注入到 harness，不使用 Management /send（那会回发到 IM）。
app.post<{
  Params: { name: string };
  Body: {
    member?: string;
    text?: string;
    content?: string;
    summary?: string;
    sessionKey?: string;
    messageId?: string;
    attachments?: unknown;
  };
}>('/api/teams/:name/send-message', async (request, reply) => {
  const teamName = request.params.name;
  const text = request.body?.text ?? request.body?.content ?? '';
  if (!text.trim()) return { ok: true, messageId: null };

  const requestedMessageId =
    typeof request.body?.messageId === 'string' ? request.body.messageId.trim() : '';
  const msgId =
    requestedMessageId || `hermit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 使用固定格式 session key，保证 reply 事件能正确映射回 teamName。
  // UI 消息先落盘并广播，bridge 投递放后台执行，避免 bridge 重连窗口卡住发送按钮。
  const requestedSessionKey =
    typeof request.body?.sessionKey === 'string' ? request.body.sessionKey.trim() : '';
  const sessionKey = requestedSessionKey || buildFallbackSessionKey(teamName);
  const attachments = Array.isArray(request.body?.attachments)
    ? request.body.attachments.filter(isAttachmentPayload)
    : [];
  const attachmentMeta = attachments.map(toAttachmentMeta);
  const attachmentData = attachments.map(toAttachmentFileData);
  const ccSettings = await readEffectiveCcSettings();
  const attachmentsForAgent = shouldSendAttachmentsToAgent(ccSettings) ? attachments : [];

  // 本地存储用户消息
  const userMsg = await svc
    .appendMessage(teamName, {
      id: msgId,
      from: 'user',
      to: teamName,
      role: 'user',
      content: text,
      meta: {
        sessionKey,
        attachments: attachmentMeta.length > 0 ? attachmentMeta : undefined,
        attachmentData: attachmentData.length > 0 ? attachmentData : undefined,
      },
    })
    .catch(() => null);

  // 广播 SSE 让前端触发消息刷新
  broadcastSse('team-change', { type: 'inbox', teamName });

  // Member DM: dispatch to the local claude CLI directly (bypass cc-connect). One
  // subprocess per member, resumed across messages. The reply streams back via the
  // manager event listener and is persisted on the turn's `result` event. cc-connect's
  // bridge stays reserved for external IM (Feishu/WeChat).
  const member = typeof request.body?.member === 'string' ? request.body.member.trim() : '';
  const directSessionKey = `${teamName}:member:${member || 'lead'}`;
  const memberWorkDir = await resolveDirectCliWorkDir(teamName).catch(() => '');
  const dispatchedDirect = Boolean(memberWorkDir);
  if (dispatchedDirect) {
    void dispatchDirectCliMessage({
      teamName,
      sessionKey: directSessionKey,
      workDir: memberWorkDir,
      from: member || teamName,
      to: 'user',
      text,
      attachments: attachmentsForAgent,
      // The agent reply needs its OWN id — distinct from the user message's
      // `msgId`. Reusing `msgId` persisted the reply with the user message's id,
      // colliding in the inbox so the renderer's id-keyed dedup dropped it
      // (the team-3ond "回复的没了" bug).
      messageId: buildDirectReplyMessageId(directSessionKey),
    }).catch((err) => {
      request.log.warn(
        { err, teamName, sessionKey: directSessionKey },
        'send-message direct-cli delivery failed'
      );
      broadcastSse('team-change', { type: 'inbox', teamName });
    });
  } else {
    request.log.warn({ teamName }, 'send-message direct-cli skipped: no work_dir resolved');
  }

  return {
    ok: true,
    deliveredToInbox: true,
    messageId: userMsg?.id ?? msgId,
    runtimeDelivery: {
      attempted: true,
      delivered: dispatchedDirect,
    },
  };
});

// ===========================================================================
// 路由别名 — 修正前端调用路径与服务端路径的不匹配
// ===========================================================================

// requestReview: 前端调用 /tasks/:id/review，服务端原路由是 /tasks/:id/request-review
app.post<{ Params: { name: string; id: string } }>(
  '/api/teams/:name/tasks/:id/review',
  async (request, reply) => {
    try {
      const tasks = await svc.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (existingTask?.status === 'doing') {
        return reply.code(409).send({
          ok: false,
          error: 'Agent 正在处理中，不能手动提交审核。请等待 agent 调用 complete_task。',
        });
      }
      const task = await svc.patchTask(request.params.name, request.params.id, { status: 'done' });
      return { ok: true, data: toTeamTask(task) };
    } catch {
      return { ok: true };
    }
  }
);

// updateKanban: 前端调用 PATCH /kanban/:taskId
app.patch<{ Params: { name: string; id: string }; Body: Record<string, unknown> }>(
  '/api/teams/:name/kanban/:id',
  async () => ({ ok: true })
);

// updateKanbanColumnOrder: 前端调用 PUT /kanban/column-order
app.put<{ Params: { name: string } }>('/api/teams/:name/kanban/column-order', async () => ({
  ok: true,
}));

// updateConfig: 前端调用 PUT /config（服务端原有 PATCH，补充 PUT 别名）
app.put<{ Params: { name: string } }>('/api/teams/:name/config', async (request, reply) => {
  try {
    const data = await applyTeamConfigUpdate(
      request.params.name,
      (request.body as Record<string, unknown>) ?? {}
    );
    return data;
  } catch (err) {
    return reply.code(400).send(reply500(err));
  }
});

// skipMemberForLaunch: 前端调用 /members/:memberName/skip
app.post<{ Params: { name: string; memberName: string } }>(
  '/api/teams/:name/members/:memberName/skip',
  async () => ({ ok: true })
);

// setTaskClarification: 前端调用 POST /task-clarification/:taskId
app.post<{ Params: { name: string; taskId: string } }>(
  '/api/teams/:name/task-clarification/:taskId',
  async () => ({ ok: true })
);

// removeTaskRelationship: 前端调用 DELETE /tasks/:id/relationships
app.delete<{ Params: { name: string; id: string } }>(
  '/api/teams/:name/tasks/:id/relationships',
  async () => ({ ok: true })
);

// ===========================================================================
// 缺失的 stub 路由 — 返回空数据防止前端 404 崩溃
// ===========================================================================

// createConfig
app.post('/api/teams/config', async () => ({ ok: true }));

// kill-process
app.post<{ Params: { name: string }; Body: { pid?: number } }>(
  '/api/teams/:name/kill-process',
  async () => ({ ok: true })
);

// member-logs
app.get<{ Params: { name: string; memberName: string } }>(
  '/api/teams/:name/member-logs/:memberName',
  async () => []
);

// task-logs
app.get<{ Params: { name: string; taskId: string } }>(
  '/api/teams/:name/task-logs/:taskId',
  async () => []
);

// activity
app.get<{ Params: { name: string } }>('/api/teams/:name/activity', async () => []);

// task-activity-detail
app.get<{ Params: { name: string } }>('/api/teams/:name/task-activity-detail', async () => ({
  entries: [],
}));

// task-log-stream-summary
app.get<{ Params: { name: string; taskId: string } }>(
  '/api/teams/:name/task-log-stream-summary/:taskId',
  async () => ({ chunks: [] })
);

// task-log-stream
app.get<{ Params: { name: string; taskId: string } }>(
  '/api/teams/:name/task-log-stream/:taskId',
  async () => ({ chunks: [] })
);

// exact-log-summaries
app.get<{ Params: { name: string; taskId: string } }>(
  '/api/teams/:name/exact-log-summaries/:taskId',
  async () => ({ logs: [] })
);

// exact-log-detail
app.get<{ Params: { name: string; taskId: string } }>(
  '/api/teams/:name/exact-log-detail/:taskId',
  async () => ({ lines: [] })
);

// member-stats — aggregate from local JSONL session summaries
app.get<{ Params: { name: string; memberName: string } }>(
  '/api/teams/:name/member-stats/:memberName',
  async (request) => {
    try {
      const team = await svc.readTeamManifest(request.params.name);
      const workDir = team.workDir || team.bindProject || request.params.name;
      const sessions = await localSessionScanner.scanSummaries(workDir, request.params.name);

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreationTokens = 0;
      let totalTokens = 0;
      let messageCount = 0;
      let totalDurationMs = 0;

      let earliestStart: string | null = null;
      let latestEnd: string | null = null;

      for (const s of sessions) {
        inputTokens += s.inputTokens;
        outputTokens += s.outputTokens;
        cacheReadTokens += s.cacheReadTokens;
        cacheCreationTokens += s.cacheCreationTokens;
        totalTokens += s.totalTokens;
        messageCount += s.messageCount;

        if (s.startTime && (!earliestStart || s.startTime < earliestStart)) {
          earliestStart = s.startTime;
        }
        if (s.endTime && (!latestEnd || s.endTime > latestEnd)) {
          latestEnd = s.endTime;
        }
      }

      if (earliestStart && latestEnd) {
        totalDurationMs = Date.parse(latestEnd) - Date.parse(earliestStart);
        if (totalDurationMs < 0) totalDurationMs = 0;
      }

      // Count completed tasks from the team's task board
      let tasksCompleted = 0;
      try {
        // eslint-disable-next-line @typescript-eslint/dot-notation -- bracket access intentionally bypasses TS private modifier
        const tasks = await svc['workspace'].readTasks(team.slug || request.params.name);
        tasksCompleted = tasks.filter((t) => t.status === 'done').length;
      } catch {
        // board may not exist yet
      }

      return {
        linesAdded: 0,
        linesRemoved: 0,
        filesTouched: [],
        fileStats: {},
        toolUsage: {},
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalTokens,
        costUsd: 0,
        tasksCompleted,
        messageCount,
        totalDurationMs,
        sessionCount: sessions.length,
        computedAt: new Date().toISOString(),
      };
    } catch {
      return {
        linesAdded: 0,
        linesRemoved: 0,
        filesTouched: [],
        fileStats: {},
        toolUsage: {},
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        tasksCompleted: 0,
        messageCount: 0,
        totalDurationMs: 0,
        sessionCount: 0,
        computedAt: new Date().toISOString(),
      };
    }
  }
);

registerToolApprovalRoutes(app, {
  state: serverContext.state,
  respondPermission: (sessionKey, requestId, allow, message, updatedInput) =>
    directCliManager.respondPermission(sessionKey, requestId, allow, message, updatedInput),
  logger: app.log,
});

registerWorkerRoutes(app, {
  discoverTeams: () => svc.discoverTeams(),
  resolveTeamSlugForMention,
  ensureLoopSessionProjectReady,
  listSessions: (projectName) => cc.listSessions(projectName),
  createSession: (projectName, name, sessionKey) => cc.createSession(projectName, name, sessionKey),
  sendHarnessMessageViaBridge,
  appendMessage: (teamSlug, message) => svc.appendMessage(teamSlug, message),
  broadcastSse,
  buildFallbackSessionKey,
});

// GET /api/settings/task-bus → full config including telemetry
app.get('/api/settings/task-bus', async () => {
  const configPath = HERMIT_SETTINGS_FILE;
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const settings = JSON.parse(raw);
    return (
      settings.taskBus ?? {
        enabled: false,
        telemetry: { enabled: false, platform: 'claudecode' },
      }
    );
  } catch {
    return {
      enabled: false,
      telemetry: { enabled: false, platform: 'claudecode' },
    };
  }
});

// PUT /api/settings/task-bus → save config + start/stop telemetry
app.put<{ Body: TelemetryConfig }>('/api/settings/task-bus', async (request) => {
  const config =
    request.body && 'taskBus' in (request.body as unknown as Record<string, unknown>)
      ? (request.body as unknown as { taskBus: TelemetryConfig }).taskBus
      : request.body;
  const configPath = HERMIT_SETTINGS_FILE;
  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    // File doesn't exist yet
  }
  settings.taskBus = config;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(settings, null, 2));

  // Sync telemetry service. The lightweight usage worker owns scans when active;
  // avoid starting a duplicate Web-bound telemetry interval.
  if (config.telemetry?.enabled) {
    if (await isExternalTelemetryWorkerRunning()) {
      await stopTelemetry();
    } else {
      await startTelemetry(config);
    }
  } else {
    await stopTelemetry();
  }

  // Keep CLAUDE.md team instructions aligned with the collaboration toggle.
  const syncTeamInstructions = async (enabled: boolean): Promise<void> => {
    const projects = await cc.listProjects();
    for (const p of projects) {
      let workDir = '';
      let slug = p.name;
      try {
        const meta = await svc.readTeamManifest(p.name);
        if (typeof meta.workDir === 'string') workDir = meta.workDir.trim();
        if (meta.slug) slug = meta.slug;
      } catch {
        /* no local manifest */
      }
      if (!workDir) {
        try {
          const detail = await cc.getProject(p.name);
          if (typeof detail.work_dir === 'string') workDir = detail.work_dir.trim();
        } catch {
          // ignore
        }
      }
      if (!workDir) continue;
      if (enabled) {
        await svc.injectTeamInstructions(workDir, slug);
      } else {
        await svc.removeTeamInstructions(workDir);
      }
    }
  };

  // Per-team collaboration flag controls CLAUDE.md instruction injection.
  try {
    await syncTeamInstructions(config?.collaboration === true);
  } catch (err) {
    request.log.warn({ err }, 'CLAUDE.md team instruction sync failed');
  }

  return { ok: true, connected: false, message: '设置已保存' };
});

interface TelemetryProjectRow {
  cwd: string;
  displayName?: string;
  teamSlug?: string;
  bindProject?: string;
  deletedAt?: string;
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
}

interface TelemetryStatusShape {
  ok?: boolean;
  connected: boolean;
  scan?: ReturnType<typeof getTelemetryRuntimeStatus>;
  worker?: {
    running: boolean;
    state?: string;
    pid?: number | null;
    telemetryEnabled?: boolean;
    lastScan?: string | null;
    updatedAt?: string | null;
    lastError?: string | null;
  };
  lastScan: string | null;
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  totalTokens: number;
  recentMessages?: number;
  recentTokensTotal?: number;
  recentByProvider?: UsageTelemetryStatus['recentByProvider'];
  byProvider?: UsageTelemetryStatus['byProvider'];
  activeDays: number;
  hourly: number[];
  projects: TelemetryProjectRow[];
  workSecondsByDay: Record<string, number>;
  daily?: UsageTelemetryStatus['daily'];
  localUsers?: UserUsageTelemetryRow[];
  teamCapabilitySnapshots?: TeamCapabilityTelemetrySnapshot[];
  capabilitySummary?: CapabilityTelemetrySummary;
  unresolvedUsage?: UsageUnresolvedSummary;
}

async function readTaskBusSettings(): Promise<TelemetryConfig> {
  const configPath = HERMIT_SETTINGS_FILE;
  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    // no settings
  }
  return (settings.taskBus ?? {}) as TelemetryConfig;
}

const CAPABILITY_REPORT_TTL_MS = 10 * 60 * 1000;
let capabilityReportCache: {
  expiresAt: number;
  promise?: Promise<TeamCapabilityTelemetrySnapshot[]>;
  value: TeamCapabilityTelemetrySnapshot[];
} | null = null;

function summarizeCapabilities(
  snapshots: TeamCapabilityTelemetrySnapshot[]
): CapabilityTelemetrySummary {
  const summary: CapabilityTelemetrySummary = {
    teams: 0,
    commands: 0,
    skills: 0,
    workflows: 0,
    cron: 0,
    mcpServers: 0,
  };
  for (const snapshot of snapshots) {
    summary.teams += 1;
    summary.commands += snapshot.counts.commands;
    summary.skills += snapshot.counts.skills;
    summary.workflows += snapshot.counts.workflows;
    summary.cron += snapshot.counts.cron;
    summary.mcpServers += snapshot.counts.mcpServers;
    if (!summary.lastReportedAt || summary.lastReportedAt < snapshot.reportedAt) {
      summary.lastReportedAt = snapshot.reportedAt;
    }
  }
  return summary;
}

async function getCapabilityTelemetrySnapshots(): Promise<TeamCapabilityTelemetrySnapshot[]> {
  const now = Date.now();
  if (capabilityReportCache?.value && capabilityReportCache.expiresAt > now) {
    return capabilityReportCache.value;
  }
  if (capabilityReportCache?.promise) return capabilityReportCache.promise;

  const previousValue = capabilityReportCache?.value ?? [];
  const promise = (async () => {
    try {
      const listResult = await getCapabilityPacks().list();
      const snapshots = buildTeamCapabilityTelemetrySnapshots(listResult.packs);
      capabilityReportCache = {
        expiresAt: Date.now() + CAPABILITY_REPORT_TTL_MS,
        value: snapshots,
      };
      return snapshots;
    } catch (err) {
      capabilityReportCache = previousValue.length ? { expiresAt: 0, value: previousValue } : null;
      throw err;
    }
  })();

  capabilityReportCache = { expiresAt: 0, promise, value: previousValue };
  return promise;
}

function sanitizeDownloadFilename(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'download'
  );
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function zipDirectoryForDownload(rootDir: string): Promise<Buffer> {
  const files: { relativePath: string; data: Buffer; mtime: Date }[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(fullPath);
      files.push({
        relativePath: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
        data: await fs.readFile(fullPath),
        mtime: stat.mtime,
      });
    }
  };
  await visit(rootDir);

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const name = Buffer.from(file.relativePath, 'utf8');
    const crc = crc32(file.data);
    const { date, time } = dosDateTime(file.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + file.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

async function enrichTelemetryProjectNames<T extends { projects: TelemetryProjectRow[] }>(
  status: T
): Promise<T> {
  const teams = await svc.listTeams().catch(() => []);
  const activeTeams = teams.filter(
    (team) =>
      !team.deletedAt &&
      !isExternalPlatformSessionKey(team.slug) &&
      !isExternalPlatformSessionKey(team.bindProject || '')
  );
  const byWorkDir = new Map<string, TeamManifest>();
  const byBindProject = new Map<string, TeamManifest>();
  for (const team of activeTeams) {
    const workDir = (team.workDir || '').trim();
    if (workDir) byWorkDir.set(path.resolve(workDir), team);
    if (team.bindProject) byBindProject.set(team.bindProject, team);
    byBindProject.set(team.slug, team);
  }

  const seenTeamSlugs = new Set<string>();
  const projects = status.projects.flatMap((project) => {
    const cwd = (project.cwd || '').trim();
    const team =
      (cwd ? byWorkDir.get(path.resolve(cwd)) : undefined) ??
      byBindProject.get(cwd) ??
      byBindProject.get(path.basename(cwd));
    if (team?.deletedAt) return [];
    // Team Bus usage should only surface active Hermit teams. Raw Claude project
    // folders, deleted team leftovers, and external-platform session keys remain
    // in ~/.claude/projects history but should not reappear as team rows.
    if (!team) return [];
    seenTeamSlugs.add(team.slug);
    return [
      {
        ...project,
        displayName: team.displayName || team.slug,
        teamSlug: team.slug,
        bindProject: team.bindProject,
      },
    ];
  });

  for (const team of activeTeams) {
    if (seenTeamSlugs.has(team.slug)) continue;
    projects.push({
      cwd: team.workDir || team.bindProject || team.slug,
      displayName: team.displayName || team.slug,
      teamSlug: team.slug,
      bindProject: team.bindProject,
      sessions: 0,
      messages: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 0,
    });
  }

  return {
    ...status,
    projects,
  };
}

async function enrichTelemetryStatus(status: TelemetryStatusShape): Promise<TelemetryStatusShape> {
  const enriched = await enrichTelemetryProjectNames(status);
  const capabilities = await getCapabilityTelemetrySnapshots().catch((err) => {
    app.log.warn({ err }, 'capability telemetry snapshot build failed');
    return [] as TeamCapabilityTelemetrySnapshot[];
  });
  return {
    ...enriched,
    teamCapabilitySnapshots: capabilities,
    capabilitySummary: summarizeCapabilities(capabilities),
  };
}

function telemetryEmptyStatus(): TelemetryStatusShape {
  return {
    connected: false,
    scan: getTelemetryRuntimeStatus(),
    worker: { running: false },
    lastScan: null,
    sessions: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheCreation: 0,
    totalTokens: 0,
    recentMessages: 0,
    recentTokensTotal: 0,
    recentByProvider: {
      claudecode: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
      codex: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
    },
    byProvider: {
      claudecode: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
      codex: {
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        tokensTotal: 0,
      },
    },
    activeDays: 0,
    hourly: [],
    projects: [],
    workSecondsByDay: {},
    daily: {},
    localUsers: [],
    teamCapabilitySnapshots: [],
    capabilitySummary: { teams: 0, commands: 0, skills: 0, workflows: 0, cron: 0, mcpServers: 0 },
    unresolvedUsage: { sessions: 0, messages: 0, tokensTotal: 0 },
  };
}

function telemetryWorkerSummary(
  workerStatus: Awaited<ReturnType<typeof readUsageTelemetryWorkerStatus>>
): TelemetryStatusShape['worker'] {
  const status = workerStatus.status;
  return {
    running: Boolean(status?.running),
    state: status?.state,
    pid: status?.pid ?? null,
    telemetryEnabled: Boolean(status?.telemetryEnabled),
    lastScan: status?.lastScan ?? null,
    updatedAt: status?.updatedAt ?? null,
    lastError: status?.lastError ?? null,
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildUsageTelemetryExport(status: TelemetryStatusShape, format: 'csv' | 'json') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (format === 'json') {
    return {
      filename: `hermit-loop-usage-${stamp}.json`,
      mimeType: 'application/json;charset=utf-8',
      content: JSON.stringify(status, null, 2),
    };
  }

  const rows = [
    [
      'section',
      'name',
      'sessions',
      'messages',
      'tokensIn',
      'tokensOut',
      'cacheRead',
      'cacheCreation',
      'totalTokens',
      'activeDays',
      'durationSeconds',
      'cwd',
      'teamSlug',
      'teamName',
      'teamDisplayName',
      'projectName',
      'bindProject',
      'sourceKind',
      'assetKind',
      'description',
    ],
    [
      'summary',
      '累计 Loop 数据',
      status.sessions,
      status.messages,
      status.tokensIn,
      status.tokensOut,
      status.cacheRead,
      status.cacheCreation,
      status.totalTokens,
      status.activeDays,
      '',
      '',
    ],
    ...Object.entries(status.workSecondsByDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, seconds]) => ['day', day, '', '', '', '', '', '', '', '', seconds, '']),
    ...status.projects.map((project) => [
      'project',
      project.displayName || path.basename(project.cwd) || project.cwd,
      project.sessions,
      project.messages,
      project.tokensIn,
      project.tokensOut,
      '',
      '',
      project.tokensTotal,
      '',
      '',
      project.cwd,
    ]),
    ...(status.localUsers ?? []).map((user) => [
      'local-user',
      user.identity.displayName,
      user.sessions,
      user.messages,
      user.tokensIn,
      user.tokensOut,
      user.cacheRead,
      user.cacheCreation,
      user.tokensTotal,
      '',
      '',
      user.projectName ?? user.teamName ?? '',
    ]),
    ...(status.teamCapabilitySnapshots ?? []).flatMap((snapshot) =>
      snapshot.assets.map((asset) => [
        `capability-${asset.kind}`,
        asset.name,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        asset.scope ?? '',
        snapshot.teamSlug ?? '',
        snapshot.teamName,
        snapshot.teamDisplayName ?? '',
        snapshot.projectName ?? '',
        snapshot.bindProject ?? '',
        asset.source ?? '',
        asset.kind,
        asset.description ?? '',
      ])
    ),
    [
      'unresolved-usage',
      '未映射会话',
      status.unresolvedUsage?.sessions ?? 0,
      status.unresolvedUsage?.messages ?? 0,
      '',
      '',
      '',
      '',
      status.unresolvedUsage?.tokensTotal ?? 0,
      '',
      '',
      '',
    ],
  ];

  return {
    filename: `hermit-loop-usage-${stamp}.csv`,
    mimeType: 'text/csv;charset=utf-8',
    content: rows.map((row) => row.map(csvCell).join(',')).join('\n'),
  };
}

// POST /api/telemetry/scan → trigger manual scan
app.post('/api/telemetry/scan', async (request, reply) => {
  try {
    const taskBus = await readTaskBusSettings();
    if (!taskBus.telemetry?.enabled) {
      return reply.code(400).send({ error: 'Telemetry is not enabled' });
    }
    const result = await triggerScan(taskBus);
    if (!result) {
      return reply.code(503).send({ error: 'Telemetry scan failed' });
    }
    const workerStatus = await readUsageTelemetryWorkerStatus(HERMIT_HOME);
    return await enrichTelemetryStatus({
      ...result,
      ok: true,
      scan: getTelemetryRuntimeStatus(),
      worker: telemetryWorkerSummary(workerStatus),
    });
  } catch (err) {
    return reply.code(500).send({ error: String(err) });
  }
});

// GET /api/telemetry/export → export Loop usage telemetry summary/projects
app.get<{ Querystring: { format?: 'csv' | 'json' | string } }>(
  '/api/telemetry/export',
  async (request, reply) => {
    try {
      const format = request.query.format === 'json' ? 'json' : 'csv';
      const status = await enrichTelemetryStatus(
        (await getTelemetryStatus()) ?? telemetryEmptyStatus()
      );
      return buildUsageTelemetryExport(status, format);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  }
);

// GET /api/telemetry/conversations → local Feishu/Lark conversation telemetry
app.get<{
  Querystring: {
    teamName?: string;
    platform?: string;
    from?: string;
    to?: string;
    identityType?: 'person' | 'group' | 'unknown';
    identityId?: string;
    includeContent?: 'none' | 'summary' | 'full' | string;
    includeToolResults?: string;
    includeSystemMessages?: string;
    limit?: string;
    offset?: string;
  };
}>('/api/telemetry/conversations', async (request, reply) => {
  try {
    const result = await conversationTelemetry.getConversations({
      teamName: request.query.teamName,
      platform: request.query.platform,
      from: request.query.from,
      to: request.query.to,
      identityType: request.query.identityType,
      identityId: request.query.identityId,
      includeContent: shouldIncludeContent(request.query.includeContent),
      includeToolResults: request.query.includeToolResults !== 'false',
      includeSystemMessages: request.query.includeSystemMessages !== 'false',
      limit: request.query.limit ? Number(request.query.limit) : undefined,
      offset: request.query.offset ? Number(request.query.offset) : undefined,
    });
    return result;
  } catch (err) {
    return reply.code(500).send({ error: String(err) });
  }
});

// GET /api/telemetry/conversations/export → export local conversation telemetry
app.get<{
  Querystring: {
    format?: 'csv' | 'json' | 'markdown' | 'plaintext' | string;
    teamName?: string;
    platform?: string;
    from?: string;
    to?: string;
    identityType?: 'person' | 'group' | 'unknown';
    identityId?: string;
    includeContent?: 'none' | 'summary' | 'full' | string;
    includeToolResults?: string;
    includeSystemMessages?: string;
  };
}>('/api/telemetry/conversations/export', async (request, reply) => {
  try {
    const requestedFormat = request.query.format;
    const format =
      requestedFormat === 'json' ||
      requestedFormat === 'markdown' ||
      requestedFormat === 'plaintext' ||
      requestedFormat === 'csv'
        ? requestedFormat
        : 'csv';
    const result = await conversationTelemetry.exportConversations(format, {
      teamName: request.query.teamName,
      platform: request.query.platform,
      from: request.query.from,
      to: request.query.to,
      identityType: request.query.identityType,
      identityId: request.query.identityId,
      includeContent: shouldIncludeContent(request.query.includeContent),
      includeToolResults: request.query.includeToolResults !== 'false',
      includeSystemMessages: request.query.includeSystemMessages !== 'false',
    });
    return result;
  } catch (err) {
    return reply.code(500).send({ error: String(err) });
  }
});

// GET /api/telemetry/conversations/:sessionId → local conversation telemetry detail
app.get<{
  Params: { sessionId: string };
  Querystring: { teamName?: string; platform?: string };
}>('/api/telemetry/conversations/:sessionId', async (request, reply) => {
  try {
    const result = await conversationTelemetry.getConversationDetail(request.params.sessionId, {
      ...request.query,
      includeContent: 'full',
    });
    if (!result) return reply.code(404).send({ error: 'Conversation not found' });
    return result;
  } catch (err) {
    return reply.code(500).send({ error: String(err) });
  }
});

// GET /api/telemetry/status → current telemetry status (full stats)
app.get('/api/telemetry/status', async (request, reply) => {
  try {
    const workerStatus = await readUsageTelemetryWorkerStatus(HERMIT_HOME);
    const status = await enrichTelemetryStatus(
      workerStatus.status?.telemetry ?? (await getTelemetryStatus()) ?? telemetryEmptyStatus()
    );
    // `connected` drives the Redis status badge in the UI. The local scan never
    // knows about Redis, so reflect the live team-bus connection instead of
    // leaving the hardcoded `false` — otherwise a healthy bus always shows red.
    status.connected = true;
    status.scan = getTelemetryRuntimeStatus();
    status.worker = telemetryWorkerSummary(workerStatus);
    return status;
  } catch {
    return telemetryEmptyStatus();
  }
});

registerReviewCompatibilityRoutes(app);

// ===========================================================================
// SSE 推送端点 — 前端 EventSource 连接此处接收实时事件
// ===========================================================================

registerSseRoutes(app, {
  state: serverContext.state,
  assertTrustedBrowserOrigin,
});

// ── Extension Store routes (wired to extensionHandlers) ────────────────

setCapabilityPackLocalSource({
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
});

// Broadcast skill file-watcher changes to connected frontends via SSE.
setSkillsWatcherEmitter((event) => broadcastSse('skills:changed', event));

app.get('/api/extensions/plugins', async () => {
  const result = await ext.pluginGetAll();
  return result;
});

app.get('/api/extensions/plugins/readme/:pluginId', async (request) => {
  const { pluginId } = request.params as { pluginId: string };
  const result = await ext.pluginGetReadme(pluginId);
  return result;
});

app.post('/api/extensions/plugins/install', async (request) => {
  const body = request.body as Record<string, unknown>;
  const result = await ext.pluginInstall(body as unknown as PluginInstallRequest);
  return result;
});

app.post('/api/extensions/plugins/uninstall', async (request) => {
  const body = request.body as Record<string, unknown>;
  const result = await ext.pluginUninstall(
    body.pluginId as string,
    body.scope as string,
    body.projectPath as string,
    body.harnessType as HermitBridgeAgentType | undefined
  );
  return result;
});

app.get('/api/extensions/mcp/installed', async (request) => {
  const projectPath = (request.query as Record<string, string>).projectPath;
  const result = await ext.mcpGetInstalled(projectPath);
  return result;
});

app.post('/api/extensions/mcp/install-custom', async (request) => {
  const body = request.body as Record<string, unknown>;
  const result = await ext.mcpInstallCustom(body as unknown as McpCustomInstallRequest);
  return result;
});

app.post('/api/extensions/mcp/uninstall', async (request) => {
  const body = request.body as Record<string, unknown>;
  const result = await ext.mcpUninstall(
    body.name as string,
    body.scope as string,
    body.projectPath as string,
    body.harnessType as HermitBridgeAgentType | undefined
  );
  return result;
});

app.get('/api/extensions/mcp/library', async () => {
  return ext.mcpLibraryList();
});

app.post('/api/extensions/mcp/library', async (request) => {
  return ext.mcpLibraryUpsert(request.body as McpLibraryUpsertRequest);
});

app.delete('/api/extensions/mcp/library/:id', async (request) => {
  const { id } = request.params as { id: string };
  return ext.mcpLibraryDelete(id);
});

app.post('/api/extensions/mcp/library/import', async (request) => {
  return ext.mcpLibraryImport((request.body ?? {}) as McpLibraryImportRequest);
});

app.get('/api/extensions/capability-packs', async () => {
  return ext.capabilityPacksList();
});

app.post('/api/extensions/capability-packs/import', async (request) => {
  return ext.capabilityPacksImport((request.body ?? {}) as CapabilityPackImportRequest);
});

app.post('/api/extensions/capability-packs/export', async (request) => {
  return ext.capabilityPacksExport((request.body ?? {}) as CapabilityPackExportRequest);
});

app.post('/api/extensions/capability-packs/export/download', async (request, reply) => {
  const result = (await ext.capabilityPacksExport(
    (request.body ?? {}) as CapabilityPackExportRequest
  )) as {
    success: boolean;
    data?: { pack?: { packDir?: string; manifest?: { id?: string } }; warnings?: string[] };
    error?: string;
  };
  if (!result.success) {
    return reply
      .code(400)
      .send({ success: false, error: result.error ?? 'Export capability pack failed' });
  }

  const packDir = result.data?.pack?.packDir;
  if (!packDir) {
    return reply
      .code(500)
      .send({ success: false, error: 'Exported capability pack directory is missing' });
  }

  const zip = await zipDirectoryForDownload(packDir);
  const filename = `${sanitizeDownloadFilename(result.data?.pack?.manifest?.id ?? 'capability-pack')}.zip`;
  reply.header('Content-Type', 'application/zip');
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  reply.header(
    'X-Capability-Pack-Warnings',
    encodeURIComponent(JSON.stringify(result.data?.warnings ?? []))
  );
  return reply.send(zip);
});

app.post('/api/extensions/capability-packs/command-prompt', async (request) => {
  return ext.capabilityPacksCommandPrompt((request.body ?? {}) as CapabilityCommandPromptRequest);
});

app.get('/api/extensions/skills', async (request) => {
  const projectPath = (request.query as Record<string, string>).projectPath;
  const result = await ext.skillsList(projectPath);
  return result;
});

app.get('/api/extensions/skills/:skillId', async (request) => {
  const { skillId } = request.params as { skillId: string };
  const projectPath = (request.query as Record<string, string>).projectPath;
  const result = await ext.skillsGetDetail(skillId, projectPath);
  return result;
});

app.post('/api/extensions/skills/upsert', async (request) => {
  const result = await ext.skillsUpsert(request.body as SkillUpsertRequest);
  return result;
});

app.post('/api/extensions/skills/delete', async (request) => {
  const result = await ext.skillsDelete(request.body as SkillDeleteRequest);
  return result;
});

app.post('/api/extensions/skills/preview-upsert', async (request) => {
  return ext.skillsPreviewUpsert(request.body as SkillUpsertRequest);
});

app.post('/api/extensions/skills/apply-upsert', async (request) => {
  return ext.skillsApplyUpsert(request.body as SkillUpsertRequest);
});

app.post('/api/extensions/skills/preview-import', async (request) => {
  return ext.skillsPreviewImport(request.body as SkillImportRequest);
});

app.post('/api/extensions/skills/apply-import', async (request) => {
  return ext.skillsApplyImport(request.body as SkillImportRequest);
});

app.post('/api/extensions/skills/watching/start', async (request) => {
  const projectPath = (request.query as Record<string, string>).projectPath;
  return ext.skillsStartWatching(projectPath);
});

app.post('/api/extensions/skills/watching/stop', async (request) => {
  const { watchId } = (request.body ?? {}) as { watchId?: string };
  return ext.skillsStopWatching(watchId!);
});

app.get('/api/extensions/credentials/status', async () => {
  const result = await ext.credentialsStatus();
  return result;
});

app.get('/api/extensions/credentials/mcp/:mcpName', async (request) => {
  const { mcpName } = request.params as { mcpName: string };
  const result = await ext.credentialsGetMcp(mcpName);
  return result;
});

app.post('/api/extensions/credentials/mcp', async (request) => {
  const body = request.body as Record<string, unknown>;
  const result = await ext.credentialsSaveMcp(
    body.mcpName as string,
    body.envValues as Record<string, string>
  );
  return result;
});

app.get('/api/extensions/credentials/project-env', async (request) => {
  const projectPath = (request.query as Record<string, string>).projectPath;
  if (!projectPath) return { error: 'projectPath required' };
  const result = await ext.credentialsGetProjectEnv(projectPath);
  return result;
});

app.post('/api/extensions/credentials/project-env', async (request) => {
  const body = request.body as Record<string, unknown>;
  const result = await ext.credentialsSaveProjectEnv(
    body.projectPath as string,
    body.vars as Record<string, string>
  );
  return result;
});

app.post('/api/extensions/credentials/scan-required', async (request) => {
  const body = request.body as Record<string, unknown>;
  const result = await ext.credentialsScanRequired(
    body.projectPath as string,
    body.mcpServers as {
      name: string;
      envVars?: { name: string; isRequired: boolean; description?: string }[];
    }[],
    body.skillReqs as {
      name: string;
      envVars: { name: string; isRequired?: boolean; description?: string }[];
    }[]
  );
  return result;
});

app.get('/api/extensions/credentials/resolve-agent-env', async (request) => {
  const projectPath = (request.query as Record<string, string>).projectPath;
  if (!projectPath) return { error: 'projectPath required' };
  const result = await ext.credentialsResolveAgentEnv(projectPath);
  return result;
});

app.get('/api/extensions/credentials/skill-env', async (request) => {
  const folderName = (request.query as Record<string, string>).folderName;
  if (!folderName) return { error: 'folderName required' };
  const result = await ext.credentialsGetSkillGlobalEnv(folderName);
  return result;
});

app.post('/api/extensions/credentials/skill-env', async (request) => {
  const body = request.body as Record<string, unknown>;
  const result = await ext.credentialsSaveSkillGlobalEnv(
    body.folderName as string,
    body.vars as Record<string, string>
  );
  return result;
});

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
