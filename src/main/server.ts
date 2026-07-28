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
  copyFileSync,
  cpSync,
  existsSync as _existsSync2,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { createDashboardRecentProjectsLoader } from '@features/recent-projects/main/composition/dashboardRecentProjects';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { shouldAutoAllow } from '@main/utils/toolApprovalRules';
import { CROSS_TEAM_SENT_SOURCE } from '@shared/constants/crossTeam';
import {
  SYSTEM_MANAGER_BIND_PROJECT,
  SYSTEM_MANAGER_DISPLAY_NAME,
  SYSTEM_MANAGER_TEAM_NAME,
} from '@shared/types/team';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { discoverableTeamToWorker, type DiscoverableWorker } from '@shared/types/worker';
import { Cron } from 'croner';
import Fastify from 'fastify';

import {
  buildDirectReplyMessageId,
  type DirectCliEvent,
  DirectCliSessionManager,
} from './services/direct-cli';
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
import type {
  Task as TeamWorkspaceTask,
  TeamManifest,
} from './services/team-management/TeamWorkspaceService';
import type { CcSession, CcSessionDetail } from '@shared/types/api';
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
  ToolApprovalAutoResolved,
  ToolApprovalRequest,
  ToolApprovalSettings,
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
const teamStatsCache = new Map<
  string,
  {
    expiresAt: number;
    value: ProjectUsageStats | null;
    promise?: Promise<ProjectUsageStats | null>;
  }
>();

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

interface SseClient {
  res: import('node:http').ServerResponse;
  id: string;
}
const sseClients = new Set<SseClient>();

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

// 启动 bridge 并把事件广播到 SSE 客户端
bridge.start();

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

async function readEffectiveCcSettings(): Promise<Record<string, unknown>> {
  const localSettings = await hermitCcSettings.read();
  try {
    const remoteSettings = await cc.getGlobalSettings();
    return { ...DEFAULT_HERMIT_CC_SETTINGS, ...remoteSettings, ...localSettings };
  } catch {
    return { ...DEFAULT_HERMIT_CC_SETTINGS, ...localSettings };
  }
}

/** Routes a sessionKey → the team inbox + reply sender/recipient it belongs to. */
interface DirectCliRoute {
  teamName: string;
  /** `from` value persisted on the assistant reply (team name for lead, member name for DM). */
  from: string;
  to: string;
}

const directCliRoutes = new Map<string, DirectCliRoute>();

// Per-team tool-approval settings (auto-allow categories). Synced from the renderer on
// startup via /api/teams/:name/tool-approval/settings. Defaults deny everything so the user
// is prompted — matching Claude Code's native cmd permission flow.
const toolApprovalSettingsByName = new Map<string, ToolApprovalSettings>();

/**
 * Maps a permission requestId → the DirectCli session it came from (lead or member DM), plus
 * the toolName/toolInput needed to build the AskUserQuestion `updatedInput` at respond time.
 */
interface PendingPermissionApproval {
  sessionKey: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}
const permissionSessionByRequestId = new Map<string, PendingPermissionApproval>();

function readToolApprovalSettings(teamName: string): ToolApprovalSettings {
  return toolApprovalSettingsByName.get(teamName) ?? DEFAULT_TOOL_APPROVAL_SETTINGS;
}

// Auto-allow rules (autoAllowAll / file edits / safe-but-not-dangerous bash) live in the
// shared, unit-tested `toolApprovalRules` util — copied verbatim from the multi-agent
// reference impl so the rule set (incl. DANGEROUS_PATTERNS that override safe prefixes,
// e.g. `git rm`) stays byte-identical. Only `can_use_tool` is a real gate; other control
// subtypes must be auto-allowed or the stream deadlocks on stdin.

directCliManager.on('event', (event: DirectCliEvent) => {
  const route = directCliRoutes.get(event.sessionKey);
  if (!route) return;
  const { teamName } = route;

  if (event.kind === 'complete') {
    void (async () => {
      if (event.text) {
        await svc
          .appendMessage(teamName, {
            // Carry the streaming messageId as the canonical id so the renderer's
            // optimistic in-progress reply (same messageId) is pruned, not duplicated.
            id: event.messageId,
            from: route.from,
            to: route.to,
            role: 'agent',
            content: event.text,
            meta: { sessionKey: event.sessionKey, source: 'direct-cli' },
          })
          .catch((err) =>
            app.log.warn({ err, sessionKey: event.sessionKey }, 'direct-cli append failed')
          );
      }
      broadcastSse('team-change', { type: 'inbox', teamName });
    })();
    return;
  }

  if (event.kind === 'error') {
    app.log.warn({ error: event.error, sessionKey: event.sessionKey }, 'direct-cli session error');
    broadcastSse('team-change', { type: 'inbox', teamName });
    return;
  }

  if (event.kind === 'permission-request') {
    void (async () => {
      const settings = readToolApprovalSettings(teamName);
      // Non-`can_use_tool` subtypes (hook_callback, etc.) auto-allow to prevent deadlock;
      // `can_use_tool` goes through the shared shouldAutoAllow rules.
      const autoAllow =
        event.subtype !== 'can_use_tool' ||
        shouldAutoAllow(settings, event.toolName ?? 'Unknown', event.toolInput ?? {}).autoAllow;
      if (autoAllow) {
        try {
          directCliManager.respondPermission(event.sessionKey, event.requestId, true);
        } catch (err) {
          app.log.warn(
            { err, sessionKey: event.sessionKey },
            'direct-cli auto-allow respond failed'
          );
        }
        return;
      }
      // Surface to the renderer's CC-style approval sheet (Allow / Deny / Allow all). The
      // user's choice comes back via /api/teams/:name/tool-approval/respond, which writes
      // the control_response to stdin and unblocks the turn.
      permissionSessionByRequestId.set(event.requestId, {
        sessionKey: event.sessionKey,
        toolName: event.toolName,
        toolInput: event.toolInput,
      });
      broadcastSse('tool-approval-event', {
        requestId: event.requestId,
        runId: event.runId,
        teamName,
        source: 'lead',
        toolName: event.toolName ?? 'Unknown',
        toolInput: event.toolInput ?? {},
        receivedAt: new Date().toISOString(),
      } satisfies ToolApprovalRequest);
    })();
    return;
  }

  // init / delta / thinking / tool → live streaming payload for the renderer.
  broadcastSse('team-change', {
    type: 'direct-cli-stream',
    teamName,
    sessionKey: event.sessionKey,
    messageId: 'messageId' in event ? event.messageId : undefined,
    kind: event.kind,
    text: 'text' in event ? event.text : undefined,
    toolName: 'toolName' in event ? event.toolName : undefined,
    toolInput: 'toolInput' in event ? event.toolInput : undefined,
    from: route.from,
  });
});

bridge.on('reply', (msg) => {
  const sessionKey: string = (msg as { session_key?: string }).session_key ?? '';

  void (async () => {
    const teamName = await resolveTeamFromBridgeMessageWithRetry(msg);
    if (!teamName) return;
    // 先落盘再广播，否则前端可能在 appendFile 完成前刷新到旧 feed。
    await svc.appendMessage(teamName, {
      from: teamName,
      to: 'user',
      role: 'agent',
      content: (msg as { content?: string }).content ?? '',
      meta: { sessionKey },
    });
    broadcastSse('team-change', { type: 'inbox', teamName });
  })().catch((err) => {
    app.log.warn({ err, sessionKey }, 'bridge reply persistence failed');
  });
});

bridge.on('reply_stream', (msg) => {
  const sessionKey: string = (msg as { session_key?: string }).session_key ?? '';
  const done = (msg as { done?: boolean }).done ?? false;

  void (async () => {
    if (done) {
      const resolvedTeamName = await resolveTeamFromBridgeMessageWithRetry(msg);
      if (!resolvedTeamName) return;
      // 流式结束，存储完整回复
      const fullText = (msg as { full_text?: string }).full_text ?? '';
      if (fullText) {
        await svc.appendMessage(resolvedTeamName, {
          from: resolvedTeamName,
          to: 'user',
          role: 'agent',
          content: fullText,
          meta: { sessionKey },
        });
      }
      broadcastSse('team-change', { type: 'inbox', teamName: resolvedTeamName });
      return;
    }
    const teamName = await resolveTeamFromBridgeMessageWithRetry(msg);
    if (!teamName) return;
    broadcastSse('team-change', { type: 'lead-message', teamName });
  })().catch((err) => {
    app.log.warn({ err, sessionKey }, 'bridge stream reply persistence failed');
  });
});

bridge.on('message', (msg) => {
  const type = (msg as { type?: string }).type ?? '';
  const sessionKey: string = (msg as { session_key?: string }).session_key ?? '';
  if (!sessionKey) return; // 无 session_key 的控制帧（pong 等）不广播

  void (async () => {
    const teamName = await resolveTeamFromBridgeMessageWithRetry(msg);
    if (!teamName) return;
    // typing_start/stop → lead-message；其他 → inbox
    const eventType = type === 'typing_start' || type === 'typing_stop' ? 'lead-message' : 'inbox';
    broadcastSse('team-change', { type: eventType, teamName });
  })().catch((err) => {
    app.log.warn({ err, sessionKey, type }, 'bridge message routing failed');
  });
});

const BRIDGE_SESSION_TEAM_CACHE_TTL_MS = 60_000;
const EXTERNAL_PLATFORM_ROUTE_RETRY_COUNT = 6;
const EXTERNAL_PLATFORM_ROUTE_RETRY_DELAY_MS = 1_000;
const bridgeSessionTeamCache = new Map<string, { teamName: string; expiresAt: number }>();

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

const app = Fastify({
  logger: { level: process.env.HERMIT_LOG_LEVEL ?? 'warn' },
  disableRequestLogging: true,
});

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

async function proxyToHermitBridge(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  stripPrefix: string
) {
  const baseUrl = runtimeConfig.ccBaseUrl.replace(/\/+$/, '');
  const token = runtimeConfig.ccToken;

  const url = request.url;
  const subPath = url.replace(new RegExp(`^${stripPrefix}`), '') || '/';
  const target = `${baseUrl}/api/v1${subPath}`;

  const headers: Record<string, string> = {
    'Content-Type': request.headers['content-type']! ?? 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body == null ? undefined : JSON.stringify(request.body);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    request.log.warn({ target, err }, 'hermit-bridge proxy network error');
    return reply.code(502).send({
      ok: false,
      error: `hermit-bridge 不可达: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const body = Buffer.from(await upstream.arrayBuffer());

  // Detect non-JSON responses (HTML 404 pages, etc.) and return a clear error
  // instead of forwarding garbage that will crash the frontend's JSON.parse.
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.includes('json') && upstream.status >= 400) {
    const snippet = body.toString('utf-8').slice(0, 100).trim();
    request.log.warn(
      { target, status: upstream.status, contentType, snippet },
      'hermit-bridge returned non-JSON error response'
    );
    return reply.code(upstream.status).send({
      ok: false,
      error:
        `hermit-bridge 端点 ${subPath} 返回了非 JSON 响应 (HTTP ${upstream.status})。` +
        '请检查 hermit-bridge 是否正在运行且支持该端点。',
    });
  }

  return reply
    .code(upstream.status)
    .header('Content-Type', contentType || 'application/json; charset=utf-8')
    .send(body);
}

app.all('/api/bridge/*', async (request, reply) =>
  proxyToHermitBridge(request, reply, '/api/bridge')
);
app.all('/api/cc/*', async (request, reply) => proxyToHermitBridge(request, reply, '/api/cc'));
app.all('/api/v1/*', async (request, reply) => proxyToHermitBridge(request, reply, '/api/v1'));

// ===========================================================================
// Hermit config (read/write ~/.hermit/config.json)
// ===========================================================================

app.get('/api/hermit-config', async () => ({
  ok: true,
  data: {
    ccBaseUrl: runtimeConfig.ccBaseUrl,
    // mask token: show only first 4 chars if present
    ccToken: runtimeConfig.ccToken ? runtimeConfig.ccToken.slice(0, 4) + '****' : '',
    ccTokenSet: runtimeConfig.ccToken.length > 0,
    ccBridgeUrl: runtimeConfig.ccBridgeUrl,
  },
}));

app.post<{
  Body: { ccBaseUrl?: string; ccToken?: string; ccBridgeUrl?: string };
}>('/api/hermit-config', async (request, reply) => {
  const { ccBaseUrl, ccToken, ccBridgeUrl } = request.body ?? {};
  const patch: Partial<HermitConfig> = {};
  if (ccBaseUrl !== undefined) patch.ccBaseUrl = ccBaseUrl.trim() || 'http://127.0.0.1:9820';
  if (ccToken !== undefined) patch.ccToken = ccToken.trim();
  if (ccBridgeUrl !== undefined)
    patch.ccBridgeUrl = ccBridgeUrl.trim() || 'ws://127.0.0.1:9810/bridge/ws';

  runtimeConfig = saveConfig(patch);
  // Hot-update the cc client so subsequent requests use new config immediately
  cc.updateConfig({ baseUrl: runtimeConfig.ccBaseUrl, token: runtimeConfig.ccToken });
  bridge.updateConfig({
    bridgeUrl: runtimeConfig.ccBridgeUrl,
    bridgeToken: runtimeConfig.ccBridgeToken || runtimeConfig.ccToken,
  });

  return {
    ok: true,
    data: { ccBaseUrl: runtimeConfig.ccBaseUrl, ccTokenSet: runtimeConfig.ccToken.length > 0 },
  };
});

app.get('/api/hermit-config/raw', async () => {
  try {
    const data = readHermitConfigRaw();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.post<{ Body: { content?: unknown } }>('/api/hermit-config/raw', async (request) => {
  try {
    const content = request.body?.content;
    if (typeof content !== 'string') {
      return { ok: false, error: 'content 必须是字符串' };
    }
    runtimeConfig = writeHermitConfigRaw(content);
    cc.updateConfig({ baseUrl: runtimeConfig.ccBaseUrl, token: runtimeConfig.ccToken });
    bridge.updateConfig({
      bridgeUrl: runtimeConfig.ccBridgeUrl,
      bridgeToken: runtimeConfig.ccBridgeToken || runtimeConfig.ccToken,
    });
    return {
      ok: true,
      data: {
        ccBaseUrl: runtimeConfig.ccBaseUrl,
        ccTokenSet: runtimeConfig.ccToken.length > 0,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ===========================================================================
// hermit-bridge config (Hermit-managed: ~/.hermit/cc-connect/config.toml)
// ===========================================================================

function readHermitBridgeConfigRaw(): { path: string; content: string } {
  return readHermitBridgeConfigTomlRaw();
}

/** Simple TOML parser for hermit-bridge config (handles only the fields we need). */
function readHermitBridgeConfig(): Record<string, unknown> {
  const { content: raw } = readHermitBridgeConfigTomlRaw();

  const result: Record<string, unknown> = {};

  // Top-level simple fields
  const dataDirMatch = /^data_dir\s*=\s*"([^"]*)"/m.exec(raw);
  if (dataDirMatch) result.data_dir = dataDirMatch[1];

  const languageMatch = /^language\s*=\s*"([^"]*)"/m.exec(raw);
  if (languageMatch) result.language = languageMatch[1];

  const idleTimeoutMatch = /^idle_timeout_mins\s*=\s*(\d+)/m.exec(raw);
  if (idleTimeoutMatch) result.idle_timeout_mins = Number(idleTimeoutMatch[1]);

  const maxTurnTimeMatch = /^max_turn_time_mins\s*=\s*(\d+)/m.exec(raw);
  if (maxTurnTimeMatch) result.max_turn_time_mins = Number(maxTurnTimeMatch[1]);

  const wsIdleTimeoutMatch = /^workspace_idle_timeout_mins\s*=\s*(\d+)/m.exec(raw);
  if (wsIdleTimeoutMatch) result.workspace_idle_timeout_mins = Number(wsIdleTimeoutMatch[1]);

  // [management] section
  const mgmtSection = /\[management\]([^\[]*)/s.exec(raw);
  if (mgmtSection) {
    const section = mgmtSection[1];
    const enabledMatch = /enabled\s*=\s*(true|false)/.exec(section);
    if (enabledMatch) result.management_enabled = enabledMatch[1] === 'true';
    const portMatch = /port\s*=\s*(\d+)/.exec(section);
    if (portMatch) result.management_port = Number(portMatch[1]);
    const tokenMatch = /token\s*=\s*"([^"]*)"/.exec(section);
    if (tokenMatch) result.management_token = tokenMatch[1];
  }

  // [bridge] section
  const bridgeSection = /\[bridge\]([^\[]*)/s.exec(raw);
  if (bridgeSection) {
    const section = bridgeSection[1];
    const enabledMatch = /enabled\s*=\s*(true|false)/.exec(section);
    if (enabledMatch) result.bridge_enabled = enabledMatch[1] === 'true';
    const portMatch = /port\s*=\s*(\d+)/.exec(section);
    if (portMatch) result.bridge_port = Number(portMatch[1]);
    const tokenMatch = /token\s*=\s*"([^"]*)"/.exec(section);
    if (tokenMatch) result.bridge_token = tokenMatch[1];
  }

  // [log] section
  const logSection = /\[log\]([^\[]*)/s.exec(raw);
  if (logSection) {
    const levelMatch = /level\s*=\s*"([^"]*)"/.exec(logSection[1]);
    if (levelMatch) result.log_level = levelMatch[1];
  }

  // [display] section
  const displaySection = /\[display\]([^\[]*)/s.exec(raw);
  if (displaySection) {
    const section = displaySection[1];
    const thinkingMatch = /thinking_messages\s*=\s*(true|false)/.exec(section);
    if (thinkingMatch) result.display_thinking = thinkingMatch[1] === 'true';
    const toolMatch = /tool_messages\s*=\s*(true|false)/.exec(section);
    if (toolMatch) result.display_tool = toolMatch[1] === 'true';
  }

  return result;
}

async function writeHermitBridgeConfig(updates: Record<string, unknown>): Promise<void> {
  const configFile = ensureWritableHermitBridgeConfigFile();
  let raw = readFileSync(configFile, 'utf-8');

  // Update top-level fields
  if (updates.language !== undefined) {
    raw = raw.replace(/^(language\s*=\s*)"[^"]*"/m, `$1"${updates.language}"`);
  }
  if (updates.idle_timeout_mins !== undefined) {
    raw = raw.replace(/^(idle_timeout_mins\s*=\s*)\d+/m, `$1${updates.idle_timeout_mins}`);
  }
  if (updates.max_turn_time_mins !== undefined) {
    if (/^max_turn_time_mins\s*=/m.exec(raw)) {
      raw = raw.replace(/^(max_turn_time_mins\s*=\s*)\d+/m, `$1${updates.max_turn_time_mins}`);
    } else {
      raw = raw.replace(
        /^(idle_timeout_mins\s*=\s*\d+)/m,
        `$1\nmax_turn_time_mins = ${updates.max_turn_time_mins}`
      );
    }
  }
  if (updates.workspace_idle_timeout_mins !== undefined) {
    if (/^workspace_idle_timeout_mins\s*=/m.exec(raw)) {
      raw = raw.replace(
        /^(workspace_idle_timeout_mins\s*=\s*)\d+/m,
        `$1${updates.workspace_idle_timeout_mins}`
      );
    } else {
      raw = raw.replace(
        /^(idle_timeout_mins\s*=\s*\d+)/m,
        `$1\nworkspace_idle_timeout_mins = ${updates.workspace_idle_timeout_mins}`
      );
    }
  }

  // Update [management] section
  if (updates.management_enabled !== undefined) {
    const val = updates.management_enabled ? 'true' : 'false';
    raw = raw.replace(
      /(\[management\][^\n]*\n(?:[^\[]*))(enabled\s*=\s*)(true|false)/s,
      (match, prefix, key) => `${prefix}${key}${val}`
    );
  }
  if (updates.management_port !== undefined) {
    raw = raw.replace(
      /(\[management\][^\n]*\n(?:[^\[]*))(port\s*=\s*)\d+/s,
      `$1$2${updates.management_port}`
    );
  }
  if (updates.management_token !== undefined) {
    raw = raw.replace(
      /(\[management\][^\n]*\n(?:[^\[]*))(token\s*=\s*)"[^"]*"/s,
      `$1$2"${updates.management_token}"`
    );
  }

  // Update [bridge] section
  if (updates.bridge_enabled !== undefined) {
    const val = updates.bridge_enabled ? 'true' : 'false';
    raw = raw.replace(/(\[bridge\][^\n]*\n(?:[^\[]*))(enabled\s*=\s*)(true|false)/s, `$1$2${val}`);
  }
  if (updates.bridge_port !== undefined) {
    raw = raw.replace(
      /(\[bridge\][^\n]*\n(?:[^\[]*))(port\s*=\s*)\d+/s,
      `$1$2${updates.bridge_port}`
    );
  }
  if (updates.bridge_token !== undefined) {
    raw = raw.replace(
      /(\[bridge\][^\n]*\n(?:[^\[]*))(token\s*=\s*)"[^"]*"/s,
      `$1$2"${updates.bridge_token}"`
    );
  }

  // Update [log] section
  if (updates.log_level !== undefined) {
    raw = raw.replace(
      /(\[log\][^\n]*\n(?:[^\[]*))(level\s*=\s*)"[^"]*"/s,
      `$1$2"${updates.log_level}"`
    );
  }

  // Update [display] section
  if (updates.display_thinking !== undefined) {
    const val = updates.display_thinking ? 'true' : 'false';
    raw = raw.replace(
      /(\[display\][^\n]*\n(?:[^\[]*))(thinking_messages\s*=\s*)(true|false)/s,
      `$1$2${val}`
    );
  }
  if (updates.display_tool !== undefined) {
    const val = updates.display_tool ? 'true' : 'false';
    raw = raw.replace(
      /(\[display\][^\n]*\n(?:[^\[]*))(tool_messages\s*=\s*)(true|false)/s,
      `$1$2${val}`
    );
  }

  await atomicWriteAsync(configFile, raw);
}

async function writeHermitBridgeConfigRaw(content: string): Promise<void> {
  const configFile = ensureWritableHermitBridgeConfigFile();
  await atomicWriteAsync(configFile, content);
}

async function handleReadHermitBridgeConfig() {
  try {
    const config = readHermitBridgeConfig();
    // Mask tokens in the structured response — the UI only needs to know they
    // are set (mirrors /api/hermit-config masking). Raw values remain available
    // via the origin-guarded /raw route for the config editor.
    const mgmtToken = config.management_token;
    if (typeof mgmtToken === 'string' && mgmtToken) {
      config.management_token = mgmtToken.slice(0, 4) + '****';
    }
    const bridgeToken = config.bridge_token;
    if (typeof bridgeToken === 'string' && bridgeToken) {
      config.bridge_token = bridgeToken.slice(0, 4) + '****';
    }
    return { ok: true, data: config };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleWriteHermitBridgeConfig(
  request: import('fastify').FastifyRequest<{ Body: Record<string, unknown> }>
) {
  try {
    const updates = request.body ?? {};
    await writeHermitBridgeConfig(updates);

    // If management port/token changed, notify user to restart hermit-bridge.
    const needsRestart =
      'management_port' in updates ||
      'management_token' in updates ||
      'bridge_port' in updates ||
      'bridge_token' in updates;

    return {
      ok: true,
      data: { needsRestart },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleReadHermitBridgeConfigRaw() {
  try {
    const data = readHermitBridgeConfigRaw();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleWriteHermitBridgeConfigRaw(
  request: import('fastify').FastifyRequest<{ Body: { content?: unknown } }>
) {
  try {
    const content = request.body?.content;
    if (typeof content !== 'string') {
      return { ok: false, error: 'content 必须是字符串' };
    }
    await writeHermitBridgeConfigRaw(content);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

app.get('/api/hermit-bridge-config', handleReadHermitBridgeConfig);
app.post<{ Body: Record<string, unknown> }>(
  '/api/hermit-bridge-config',
  handleWriteHermitBridgeConfig
);
app.get('/api/hermit-bridge-config/raw', handleReadHermitBridgeConfigRaw);
app.post<{ Body: { content?: unknown } }>(
  '/api/hermit-bridge-config/raw',
  handleWriteHermitBridgeConfigRaw
);

app.get('/api/cc-config', handleReadHermitBridgeConfig);
app.post<{ Body: Record<string, unknown> }>('/api/cc-config', handleWriteHermitBridgeConfig);
app.get('/api/cc-config/raw', handleReadHermitBridgeConfigRaw);
app.post<{ Body: { content?: unknown } }>('/api/cc-config/raw', handleWriteHermitBridgeConfigRaw);

// ===========================================================================
// Health / cc-connect status (alias)
// ===========================================================================

app.get('/api/status', async () => {
  try {
    const data = await cc.getStatus();
    return { ok: true, data };
  } catch (err) {
    return reply500(err);
  }
});

// ===========================================================================
// Runtime readiness — cc-connect binary + sidecar health for the UI degraded banner
// ===========================================================================

app.get('/api/v1/system/readiness', async () => {
  return { ok: true, data: getRuntimeReadiness() };
});

// ===========================================================================
// cc-connect global settings proxy
// ===========================================================================

app.get('/api/cc-settings', async () => {
  const data = await readEffectiveCcSettings();
  return { ok: true, data };
});

app.patch<{ Body: Record<string, unknown> }>('/api/cc-settings', async (request, reply) => {
  const patch = request.body ?? {};
  try {
    const localSettings = await hermitCcSettings.patch(patch);
    let remoteSettings: Record<string, unknown> = {};
    try {
      remoteSettings = await cc.patchGlobalSettings(patch);
    } catch (err) {
      app.log.warn({ err }, 'cc-connect settings patch failed; saved Hermit settings locally');
    }
    return {
      ok: true,
      data: { ...DEFAULT_HERMIT_CC_SETTINGS, ...remoteSettings, ...localSettings },
    };
  } catch (err) {
    return reply500(err);
  }
});

// restart / reload cc-connect
app.post('/api/cc-restart', async () => {
  try {
    await restartHermitBridgeAndReconnect();
    return { ok: true };
  } catch (err) {
    return reply500(err);
  }
});

app.post('/api/cc-reload', async () => {
  try {
    await cc.reload();
    return { ok: true };
  } catch (err) {
    return reply500(err);
  }
});

// ===========================================================================
// Teams — cc-connect projects 即团队，本地 ~/.hermit/teams/ 仅存 tasks + 额外元数据
// ===========================================================================

// POST /api/system-manager/ensure → 确保项目级 Helm Loop存在
app.post('/api/system-manager/ensure', async (_request, reply) => {
  try {
    const summary = await ensureSystemManager();
    // Fire-and-forget the one-shot ops-guide bootstrap. Idempotent (skips once the
    // marker is set) and retries on fetch failure each time the console opens.
    void ensureAdminLoopInitialized();
    return summary;
  } catch (err) {
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/system-manager/status', async (_request, reply) => {
  try {
    return await systemManagerConfig.getStatus();
  } catch (err) {
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/system-manager/config', async (_request, reply) => {
  try {
    const config = await systemManagerConfig.getConfig();
    return config;
  } catch (err) {
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put<{ Body: { selectedWorkDir?: string } }>(
  '/api/system-manager/config',
  async (request, reply) => {
    try {
      const config = await systemManagerConfig.updateConfig(request.body ?? {});
      return config;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

app.post<{ Body: { folder?: string } }>(
  '/api/system-manager/workflows/list',
  async (request, reply) => {
    try {
      assertTrustedBrowserOrigin(request);
      const config = await systemManagerConfig.getConfig();
      const workspaceRoot = config.selectedWorkDir.replace(/[\\/]+$/, '');
      const folder =
        typeof request.body?.folder === 'string' && request.body.folder.trim().length > 0
          ? request.body.folder
          : path.join(workspaceRoot, '.claude', 'commands');
      if (!folder) return { folder: '', prompts: [], warnings: [] };
      return await workflowPromptService.list(folder);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('Forbidden origin:')) {
        return reply.code(403).send({ error: message });
      }
      return { folder: '', prompts: [], warnings: [] };
    }
  }
);

app.post<{ Body: { folder?: string; id?: string } }>(
  '/api/system-manager/workflows/read',
  async (request, reply) => {
    try {
      assertTrustedBrowserOrigin(request);
      const config = await systemManagerConfig.getConfig();
      const workspaceRoot = config.selectedWorkDir.replace(/[\\/]+$/, '');
      const folder =
        typeof request.body?.folder === 'string' && request.body.folder.trim().length > 0
          ? request.body.folder
          : path.join(workspaceRoot, '.claude', 'commands');
      if (!folder) return reply.code(400).send({ error: 'command folder is not configured' });
      const id = typeof request.body?.id === 'string' ? request.body.id : '';
      return await workflowPromptService.read(folder, id);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function appleScriptStringLiteral(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => `"${escapeAppleScriptString(line)}"`)
    .join(' & linefeed & ');
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    void import('node:child_process')
      .then(({ execFile }) => {
        execFile(file, args, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
      .catch(reject);
  });
}

function spawnDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    void import('node:child_process')
      .then(({ spawn }) => {
        const child = spawn(file, args, { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      })
      .catch(reject);
  });
}

function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

// Launches commands in an external/system terminal only; no embedded terminal mode.
async function openCommandInSystemTerminal(
  shellLine: string,
  windowsShellLine: string
): Promise<void> {
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal"\ndo script ${appleScriptStringLiteral(shellLine)}\nactivate\nend tell`;
    await execFileAsync('osascript', ['-e', script]);
    return;
  }

  if (process.platform === 'win32') {
    await spawnDetached('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', windowsShellLine]);
    return;
  }

  const candidates = [
    ...(process.env.TERMINAL
      ? [{ file: process.env.TERMINAL, args: ['-e', 'sh', '-lc', shellLine] }]
      : []),
    { file: 'x-terminal-emulator', args: ['-e', 'sh', '-lc', shellLine] },
    { file: 'gnome-terminal', args: ['--', 'sh', '-lc', shellLine] },
    { file: 'konsole', args: ['-e', 'sh', '-lc', shellLine] },
    { file: 'xfce4-terminal', args: ['-e', 'sh', '-lc', shellLine] },
    { file: 'alacritty', args: ['-e', 'sh', '-lc', shellLine] },
    { file: 'kitty', args: ['sh', '-lc', shellLine] },
    { file: 'wezterm', args: ['start', '--', 'sh', '-lc', shellLine] },
  ];

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      await spawnDetached(candidate.file, candidate.args);
      return;
    } catch (err) {
      errors.push(`${candidate.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`No system terminal launcher succeeded. ${errors.join('; ')}`);
}

// POST /api/terminal/open-external — open command in an external/system terminal
app.post<{ Body: { command: string; args?: string[]; cwd?: string } }>(
  '/api/terminal/open-external',
  async (request, reply) => {
    try {
      assertTrustedBrowserOrigin(request);
      const { command, args = [], cwd } = request.body ?? {};
      if (!command) return reply.code(400).send({ error: 'command is required' });
      const normalizedArgs = Array.isArray(args)
        ? args.filter((arg) => typeof arg === 'string')
        : [];
      const cmd = [command, ...normalizedArgs].map(shellQuote).join(' ');
      const shellLine = cwd ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd;
      const windowsCmd = [command, ...normalizedArgs].map(cmdQuote).join(' ');
      const windowsShellLine = cwd ? `cd /d ${cmdQuote(cwd)} && ${windowsCmd}` : windowsCmd;
      await openCommandInSystemTerminal(shellLine, windowsShellLine);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply
        .code(message.startsWith('Forbidden origin:') ? 403 : 500)
        .send({ error: message });
    }
  }
);

// POST /api/direct-cli/resume-in-terminal — open a system terminal resuming a
// team member's or an IM agent's Claude session. For a team member it resolves
// the session id from the DirectCliSessionStore (same key member DMs use) and
// the workDir from the team manifest; for an IM agent the watcher already sent
// the agent_session_id (and a best-effort cwd). Reuses openCommandInSystemTerminal.
app.post<{
  Body: {
    teamName?: string;
    memberName?: string;
    resumeSessionId?: string;
    /** Backward-compatible alias for older IM callers. Prefer resumeSessionId. */
    agentSessionId?: string;
    cwd?: string;
  };
}>('/api/direct-cli/resume-in-terminal', async (request, reply) => {
  try {
    assertTrustedBrowserOrigin(request);
    const { teamName, memberName, resumeSessionId, agentSessionId, cwd } = request.body ?? {};

    let sessionId: string | undefined;
    let workDir = '';
    const directResumeSessionId = resumeSessionId?.trim() || agentSessionId?.trim() || '';
    if (directResumeSessionId) {
      sessionId = directResumeSessionId;
      workDir = cwd?.trim() || '';
    } else if (teamName) {
      const member = memberName?.trim() || 'lead';
      const sessionKey = `${teamName}:member:${member}`;
      sessionId = directCliManager.getSessionId(sessionKey);
      workDir = cwd?.trim() || (await resolveDirectCliWorkDir(teamName).catch(() => ''));
      if (!sessionId) {
        return reply.code(404).send({ error: `No Claude session found for ${sessionKey}` });
      }
    } else {
      return reply.code(400).send({ error: 'teamName or resumeSessionId is required' });
    }

    const binary = (await ClaudeBinaryResolver.resolve().catch(() => null)) || 'claude';
    const args = ['--resume', sessionId];
    const cmd = [binary, ...args].map(shellQuote).join(' ');
    const shellLine = workDir ? `cd ${shellQuote(workDir)} && ${cmd}` : cmd;
    const windowsCmd = [binary, ...args].map(cmdQuote).join(' ');
    const windowsShellLine = workDir ? `cd /d ${cmdQuote(workDir)} && ${windowsCmd}` : windowsCmd;
    await openCommandInSystemTerminal(shellLine, windowsShellLine);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(message.startsWith('Forbidden origin:') ? 403 : 500).send({ error: message });
  }
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

// ===========================================================================
// 定时任务 — 透传 cc-connect heartbeat API
// GET    /api/teams/:name/heartbeat
// POST   /api/teams/:name/heartbeat/enable
// POST   /api/teams/:name/heartbeat/disable
// POST   /api/teams/:name/heartbeat/pause
// POST   /api/teams/:name/heartbeat/resume
// PATCH  /api/teams/:name/heartbeat  { interval_mins, only_when_idle, silent }
// ===========================================================================

app.get<{ Params: { name: string } }>('/api/teams/:name/heartbeat', async (request, reply) => {
  try {
    const bindProject = await resolveRouteCcProjectName(request.params.name);
    const data = await cc.getHeartbeat(bindProject);
    return { ok: true, data };
  } catch (err) {
    return reply.code(404).send(reply500(err));
  }
});

app.post<{ Params: { name: string } }>(
  '/api/teams/:name/heartbeat/enable',
  async (request, reply) => {
    try {
      const bindProject = await resolveRouteCcProjectName(request.params.name);
      await cc.resumeHeartbeat(bindProject);
      return { ok: true };
    } catch (err) {
      return reply.code(500).send(reply500(err));
    }
  }
);

app.post<{ Params: { name: string } }>(
  '/api/teams/:name/heartbeat/disable',
  async (request, reply) => {
    try {
      const bindProject = await resolveRouteCcProjectName(request.params.name);
      await cc.pauseHeartbeat(bindProject);
      return { ok: true };
    } catch (err) {
      return reply.code(500).send(reply500(err));
    }
  }
);

app.post<{ Params: { name: string } }>(
  '/api/teams/:name/heartbeat/pause',
  async (request, reply) => {
    try {
      const bindProject = await resolveRouteCcProjectName(request.params.name);
      await cc.pauseHeartbeat(bindProject);
      return { ok: true };
    } catch (err) {
      return reply.code(500).send(reply500(err));
    }
  }
);

app.post<{ Params: { name: string } }>(
  '/api/teams/:name/heartbeat/resume',
  async (request, reply) => {
    try {
      const bindProject = await resolveRouteCcProjectName(request.params.name);
      await cc.resumeHeartbeat(bindProject);
      return { ok: true };
    } catch (err) {
      return reply.code(500).send(reply500(err));
    }
  }
);

app.patch<{
  Params: { name: string };
  Body: { interval_mins?: number; only_when_idle?: boolean; silent?: boolean };
}>('/api/teams/:name/heartbeat', async (request, reply) => {
  try {
    const bindProject = await resolveRouteCcProjectName(request.params.name);
    await cc.updateProject(bindProject, request.body as Record<string, unknown>);
    const data = await cc.getHeartbeat(bindProject);
    return { ok: true, data };
  } catch (err) {
    return reply.code(500).send(reply500(err));
  }
});

// ===========================================================================
// Harness 列表 — 从 cc-connect projects 提取已用 agent_type，合并固定枚举
// GET /api/harnesses
// ===========================================================================

app.get('/api/harnesses', async () => {
  try {
    const projects = await cc.listProjects();
    const usedTypes = new Set(projects.map((p) => p.agent_type));
    return CC_AGENT_TYPES.map((type) => ({
      type,
      inUse: usedTypes.has(type),
    }));
  } catch {
    // cc-connect 不可达时返回完整枚举列表
    return CC_AGENT_TYPES.map((type) => ({
      type,
      inUse: false,
    }));
  }
});

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

async function handleSetupSaveRestart(result: {
  data?: unknown;
  error?: unknown;
}): Promise<unknown> {
  const resultData =
    result && typeof result.data === 'object' && result.data !== null ? result.data : result;
  if (!resultData || typeof resultData !== 'object') return result;
  const data = resultData as Record<string, unknown>;
  if ('error' in data || data.restart_handled === true) return result;

  // A successful QR setup creates or updates a channel project. cc-connect must
  // reload that project before the new long-connection can receive messages, even
  // when an older upstream reports restart_required=false. AgentCli owns this
  // restart so CLI and renderer callers cannot leave a freshly-created worker idle.
  await restartHermitBridgeAndReconnect();
  const restarted = { ...data, restart_required: false, restart_handled: true };
  return result.data && typeof result.data === 'object'
    ? { ...result, data: restarted }
    : restarted;
}

// Feishu/Lark setup
app.post('/api/setup/feishu/begin', async (request, reply) => {
  try {
    const result = await (
      await fetch(`${runtimeConfig.ccBaseUrl}/api/v1/setup/feishu/begin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(runtimeConfig.ccToken ? { Authorization: `Bearer ${runtimeConfig.ccToken}` } : {}),
        },
        body: JSON.stringify(request.body ?? {}),
      })
    ).json();
    return result;
  } catch (err) {
    return reply500(err);
  }
});

app.post('/api/setup/feishu/poll', async (request, reply) => {
  try {
    const result = await (
      await fetch(`${runtimeConfig.ccBaseUrl}/api/v1/setup/feishu/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(runtimeConfig.ccToken ? { Authorization: `Bearer ${runtimeConfig.ccToken}` } : {}),
        },
        body: JSON.stringify(request.body ?? {}),
      })
    ).json();
    return result;
  } catch (err) {
    return reply500(err);
  }
});

app.post('/api/setup/feishu/save', async (request, reply) => {
  try {
    const requestBody = (request.body ?? {}) as Record<string, unknown>;
    const response = await fetch(`${runtimeConfig.ccBaseUrl}/api/v1/setup/feishu/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(runtimeConfig.ccToken ? { Authorization: `Bearer ${runtimeConfig.ccToken}` } : {}),
      },
      body: JSON.stringify(requestBody),
    });
    const result = (await response.json()) as { data?: unknown; error?: unknown };
    if (!response.ok) {
      return reply.code(response.status).send(result);
    }
    const resultData = result && typeof result.data === 'object' ? result.data : result;
    if (resultData && typeof resultData === 'object' && !('error' in resultData)) {
      await persistPlatformRoutingMetadataForProject(
        typeof requestBody.project === 'string' ? requestBody.project : '',
        typeof requestBody.platform_type === 'string' ? requestBody.platform_type : 'feishu',
        requestBody
      );
    }
    // await is required: a bare `return promise` lets a restart rejection bypass
    // the surrounding try/catch and surface as fastify's default 500
    // ("Internal Server Error") even though the platform save itself succeeded.
    return await handleSetupSaveRestart(result);
  } catch (err) {
    return reply500(err);
  }
});

// Weixin setup
app.post('/api/setup/weixin/begin', async (request, reply) => {
  try {
    const result = await (
      await fetch(`${runtimeConfig.ccBaseUrl}/api/v1/setup/weixin/begin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(runtimeConfig.ccToken ? { Authorization: `Bearer ${runtimeConfig.ccToken}` } : {}),
        },
        body: JSON.stringify(request.body ?? {}),
      })
    ).json();
    return result;
  } catch (err) {
    return reply500(err);
  }
});

app.post('/api/setup/weixin/poll', async (request, reply) => {
  try {
    const result = await (
      await fetch(`${runtimeConfig.ccBaseUrl}/api/v1/setup/weixin/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(runtimeConfig.ccToken ? { Authorization: `Bearer ${runtimeConfig.ccToken}` } : {}),
        },
        body: JSON.stringify(request.body ?? {}),
      })
    ).json();
    return result;
  } catch (err) {
    return reply500(err);
  }
});

app.post('/api/setup/weixin/save', async (request, reply) => {
  try {
    const requestBody = (request.body ?? {}) as Record<string, unknown>;
    const response = await fetch(`${runtimeConfig.ccBaseUrl}/api/v1/setup/weixin/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(runtimeConfig.ccToken ? { Authorization: `Bearer ${runtimeConfig.ccToken}` } : {}),
      },
      body: JSON.stringify(requestBody),
    });
    const result = (await response.json()) as { data?: unknown; error?: unknown };
    if (!response.ok) {
      return reply.code(response.status).send(result);
    }
    const resultData = result && typeof result.data === 'object' ? result.data : result;
    if (resultData && typeof resultData === 'object' && !('error' in resultData)) {
      await persistPlatformRoutingMetadataForProject(
        typeof requestBody.project === 'string' ? requestBody.project : '',
        'weixin',
        requestBody
      );
    }
    // await is required: a bare `return promise` lets a restart rejection bypass
    // the surrounding try/catch and surface as fastify's default 500
    // ("Internal Server Error") even though the platform save itself succeeded.
    return await handleSetupSaveRestart(result);
  } catch (err) {
    return reply500(err);
  }
});

// Generic platform add (manual credential form)
app.post<{
  Params: { name: string };
  Body: { type: string; options?: Record<string, unknown>; work_dir?: string; agent_type?: string };
}>('/api/projects/:name/add-platform', async (request, reply) => {
  try {
    const existingProject = await cc.getProject(request.params.name).catch(() => null);
    const result = await cc.createProject(
      request.params.name,
      request.body.agent_type ?? existingProject?.agent_type ?? 'claudecode',
      request.body.work_dir ?? existingProject?.work_dir ?? '',
      request.body.type,
      (request.body.options ?? {}) as Record<string, string>
    );

    await persistPlatformRoutingMetadataForProject(
      request.params.name,
      request.body.type,
      request.body.options ?? {}
    );

    if (result.restart_required) {
      // Adding Feishu/Lark/other platform engines only writes cc-connect config; a restart is
      // required before cc-connect listens to the new long-connection and Hermit must reconnect
      // its Bridge adapter after that restart. Do it here so callers cannot accidentally leave
      // cc-connect showing “connected” while Hermit is not listening.
      await restartHermitBridgeAndReconnect();
      return { ok: true, data: { ...result, restart_required: false, restart_handled: true } };
    }

    return { ok: true, data: { ...result, restart_handled: false } };
  } catch (err) {
    return reply500(err);
  }
});

// ===========================================================================
// 组织图 API — GET /api/graph
// 返回 nodes（团队）+ edges（任务 assignee 关系）供前端 Graph 渲染
// ===========================================================================

app.get('/api/graph', async () => {
  try {
    const projects = await cc.listProjects();
    const nodes = projects.map((p) => ({
      id: p.name,
      label: p.name,
      harness: p.agent_type,
      color: 'blue',
      collaboration: true,
      bindProject: p.name,
    }));

    const edges: { source: string; target: string; taskId: string; taskTitle: string }[] = [];
    for (const p of projects) {
      try {
        const tasks = await svc.readTasks(p.name);
        for (const task of tasks) {
          if (task.assignee && task.status !== 'done') {
            edges.push({
              source: p.name,
              target: task.assignee,
              taskId: task.id,
              taskTitle: task.title,
            });
          }
        }
      } catch {
        /* skip */
      }
    }

    return { ok: true, data: { nodes, edges } };
  } catch (err) {
    return reply500(err);
  }
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

const MCP_TOOLS = [
  {
    name: 'list_tasks',
    description: '列出指定团队的任务看板',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '团队 slug' },
      },
      required: ['team_slug'],
    },
  },
  {
    name: 'claim_task',
    description: '认领任务（状态改为 doing）',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '团队 slug' },
        task_id: { type: 'string', description: '任务 ID' },
      },
      required: ['team_slug', 'task_id'],
    },
  },
  {
    name: 'complete_task',
    description: '标记任务完成（状态改为 done），可写入结果摘要',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '团队 slug' },
        task_id: { type: 'string', description: '任务 ID' },
        result: { type: 'string', description: '完成结果摘要（可选）' },
      },
      required: ['team_slug', 'task_id'],
    },
  },
  {
    name: 'list_teams',
    description:
      '只读：列出所有可用团队（本地和远程）及能力信息。团队协作后续由总线和任务池承载，agent 不应自行派发。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'accept_task',
    description: '接受来自另一个团队的任务请求。在本地创建任务并通知发起方。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '你的团队 slug（接收方）' },
        dispatch_id: { type: 'string', description: '任务派发 ID' },
      },
      required: ['team_slug', 'dispatch_id'],
    },
  },
  {
    name: 'reject_task',
    description: '拒绝来自另一个团队的任务请求。通知发起方并附原因。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '你的团队 slug（接收方）' },
        dispatch_id: { type: 'string', description: '任务派发 ID' },
        reason: { type: 'string', description: '拒绝原因（可选）' },
      },
      required: ['team_slug', 'dispatch_id'],
    },
  },
  {
    name: 'list_pending_requests',
    description: '列出当前团队待处理的任务请求（尚未接受或拒绝的）。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '团队 slug' },
      },
      required: ['team_slug'],
    },
  },
  {
    name: 'deliver_task',
    description: '交付任务结果。完成任务后调用此工具，将结果发送给发起方审核。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '你的团队 slug（接收方/执行方）' },
        dispatch_id: { type: 'string', description: '任务派发 ID' },
        result: { type: 'string', description: '交付结果描述' },
      },
      required: ['team_slug', 'dispatch_id', 'result'],
    },
  },
  {
    name: 'approve_task',
    description: '审核通过任务交付。发起方对交付结果满意时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '你的团队 slug（发起方/审核方）' },
        dispatch_id: { type: 'string', description: '任务派发 ID' },
      },
      required: ['team_slug', 'dispatch_id'],
    },
  },
  {
    name: 'reject_result',
    description: '退回任务交付结果，要求修改。附上反馈意见。超过 3 次退回需要人工介入。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '你的团队 slug（发起方/审核方）' },
        dispatch_id: { type: 'string', description: '任务派发 ID' },
        feedback: { type: 'string', description: '退回反馈（需要修改的内容）' },
      },
      required: ['team_slug', 'dispatch_id', 'feedback'],
    },
  },
];

/** 执行 MCP tool，返回 content array */
async function executeMcpTool(
  toolName: string,
  args: Record<string, string>
): Promise<{ type: string; text: string }[]> {
  const text = async (result: unknown) => [{ type: 'text', text: JSON.stringify(result, null, 2) }];

  if (toolName === 'list_tasks') {
    const tasks = await svc.readTasks(args.team_slug);
    return text(tasks);
  }

  if (toolName === 'claim_task') {
    const task = await svc.patchTask(args.team_slug, args.task_id, { status: 'doing' });
    return text(task);
  }

  if (toolName === 'complete_task') {
    const patch: Record<string, unknown> = { status: 'done' };
    if (args.result) patch.result = args.result;
    const task = await svc.patchTask(args.team_slug, args.task_id, patch);
    return text(task);
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

// GET /mcp — SSE 端点（MCP over HTTP-SSE transport）
app.get('/mcp', (request, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // MCP initialize 握手
  const endpoint = `http://${request.hostname}/mcp`;
  reply.raw.write(`event: endpoint\ndata: ${JSON.stringify({ endpoint })}\n\n`);

  const ka = setInterval(() => {
    try {
      reply.raw.write(': keep-alive\n\n');
    } catch {
      clearInterval(ka);
    }
  }, 15000);

  request.raw.on('close', () => clearInterval(ka));
  return reply.hijack();
});

// POST /mcp — JSON-RPC 请求处理
app.post<{
  Body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
}>('/mcp', async (request, reply) => {
  const { id, method, params = {} } = request.body ?? {};

  // MCP initialize
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hermit-tasks', version: '1.0.0' },
      },
    };
  }

  // MCP tools/list
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }

  // MCP tools/call
  if (method === 'tools/call') {
    const toolName = params.name as string;
    const toolArgs = (params.arguments ?? {}) as Record<string, string>;
    try {
      const content = await executeMcpTool(toolName, toolArgs);
      return { jsonrpc: '2.0', id, result: { content } };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        },
      };
    }
  }

  // notifications/initialized — 无需响应
  if (method === 'notifications/initialized') {
    return reply.code(204).send();
  }

  return reply
    .code(400)
    .send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

// ===========================================================================
// Hermit 主仓 UI 首屏强依赖的几个 stub(占位实现)
// ===========================================================================

// hermit getAppVersion 期望返回 JSON 字符串；Fastify 直接 send(string) 会按 text/plain 返回。
app.get('/api/version', async (_request, reply) =>
  reply.type('application/json').send(JSON.stringify(pkg.version))
);

// GET /api/update/check — 检查是否有新版本
const updateService = new UpdateService();
app.get('/api/update/check', async () => updateService.checkForUpdates());

// POST /api/update/apply — 应用更新（SSE 推送进度）
app.post('/api/update/apply', async (request, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await updateService.applyUpdate((progress) => {
      send(progress);
      if (progress.phase === 'completed' || progress.phase === 'error') {
        reply.raw.end();
      }
    });
  } catch (err: unknown) {
    send({
      phase: 'error',
      message: 'Update failed',
      error: err instanceof Error ? err.message : String(err),
    });
    reply.raw.end();
  }
});

app.get('/api/dashboard/recent-projects', async () => dashboardRecentProjectsLoader());

app.get('/api/projects', async () => []);
app.get('/api/repository-groups', async () => []);

app.get('/api/notifications/unread-count', async () => ({ count: 0 }));
app.get('/api/notifications', async () => []);

// CLI installer / runtime / context 相关查询(主仓启动时会调,mvp 没这些概念)
app.get('/api/cli/status', async () => ({
  installed: true,
  version: 'cc-connect',
  path: null,
}));
app.get('/api/contexts', async () => []);
app.get('/api/contexts/active', async () => null);

const DEFAULT_APP_CONFIG = {
  notifications: {
    enabled: true,
    soundEnabled: true,
    ignoredRegex: [] as string[],
    ignoredRepositories: [] as string[],
    snoozedUntil: null as number | null,
    snoozeMinutes: 30,
    includeSubagentErrors: false,
    notifyOnLeadInbox: false,
    notifyOnUserInbox: true,
    notifyOnClarifications: true,
    notifyOnStatusChange: true,
    notifyOnTaskComments: true,
    notifyOnTaskCreated: true,
    notifyOnAllTasksCompleted: true,
    notifyOnCrossTeamMessage: true,
    notifyOnTeamLaunched: true,
    notifyOnToolApproval: true,
    autoResumeOnRateLimit: false,
    statusChangeOnlySolo: false,
    statusChangeStatuses: ['in_progress', 'completed'] as string[],
    triggers: [] as unknown[],
  },
  general: {
    launchAtLogin: false,
    showDockIcon: true,
    theme: 'dark' as 'dark' | 'light' | 'system',
    defaultTab: 'dashboard' as 'dashboard' | 'last-session',
    multimodelEnabled: false,
    claudeRootPath: null as string | null,
    agentLanguage: 'system',
    autoExpandAIGroups: false,
    useNativeTitleBar: false,
    telemetryEnabled: true,
  },
  providerConnections: {
    anthropic: {
      authMode: 'auto' as 'auto' | 'oauth' | 'api_key',
      fastModeDefault: false,
    },
    codex: {
      preferredAuthMode: 'auto' as 'auto' | 'chatgpt' | 'api_key',
    },
  },
  runtime: {
    providerBackends: {
      gemini: 'auto' as 'auto' | 'api' | 'cli-sdk',
      codex: 'codex-native' as const,
    },
  },
  display: {
    showTimestamps: true,
    compactMode: false,
    syntaxHighlighting: true,
  },
  sessions: {
    pinnedSessions: {} as Record<string, { sessionId: string; pinnedAt: number }[]>,
    hiddenSessions: {} as Record<string, { sessionId: string; hiddenAt: number }[]>,
  },
  claudeEnv: {} as Record<string, string>,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfigDefaults<T extends Record<string, unknown>>(defaults: T, value: unknown): T {
  if (!isPlainObject(value)) {
    return defaults;
  }
  const output: Record<string, unknown> = { ...defaults };
  for (const [key, entry] of Object.entries(value)) {
    const defaultEntry = output[key];
    output[key] = isPlainObject(defaultEntry) ? mergeConfigDefaults(defaultEntry, entry) : entry;
  }
  return output as T;
}

function readAppConfig() {
  try {
    if (_existsSync2(HERMIT_APP_CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(HERMIT_APP_CONFIG_FILE, 'utf-8')) as unknown;
      return mergeConfigDefaults(DEFAULT_APP_CONFIG, raw);
    }
  } catch (err) {
    const msg =
      err instanceof SyntaxError
        ? `${HERMIT_APP_CONFIG_FILE} 格式错误: ${err.message}。将使用默认配置并覆盖修复。`
        : `读取 ${HERMIT_APP_CONFIG_FILE} 失败`;
    app.log.warn({ err }, msg);
    // Auto-heal: rewrite with valid defaults
    try {
      mkdirSync(HERMIT_HOME, { recursive: true });
      writeFileSync(HERMIT_APP_CONFIG_FILE, JSON.stringify(DEFAULT_APP_CONFIG, null, 2), 'utf-8');
    } catch {
      // Give up if write also fails
    }
  }
  return DEFAULT_APP_CONFIG;
}

function writeAppConfig(config: typeof DEFAULT_APP_CONFIG): typeof DEFAULT_APP_CONFIG {
  mkdirSync(HERMIT_HOME, { recursive: true });
  writeFileSync(HERMIT_APP_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

app.get('/api/config', async () => ({
  success: true,
  data: readAppConfig(),
}));

app.post<{ Body: { section?: unknown; data?: unknown } }>('/api/config/update', async (request) => {
  const section = typeof request.body?.section === 'string' ? request.body.section : '';
  const patch = isPlainObject(request.body?.data) ? request.body.data : {};
  const current = readAppConfig();
  const next = section
    ? mergeConfigDefaults(current, {
        [section]: {
          ...(isPlainObject((current as Record<string, unknown>)[section])
            ? ((current as Record<string, unknown>)[section] as Record<string, unknown>)
            : {}),
          ...patch,
        },
      })
    : current;
  return {
    success: true,
    data: writeAppConfig(next),
  };
});

app.get('/api/config/triggers', async () => []);

const CRON_ZERO_TIME_PREFIX = '0001-01-01T00:00:00';
const DEFAULT_SCHEDULE_TIMEZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
const DEFAULT_SCHEDULE_WARMUP_MINUTES = 15;
const DEFAULT_SCHEDULE_MAX_TURNS = 50;
const DEFAULT_SCHEDULE_MAX_CONSECUTIVE_FAILURES = 3;

interface InMemoryScheduleRun {
  id: string;
  scheduleId: string;
  teamName: string;
  status:
    | 'pending'
    | 'warming_up'
    | 'warm'
    | 'running'
    | 'completed'
    | 'failed'
    | 'failed_interrupted'
    | 'cancelled';
  scheduledFor: string;
  startedAt: string;
  warmUpCompletedAt?: string;
  executionStartedAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  error?: string;
  retryCount: number;
  summary?: string;
}

const scheduleRunsById = new Map<string, InMemoryScheduleRun[]>();
const scheduleRunLogsByKey = new Map<string, { stdout: string; stderr: string }>();

function makeScheduleRunLogKey(scheduleId: string, runId: string): string {
  return `${scheduleId}:${runId}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeCronLastRun(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.startsWith(CRON_ZERO_TIME_PREFIX)) return undefined;
  return value;
}

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

async function resolveTeamWorkDirs(teamNames: string[]): Promise<Map<string, string>> {
  const uniqueTeamNames = [...new Set(teamNames.filter((name) => name.trim().length > 0))];
  const results = new Map<string, string>();

  await Promise.all(
    uniqueTeamNames.map(async (teamName) => {
      let cwd = '';
      try {
        const meta = await svc.readTeamManifest(teamName);
        if (typeof meta.workDir === 'string') {
          cwd = meta.workDir.trim();
        }
      } catch {
        // ignore
      }

      if (!cwd) {
        try {
          const detail = await cc.getProject(teamName);
          if (typeof detail.work_dir === 'string') {
            cwd = detail.work_dir.trim();
          }
        } catch {
          // ignore
        }
      }

      results.set(teamName, cwd);
    })
  );

  return results;
}

function mapCronJobToSchedule(
  cronJob: {
    id: string;
    project: string;
    cron_expr: string;
    prompt: string;
    description?: string;
    enabled: boolean;
    created_at: string;
    last_run?: string;
  },
  cwd: string
): {
  id: string;
  teamName: string;
  label?: string;
  cronExpression: string;
  timezone: string;
  status: 'active' | 'paused' | 'disabled';
  warmUpMinutes: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  maxTurns: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  launchConfig: { cwd: string; prompt: string };
} {
  const lastRunAt = normalizeCronLastRun(cronJob.last_run);
  const status: 'active' | 'paused' = cronJob.enabled ? 'active' : 'paused';

  // Compute next run time from cron expression
  let nextRunAt: string | undefined;
  if (cronJob.enabled && isNonEmptyString(cronJob.cron_expr)) {
    try {
      const job = new Cron(cronJob.cron_expr.trim(), {
        timezone: DEFAULT_SCHEDULE_TIMEZONE,
        paused: true,
      });
      const next = job.nextRun();
      if (next) {
        nextRunAt = (next instanceof Date ? next : new Date(next)).toISOString();
      }
    } catch {
      // Invalid cron expression — leave nextRunAt undefined
    }
  }

  return {
    id: cronJob.id,
    teamName: cronJob.project,
    label: isNonEmptyString(cronJob.description) ? cronJob.description.trim() : undefined,
    cronExpression: cronJob.cron_expr,
    timezone: DEFAULT_SCHEDULE_TIMEZONE,
    status,
    warmUpMinutes: DEFAULT_SCHEDULE_WARMUP_MINUTES,
    maxConsecutiveFailures: DEFAULT_SCHEDULE_MAX_CONSECUTIVE_FAILURES,
    consecutiveFailures: 0,
    maxTurns: DEFAULT_SCHEDULE_MAX_TURNS,
    createdAt: cronJob.created_at,
    updatedAt: lastRunAt ?? cronJob.created_at,
    lastRunAt,
    nextRunAt,
    launchConfig: {
      cwd,
      prompt: cronJob.prompt,
    },
  };
}

function normalizeScheduleRouteId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith('schedule:')) {
    return trimmed.slice('schedule:'.length);
  }
  if (trimmed.startsWith('SCH-')) {
    return trimmed.slice('SCH-'.length);
  }
  return trimmed;
}

function findCronJobByRouteId<
  T extends {
    id: string;
  },
>(jobs: T[], id: string): T | undefined {
  const normalized = normalizeScheduleRouteId(id);
  const exact = jobs.find((job) => job.id === normalized || job.id === id);
  if (exact) return exact;

  const prefixMatches = jobs.filter((job) => job.id.startsWith(normalized));
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

function clearScheduleRuntimeState(scheduleId: string): void {
  scheduleRunsById.delete(scheduleId);
  for (const key of [...scheduleRunLogsByKey.keys()]) {
    if (key.startsWith(`${scheduleId}:`)) {
      scheduleRunLogsByKey.delete(key);
    }
  }
}

function isCronNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(\b404\b|not found|no matching|does not exist|不存在)/i.test(message);
}

app.get('/api/schedules', async () => {
  try {
    const jobs = await cc.listCronJobs();
    if (jobs.length === 0) return [];
    const workDirMap = await resolveTeamWorkDirs(jobs.map((job) => job.project));
    return jobs.map((job) => mapCronJobToSchedule(job, workDirMap.get(job.project) ?? ''));
  } catch (err) {
    app.log.warn({ err }, 'list schedules from cc-connect failed');
    return [];
  }
});

app.get<{ Params: { id: string } }>('/api/schedules/:id', async (request) => {
  try {
    const jobs = await cc.listCronJobs();
    const job = jobs.find((item) => item.id === request.params.id);
    if (!job) return null;
    const workDirMap = await resolveTeamWorkDirs([job.project]);
    return mapCronJobToSchedule(job, workDirMap.get(job.project) ?? '');
  } catch (err) {
    app.log.warn({ err, scheduleId: request.params.id }, 'get schedule from cc-connect failed');
    return null;
  }
});

app.post<{ Body: Record<string, unknown> }>('/api/schedules', async (request, reply) => {
  try {
    const body = request.body ?? {};
    const teamName = typeof body.teamName === 'string' ? body.teamName.trim() : '';
    const cronExpression =
      typeof body.cronExpression === 'string' ? body.cronExpression.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const maxTurns =
      typeof body.maxTurns === 'number' && Number.isFinite(body.maxTurns)
        ? Math.max(1, Math.floor(body.maxTurns))
        : DEFAULT_SCHEDULE_MAX_TURNS;

    const launchConfig =
      body.launchConfig &&
      typeof body.launchConfig === 'object' &&
      !Array.isArray(body.launchConfig)
        ? (body.launchConfig as Record<string, unknown>)
        : {};
    const prompt = typeof launchConfig.prompt === 'string' ? launchConfig.prompt.trim() : '';
    const cwd = typeof launchConfig.cwd === 'string' ? launchConfig.cwd.trim() : '';
    const sessionKey =
      typeof launchConfig.session_key === 'string' && launchConfig.session_key.trim().length > 0
        ? launchConfig.session_key.trim()
        : buildFallbackSessionKey(teamName);

    if (!teamName || !cronExpression || !prompt) {
      return reply
        .code(400)
        .send({ error: 'teamName、cronExpression、launchConfig.prompt 不能为空' });
    }
    const created = await cc.createCronJob({
      project: teamName,
      session_key: sessionKey,
      cron_expr: cronExpression,
      prompt,
      description: label || undefined,
      enabled: true,
      timeout_mins: maxTurns,
    });

    const schedule = mapCronJobToSchedule(created, cwd);
    broadcastSse('schedule:change', {
      type: 'schedule-updated',
      scheduleId: schedule.id,
      teamName: schedule.teamName,
      detail: 'created',
    });
    return schedule;
  } catch (err) {
    return reply500(err);
  }
});

app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
  '/api/schedules/:id',
  async (request, reply) => {
    try {
      const jobs = await cc.listCronJobs();
      const existing = jobs.find((item) => item.id === request.params.id);
      if (!existing) {
        return reply.code(404).send({ error: 'Schedule not found' });
      }

      const patchBody = request.body ?? {};
      const patch: Record<string, unknown> = {};
      if (typeof patchBody.label === 'string') {
        patch.description = patchBody.label.trim();
      }
      if (typeof patchBody.cronExpression === 'string') {
        patch.cron_expr = patchBody.cronExpression.trim();
      }
      const launchConfig =
        patchBody.launchConfig &&
        typeof patchBody.launchConfig === 'object' &&
        !Array.isArray(patchBody.launchConfig)
          ? (patchBody.launchConfig as Record<string, unknown>)
          : null;
      if (launchConfig && typeof launchConfig.prompt === 'string') {
        patch.prompt = launchConfig.prompt.trim();
      }
      if (typeof patchBody.maxTurns === 'number' && Number.isFinite(patchBody.maxTurns)) {
        patch.timeout_mins = Math.max(1, Math.floor(patchBody.maxTurns));
      }

      const updated = Object.keys(patch).length
        ? await cc.updateCronJob(request.params.id, patch)
        : existing;

      const workDirMap = await resolveTeamWorkDirs([updated.project]);
      const schedule = mapCronJobToSchedule(updated, workDirMap.get(updated.project) ?? '');
      broadcastSse('schedule:change', {
        type: 'schedule-updated',
        scheduleId: schedule.id,
        teamName: schedule.teamName,
        detail: 'updated',
      });
      return schedule;
    } catch (err) {
      return reply500(err);
    }
  }
);

app.delete<{ Params: { id: string } }>('/api/schedules/:id', async (request, reply) => {
  const requestedId = request.params.id;
  const normalizedId = normalizeScheduleRouteId(requestedId);
  let resolvedId = normalizedId;
  let resolvedTeamName = '';

  try {
    let jobs: Awaited<ReturnType<typeof cc.listCronJobs>> = [];
    let listedJobs = false;
    try {
      jobs = await cc.listCronJobs();
      listedJobs = true;
    } catch (listErr) {
      request.log.warn(
        { err: listErr, scheduleId: requestedId },
        'list cron jobs before delete failed'
      );
    }
    const target = findCronJobByRouteId(jobs, requestedId);
    if (target) {
      resolvedId = target.id;
      resolvedTeamName =
        'project' in target && typeof target.project === 'string' ? target.project : '';
    } else if (
      listedJobs &&
      !jobs.some((job) => job.id === normalizedId || job.id.startsWith(normalizedId))
    ) {
      clearScheduleRuntimeState(normalizedId);
      broadcastSse('schedule:change', {
        type: 'schedule-updated',
        scheduleId: normalizedId,
        teamName: '',
        detail: 'deleted',
      });
      return {};
    }

    await cc.deleteCronJob(resolvedId);
    clearScheduleRuntimeState(resolvedId);
    broadcastSse('schedule:change', {
      type: 'schedule-updated',
      scheduleId: resolvedId,
      teamName: resolvedTeamName,
      detail: 'deleted',
    });
    return {};
  } catch (err) {
    if (isCronNotFoundError(err)) {
      clearScheduleRuntimeState(resolvedId);
      clearScheduleRuntimeState(normalizedId);
      broadcastSse('schedule:change', {
        type: 'schedule-updated',
        scheduleId: resolvedId,
        teamName: resolvedTeamName,
        detail: 'deleted',
      });
      return {};
    }
    try {
      const jobs = await cc.listCronJobs();
      const stillExists = Boolean(findCronJobByRouteId(jobs, requestedId));
      if (!stillExists) {
        clearScheduleRuntimeState(resolvedId);
        broadcastSse('schedule:change', {
          type: 'schedule-updated',
          scheduleId: resolvedId,
          teamName: resolvedTeamName,
          detail: 'deleted',
        });
        return {};
      }
    } catch (verifyErr) {
      request.log.warn({ err: verifyErr, scheduleId: requestedId }, 'verify cron delete failed');
    }
    return reply.code(500).send(reply500(err));
  }
});

app.post<{ Params: { id: string } }>('/api/schedules/:id/pause', async (request, reply) => {
  try {
    const jobs = await cc.listCronJobs();
    const current = jobs.find((item) => item.id === request.params.id);
    if (current) {
      try {
        await cc.sendMessage(
          current.project,
          current.session_key || buildFallbackSessionKey(current.project),
          '/stop'
        );
      } catch (err) {
        request.log.warn({ err, scheduleId: request.params.id }, 'send /stop for cron failed');
      }
    }
    const updated = await cc.updateCronJob(request.params.id, { enabled: false });
    broadcastSse('schedule:change', {
      type: 'schedule-paused',
      scheduleId: request.params.id,
      teamName: updated.project,
      detail: 'paused',
    });
    return {};
  } catch (err) {
    return reply500(err);
  }
});

app.post<{ Params: { id: string } }>('/api/schedules/:id/resume', async (request, reply) => {
  try {
    const updated = await cc.updateCronJob(request.params.id, { enabled: true });
    broadcastSse('schedule:change', {
      type: 'schedule-updated',
      scheduleId: request.params.id,
      teamName: updated.project,
      detail: 'resumed',
    });
    return {};
  } catch (err) {
    return reply500(err);
  }
});

app.post<{ Params: { id: string } }>('/api/schedules/:id/trigger', async (request, reply) => {
  try {
    const jobs = await cc.listCronJobs();
    const job = jobs.find((item) => item.id === request.params.id);
    if (!job) {
      return reply.code(404).send({ error: 'Schedule not found' });
    }
    const nowIso = new Date().toISOString();
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let run: InMemoryScheduleRun;

    try {
      await cc.sendMessage(
        job.project,
        job.session_key || buildFallbackSessionKey(job.project),
        job.prompt
      );
      run = {
        id: runId,
        scheduleId: job.id,
        teamName: job.project,
        status: 'running',
        scheduledFor: nowIso,
        startedAt: nowIso,
        executionStartedAt: nowIso,
        retryCount: 0,
        summary: 'Triggered via Hermit; waiting for agent runtime',
      };
      scheduleRunLogsByKey.set(makeScheduleRunLogKey(job.id, runId), {
        stdout: `Triggered at ${nowIso}`,
        stderr: '',
      });
    } catch (error) {
      run = {
        id: runId,
        scheduleId: job.id,
        teamName: job.project,
        status: 'failed',
        scheduledFor: nowIso,
        startedAt: nowIso,
        executionStartedAt: nowIso,
        completedAt: nowIso,
        durationMs: 0,
        exitCode: 1,
        retryCount: 0,
        error: error instanceof Error ? error.message : String(error),
        summary: 'Trigger failed',
      };
      scheduleRunLogsByKey.set(makeScheduleRunLogKey(job.id, runId), {
        stdout: '',
        stderr: run.error ?? 'Trigger failed',
      });
    }

    const previousRuns = scheduleRunsById.get(job.id) ?? [];
    scheduleRunsById.set(job.id, [run, ...previousRuns].slice(0, 100));
    broadcastSse('schedule:change', {
      type: run.status === 'failed' ? 'run-failed' : 'run-started',
      scheduleId: job.id,
      teamName: job.project,
      detail: run.status,
    });
    return run;
  } catch (err) {
    return reply500(err);
  }
});

app.get<{ Params: { id: string } }>('/api/schedules/:id/runs', async (request) => {
  const scheduleId = request.params.id;
  const runs = scheduleRunsById.get(scheduleId) ?? [];
  if (runs.length > 0) {
    return runs;
  }

  try {
    const jobs = await cc.listCronJobs();
    const job = jobs.find((item) => item.id === scheduleId);
    const lastRunAt = normalizeCronLastRun(job?.last_run);
    if (!job || !lastRunAt) return [];
    return [
      {
        id: `last-${scheduleId}`,
        scheduleId,
        teamName: job.project,
        status: 'completed',
        scheduledFor: lastRunAt,
        startedAt: lastRunAt,
        executionStartedAt: lastRunAt,
        completedAt: lastRunAt,
        durationMs: 0,
        exitCode: 0,
        retryCount: 0,
        summary: 'Last run from cc-connect',
      },
    ];
  } catch {
    return [];
  }
});

app.get<{ Params: { id: string; runId: string } }>(
  '/api/schedules/:id/runs/:runId/logs',
  async (request) => {
    return (
      scheduleRunLogsByKey.get(makeScheduleRunLogKey(request.params.id, request.params.runId)) ?? {
        stdout: '',
        stderr: '',
      }
    );
  }
);

// Browse directories — returns subdirectories at the given path
app.post<{ Body: { path?: string; limit?: number } }>(
  '/api/config/browse-folders',
  async (request) => {
    const { path: dirPath, limit = 200 } = request.body ?? {};
    const target = dirPath?.trim() ? dirPath.trim() : os.homedir();

    try {
      const entries = readdirSync(target, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .slice(0, limit)
        .map((e) => path.join(target, e.name));
      return {
        success: true,
        data: { path: target, dirs, hasParent: target !== path.dirname(target) },
      };
    } catch {
      return { success: false, error: `无法访问目录: ${target}` };
    }
  }
);

// POST /api/workspace/list — 文件目录浏览
app.post<{ Body: { dirPath?: string } }>('/api/workspace/list', async (request) => {
  const { dirPath } = request.body ?? {};
  const target = dirPath?.trim() ? dirPath.trim() : os.homedir();

  try {
    const entries = readdirSync(target, { withFileTypes: true });
    const files = entries.slice(0, 500).map((e) => {
      const fullPath = path.join(target, e.name);
      const isDirectory = e.isDirectory();
      let size = 0;
      try {
        const stat = statSync(fullPath);
        size = stat.size;
      } catch {
        /* ignore */
      }
      return {
        name: e.name,
        isDirectory,
        size,
        ext: isDirectory ? '' : path.extname(e.name).slice(1).toLowerCase(),
      };
    });
    return { path: target, files, hasParent: target !== path.dirname(target) };
  } catch {
    return { path: target, files: [], hasParent: false, error: `无法访问目录: ${target}` };
  }
});

// ===========================================================================
// Project Editor API (web mode)
// ===========================================================================

const MAX_EDITOR_DIR_ENTRIES = 2000;
const MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024;

function resolveEditorRoot(rawRoot: unknown): string {
  if (typeof rawRoot !== 'string' || rawRoot.trim().length === 0) {
    throw new Error('root 参数不能为空');
  }
  const resolved = path.resolve(rawRoot.trim());
  // Defense in depth: refuse filesystem root / user home / sensitive dirs as
  // editor root. The editor is project-scoped; primary protection is the
  // loopback bind + global origin hook above.
  const home = os.homedir();
  const forbiddenRoots = new Set([
    path.parse(resolved).root,
    home,
    path.join(home, '.ssh'),
    path.join(home, '.hermit'),
  ]);
  if (forbiddenRoots.has(resolved)) {
    throw new Error('不允许将该目录作为项目根目录');
  }
  if (!_existsSync2(resolved)) {
    throw new Error(`目录不存在: ${resolved}`);
  }
  const st = statSync(resolved);
  if (!st.isDirectory()) {
    throw new Error(`不是目录: ${resolved}`);
  }
  return resolved;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveEditorPath(root: string, rawPath: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error('filePath/dirPath 参数不能为空');
  }
  const requested = rawPath.trim();
  const resolved = path.resolve(
    path.isAbsolute(requested) ? requested : path.join(root, requested)
  );
  if (!isPathInsideRoot(root, resolved)) {
    throw new Error('路径超出项目根目录');
  }
  return resolved;
}

function detectBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 4096);
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function sendEditorError(
  reply: { code: (statusCode: number) => { send: (payload: { error: string }) => unknown } },
  err: unknown
) {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(500).send({ error: message });
}

app.post<{ Body: { root?: unknown } }>('/api/editor/open', async (request, reply) => {
  try {
    const root = resolveEditorRoot(request.body?.root);
    return { ok: true, root };
  } catch (err) {
    return sendEditorError(reply, err);
  }
});

app.post('/api/editor/close', async () => ({ ok: true }));

app.get<{ Querystring: { root?: unknown; dirPath?: unknown; maxEntries?: string } }>(
  '/api/editor/readDir',
  async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.query.root);
      const dirPath = request.query.dirPath ? resolveEditorPath(root, request.query.dirPath) : root;
      const maxEntriesRaw = Number.parseInt(request.query.maxEntries ?? '', 10);
      const maxEntries = Number.isFinite(maxEntriesRaw)
        ? Math.min(Math.max(maxEntriesRaw, 1), MAX_EDITOR_DIR_ENTRIES)
        : MAX_EDITOR_DIR_ENTRIES;
      const entries = readdirSync(dirPath, { withFileTypes: true });
      const sliced = entries.slice(0, maxEntries);
      const mapped = sliced
        .map((entry) => {
          const fullPath = path.join(dirPath, entry.name);
          let size = 0;
          try {
            size = entry.isFile() ? statSync(fullPath).size : 0;
          } catch {
            size = 0;
          }
          return {
            name: entry.name,
            path: fullPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size,
          };
        })
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return {
        entries: mapped,
        truncated: entries.length > maxEntries,
      };
    } catch (err) {
      return sendEditorError(reply, err);
    }
  }
);

app.get<{ Querystring: { root?: unknown; filePath?: unknown } }>(
  '/api/editor/readFile',
  async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.query.root);
      const filePath = resolveEditorPath(root, request.query.filePath);
      const st = statSync(filePath);
      if (!st.isFile()) {
        throw new Error(`不是文件: ${filePath}`);
      }

      const fullBuffer = readFileSync(filePath);
      const truncated = fullBuffer.length > MAX_EDITOR_FILE_BYTES;
      const readBuffer = truncated ? fullBuffer.subarray(0, MAX_EDITOR_FILE_BYTES) : fullBuffer;
      const isBinary = detectBinary(readBuffer);
      return {
        content: isBinary ? '' : readBuffer.toString('utf-8'),
        size: st.size,
        mtimeMs: st.mtimeMs,
        truncated,
        encoding: isBinary ? 'binary' : 'utf-8',
        isBinary,
      };
    } catch (err) {
      return sendEditorError(reply, err);
    }
  }
);

app.post<{
  Body: { root?: unknown; filePath?: unknown; content?: unknown; baselineMtimeMs?: unknown };
}>('/api/editor/writeFile', async (request, reply) => {
  try {
    const root = resolveEditorRoot(request.body?.root);
    const filePath = resolveEditorPath(root, request.body?.filePath);
    const content = request.body?.content;
    if (typeof content !== 'string') {
      throw new Error('content 必须是字符串');
    }
    const baselineRaw = request.body?.baselineMtimeMs;
    if (typeof baselineRaw === 'number' && Number.isFinite(baselineRaw)) {
      const currentMtime = statSync(filePath).mtimeMs;
      if (Math.abs(currentMtime - baselineRaw) > 1) {
        throw new Error('CONFLICT: file changed on disk');
      }
    }
    writeFileSync(filePath, content, 'utf-8');
    const st = statSync(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    return sendEditorError(reply, err);
  }
});

app.post<{ Body: { root?: unknown; parentDir?: unknown; fileName?: unknown } }>(
  '/api/editor/createFile',
  async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.body?.root);
      const parentDir = resolveEditorPath(root, request.body?.parentDir);
      const fileName =
        typeof request.body?.fileName === 'string' ? request.body.fileName.trim() : '';
      if (!fileName) {
        throw new Error('fileName 不能为空');
      }
      const filePath = resolveEditorPath(root, path.join(parentDir, fileName));
      writeFileSync(filePath, '', { encoding: 'utf-8', flag: 'wx' });
      const st = statSync(filePath);
      return { filePath, mtimeMs: st.mtimeMs };
    } catch (err) {
      return sendEditorError(reply, err);
    }
  }
);

app.post<{ Body: { root?: unknown; parentDir?: unknown; dirName?: unknown } }>(
  '/api/editor/createDir',
  async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.body?.root);
      const parentDir = resolveEditorPath(root, request.body?.parentDir);
      const dirName = typeof request.body?.dirName === 'string' ? request.body.dirName.trim() : '';
      if (!dirName) {
        throw new Error('dirName 不能为空');
      }
      const dirPath = resolveEditorPath(root, path.join(parentDir, dirName));
      mkdirSync(dirPath, { recursive: false });
      return { dirPath };
    } catch (err) {
      return sendEditorError(reply, err);
    }
  }
);

app.post<{ Body: { root?: unknown; filePath?: unknown } }>(
  '/api/editor/deleteFile',
  async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.body?.root);
      const filePath = resolveEditorPath(root, request.body?.filePath);
      rmSync(filePath, { recursive: true, force: false });
      return { deletedPath: filePath };
    } catch (err) {
      return sendEditorError(reply, err);
    }
  }
);

app.post<{ Body: { root?: unknown; sourcePath?: unknown; destDir?: unknown } }>(
  '/api/editor/moveFile',
  async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.body?.root);
      const sourcePath = resolveEditorPath(root, request.body?.sourcePath);
      const destDir = resolveEditorPath(root, request.body?.destDir);
      const newPath = resolveEditorPath(root, path.join(destDir, path.basename(sourcePath)));
      const sourceStat = statSync(sourcePath);
      renameSync(sourcePath, newPath);
      return { newPath, isDirectory: sourceStat.isDirectory() };
    } catch (err) {
      return sendEditorError(reply, err);
    }
  }
);

app.post<{ Body: { root?: unknown; sourcePath?: unknown; newName?: unknown } }>(
  '/api/editor/renameFile',
  async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.body?.root);
      const sourcePath = resolveEditorPath(root, request.body?.sourcePath);
      const newName = typeof request.body?.newName === 'string' ? request.body.newName.trim() : '';
      if (!newName) {
        throw new Error('newName 不能为空');
      }
      const parentDir = path.dirname(sourcePath);
      const newPath = resolveEditorPath(root, path.join(parentDir, newName));
      const sourceStat = statSync(sourcePath);
      renameSync(sourcePath, newPath);
      return { newPath, isDirectory: sourceStat.isDirectory() };
    } catch (err) {
      return sendEditorError(reply, err);
    }
  }
);

app.get<{ Querystring: { root?: unknown } }>('/api/editor/listFiles', async (request, reply) => {
  try {
    const root = resolveEditorRoot(request.query.root);
    const result: { path: string; name: string; relativePath: string }[] = [];
    const walk = (dirPath: string) => {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.git' || entry.name === 'node_modules') {
            continue;
          }
          walk(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        result.push({
          path: fullPath,
          name: entry.name,
          relativePath: path.relative(root, fullPath),
        });
      }
    };
    walk(root);
    return result;
  } catch (err) {
    return sendEditorError(reply, err);
  }
});

app.get<{ Querystring: { root?: unknown; filePath?: unknown } }>(
  '/api/editor/readBinaryPreview',
  async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.query.root);
      const filePath = resolveEditorPath(root, request.query.filePath);
      const content = readFileSync(filePath);
      return {
        base64: content.toString('base64'),
        mimeType: 'application/octet-stream',
        size: content.length,
      };
    } catch (err) {
      return sendEditorError(reply, err);
    }
  }
);

app.get('/api/editor/gitStatus', async () => ({
  files: [],
  isGitRepo: false,
  branch: null,
}));

app.post('/api/editor/watchDir', async () => ({ ok: true }));
app.post('/api/editor/setWatchedFiles', async () => ({ ok: true }));
app.post('/api/editor/setWatchedDirs', async () => ({ ok: true }));
app.get('/api/editor/search', async () => ({ results: [], totalMatches: 0, truncated: false }));

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
        writeHermitBridgeConfigRaw(updatedToml);
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
        writeHermitBridgeConfigRaw(updatedToml);
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

// tool-approval: write the user's Allow/Deny choice back to the subprocess as a
// control_response, unblocking the turn so it can emit `result` and persist the reply.
app.post<{
  Params: { name: string };
  Body: { runId?: unknown; requestId?: unknown; allow?: unknown; message?: unknown };
}>('/api/teams/:name/tool-approval/respond', async (request, reply) => {
  const teamName = request.params.name;
  const requestId = typeof request.body?.requestId === 'string' ? request.body.requestId : '';
  const allow = request.body?.allow === true;
  const message =
    typeof request.body?.message === 'string' && request.body.message.trim()
      ? request.body.message
      : undefined;
  if (!requestId) return reply.code(400).send({ ok: false, error: 'requestId required' });
  const pending = permissionSessionByRequestId.get(requestId);
  const sessionKey = pending?.sessionKey ?? `${teamName}:lead`;
  // AskUserQuestion: pass the user's answers via updatedInput so the CLI delivers them
  // without re-prompting (mirrors the multi-agent reference impl + --permission-prompt-tool spec).
  let updatedInput: Record<string, unknown> | undefined;
  if (allow && message && pending?.toolName === 'AskUserQuestion') {
    const toolInput = pending.toolInput ?? {};
    try {
      updatedInput = { ...toolInput, answers: JSON.parse(message) as Record<string, string> };
    } catch {
      // If message isn't JSON, use it as the answer to the first question.
      const questions = (toolInput.questions as { question?: string }[] | undefined) ?? [];
      const answers: Record<string, string> = {};
      if (questions[0]?.question) answers[questions[0].question] = message;
      updatedInput = { ...toolInput, answers };
    }
  }
  try {
    directCliManager.respondPermission(sessionKey, requestId, allow, message, updatedInput);
  } catch (err) {
    app.log.warn({ err, sessionKey, requestId }, 'tool-approval respond failed');
  }
  permissionSessionByRequestId.delete(requestId);
  return { ok: true };
});

// tool-approval: persist auto-allow settings per team (in-memory; renderer re-syncs on startup).
app.post<{ Params: { name: string }; Body: Partial<ToolApprovalSettings> }>(
  '/api/teams/:name/tool-approval/settings',
  async (request) => {
    const teamName = request.params.name;
    const incoming = request.body ?? {};
    const prev = readToolApprovalSettings(teamName);
    toolApprovalSettingsByName.set(teamName, {
      autoAllowAll: incoming.autoAllowAll ?? prev.autoAllowAll,
      autoAllowFileEdits: incoming.autoAllowFileEdits ?? prev.autoAllowFileEdits,
      autoAllowSafeBash: incoming.autoAllowSafeBash ?? prev.autoAllowSafeBash,
      timeoutAction: incoming.timeoutAction ?? prev.timeoutAction,
      timeoutSeconds: incoming.timeoutSeconds ?? prev.timeoutSeconds,
    });
    return { ok: true };
  }
);

// tool-approval: read a file for the Edit/Write diff preview. Local-first, best-effort —
// errors return empty content so the approval sheet still renders without the diff.
app.post<{ Body: { filePath?: unknown } }>(
  '/api/teams/tool-approval/read-file',
  async (request) => {
    const filePath = typeof request.body?.filePath === 'string' ? request.body.filePath : '';
    if (!filePath) return { content: '' };
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { content };
    } catch {
      return { content: '' };
    }
  }
);

// validate-cli-args
app.post('/api/teams/validate-cli-args', async () => ({ valid: true, args: [], errors: [] }));

// Digital Workers API
async function listDiscoverableWorkers(): Promise<DiscoverableWorker[]> {
  const teams = await svc.discoverTeams();
  return teams
    .filter((team) => team.slug !== SYSTEM_MANAGER_TEAM_NAME && team.location === 'local')
    .map(discoverableTeamToWorker)
    .sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/api/workers', async () => {
  return { workers: await listDiscoverableWorkers() };
});

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
    const resolvedWorkerId = await resolveTeamSlugForMention(workerId);
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
    const fromTeam = typeof request.body?.fromTeam === 'string' ? request.body.fromTeam.trim() : '';
    const fromSessionKey =
      typeof request.body?.sessionKey === 'string' && request.body.sessionKey.trim().length > 0
        ? request.body.sessionKey.trim()
        : buildFallbackSessionKey(fromTeam || SYSTEM_MANAGER_TEAM_NAME);

    const { bindProject } = await ensureLoopSessionProjectReady(resolvedWorkerId);
    const sessionKey = `${buildFallbackSessionKey(resolvedWorkerId)}:${Date.now().toString(36)}`;
    const sessions = reuse ? await cc.listSessions(bindProject).catch(() => []) : [];
    let session = reuse
      ? sessions.find((item) => item.name === sessionName && (item.live || item.active))
      : undefined;
    const reused = Boolean(session);
    if (!session) {
      const created = await cc.createSession(bindProject, sessionName, sessionKey);
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

    await sendHarnessMessageViaBridge({
      teamName: resolvedWorkerId,
      text: message,
      sessionKey: session.session_key,
    });
    if (fromTeam) {
      await svc.appendMessage(fromTeam, {
        from: `${fromTeam}.user`,
        to: resolvedWorkerId,
        role: 'user',
        content: `@${resolvedWorkerId} ${message}`,
        meta: { source: CROSS_TEAM_SENT_SOURCE, sessionKey: fromSessionKey, summary },
      });
      broadcastSse('team-change', { type: 'inbox', teamName: fromTeam });
    }
    broadcastSse('team-change', { type: 'inbox', teamName: resolvedWorkerId });
    return {
      ok: true,
      worker,
      session: mapHermitBridgeSessionListItem(session, resolvedWorkerId),
      reused,
      messageSent: true,
    };
  } catch (err) {
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
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
      pi: {
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
      pi: {
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

app.get<{ Params: { name: string; memberName: string } }>(
  '/api/teams/:name/review/agent-changes/:memberName',
  async (request) => ({
    teamName: request.params.name,
    memberName: request.params.memberName,
    files: [],
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalFiles: 0,
    computedAt: new Date().toISOString(),
  })
);
app.get<{ Params: { name: string; taskId: string } }>(
  '/api/teams/:name/review/task-changes/:taskId',
  async () => ({ changes: [] })
);
app.get<{ Params: { name: string; memberName: string } }>(
  '/api/teams/:name/review/change-stats/:memberName',
  async () => ({ stats: {} })
);
app.get<{ Params: { name: string } }>('/api/teams/:name/review/file-content', async () => ({
  content: '',
}));
app.post<{ Params: { name: string } }>('/api/teams/:name/review/apply-decisions', async () => ({
  ok: true,
}));
app.post('/api/teams/review/check-conflict', async () => ({ conflict: false }));
app.post('/api/teams/review/preview-reject', async () => ({ preview: '' }));
app.post('/api/teams/review/save-edited-file', async () => ({ ok: true }));
app.post('/api/teams/review/decisions/load', async () => ({ decisions: {} }));
app.post('/api/teams/review/decisions/save', async () => ({ ok: true }));
app.post('/api/teams/review/decisions/clear', async () => ({ ok: true }));
app.get('/api/teams/review/git-file-log', async () => ({ log: [] }));

// ===========================================================================
// SSE 推送端点 — 前端 EventSource 连接此处接收实时事件
// ===========================================================================

app.get('/api/events', (request, reply) => {
  try {
    assertTrustedBrowserOrigin(request);
  } catch (err) {
    reply.code(403).send({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client: SseClient = {
    res: reply.raw,
    id: `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  };
  sseClients.add(client);

  // 握手
  reply.raw.write(`event: hello\ndata: {"ok":true}\n\n`);

  // keep-alive
  const ka = setInterval(() => {
    try {
      reply.raw.write(': keep-alive\n\n');
    } catch {
      clearInterval(ka);
      sseClients.delete(client);
    }
  }, 15_000);

  request.raw.on('close', () => {
    clearInterval(ka);
    sseClients.delete(client);
  });

  return reply.hijack();
});

const SSE_FALLBACK_RE = /^\/api\/(.*\/(events|stream|notifications\/stream))$/;

// ── Extension Store routes (wired to extensionHandlers) ────────────────

import {
  extensionHandlers as ext,
  getCapabilityPacks,
  setCapabilityPackLocalSource,
  setSkillsWatcherEmitter,
} from './ipc/extensions';

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

app.setNotFoundHandler((request, reply) => {
  const u = request.url;
  if (!u.startsWith('/api/')) {
    const pathname = u.split('?')[0] ?? '/';
    const hasFileExtension = /\.[^/]+$/.test(pathname);
    const indexPath = path.join(STATIC_DIR, 'index.html');
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      !hasFileExtension &&
      _existsSync2(indexPath)
    ) {
      return reply.type('text/html; charset=utf-8').send(readFileSync(indexPath, 'utf-8'));
    }
    return reply.code(404).type('text/plain').send('not found');
  }

  if (request.method === 'GET' && SSE_FALLBACK_RE.test(u)) {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: hello\ndata: {"ok":true}\n\n`);
    const ka = setInterval(() => {
      try {
        reply.raw.write(': keep-alive\n\n');
      } catch {
        clearInterval(ka);
      }
    }, 15000);
    request.raw.on('close', () => clearInterval(ka));
    return reply.hijack();
  }

  if (request.method === 'GET') return [];
  return { ok: true };
});

// ===========================================================================
// Static resources(vite build 产物)— 必须最后注册,放在 setNotFoundHandler 之后
// ===========================================================================

import { existsSync } from 'node:fs';
if (existsSync(STATIC_DIR)) {
  await app.register(staticPlugin, {
    root: STATIC_DIR,
    prefix: '/',
    decorateReply: false,
  });
} else {
  app.get('/', async (request, reply) => {
    if (request.url.startsWith('/api/')) return;
    reply
      .code(503)
      .type('text/plain')
      .send(`UI not built. Run: pnpm build:web (output → ${STATIC_DIR})`);
  });
}

// ===========================================================================
// Helpers
// ===========================================================================

function reply500(err: unknown) {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

// ===========================================================================
// Start
// ===========================================================================

bridgeLauncher
  .ensureBinaryReady({
    configPath: HERMIT_BRIDGE_CONFIG_FILE,
    extraArgs: ['--force'],
  })
  .then((cmd) => {
    markBridgeBinaryCheck({ status: 'ok', cmd: cmd.cmd });
  })
  .catch((err) => {
    markBridgeBinaryCheck({
      status: 'degraded',
      reason: err instanceof Error ? err.message : String(err),
      remediation: [
        '在终端运行: npm install -g cc-connect',
        '或设置环境变量 CC_CONNECT_MIRROR 指向可用的 GitHub release 代理（如 https://gh-proxy.com/）',
        '安装完成后重启 AgentCli 工作台',
      ],
    });
  });

// Ensure hermit-bridge is running for Hermit to connect to. A no-op when the
// management API already responds (an externally-managed hermit-bridge is left
// untouched); otherwise launches the bundled sidecar. Fire-and-forget: a slow or
// failed launch must NEVER block app.listen() — otherwise a missing sidecar
// stalls /api/version for up to HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS (180s
// default) and the workbench reports "启动失败" on cold boot. The bridge connects
// in the background via its own retry loop (bridge.start() below).
//
// NOTE on fail-fast: the cc-connect BINARY being ready is a hard prerequisite —
// without it every team-config save surfaces as a cryptic "fetch failed". We
// guarantee the binary (via the self-heal downloader in HermitBridgeLauncher's
// ensureRunning) BEFORE app.listen(), so a missing binary is surfaced as a
// clear startup error instead of a silently broken workbench.
bridgeLauncher
  .ensureRunning({
    client: cc,
    configPath: HERMIT_BRIDGE_CONFIG_FILE,
    extraArgs: ['--force'],
    logFile: path.join(HERMIT_HOME, 'cc-connect', 'cc-connect.log'),
    timeoutMs: HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS,
  })
  .then((r) => {
    if (r.launched) {
      app.log.info({ pid: r.pid }, 'launched hermit-bridge sidecar');
      markBridgeLaunch({ status: 'running', pid: r.pid });
    } else {
      app.log.info('hermit-bridge already running — skipping auto-launch');
      markBridgeLaunch({ status: 'running' });
    }
  })
  .catch((err) => {
    app.log.warn({ err }, 'hermit-bridge auto-launch skipped');
    markBridgeLaunch({
      status: 'offline',
      reason: err instanceof Error ? err.message : String(err),
    });
  });
// 启动 hermit-bridge WebSocket 连接(注册 platform=hermit adapter)
bridge.start();
imLiveWatcher.start();
await initializeTelemetryFromSettings();
await ensureGlobalWorkflows();

try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info(
    `hermit-bridge:        ${process.env.HERMIT_BRIDGE_BASE_URL ?? process.env.CC_CONNECT_BASE_URL ?? 'http://127.0.0.1:9820'}`
  );
  app.log.info(
    `bridge:               ${process.env.HERMIT_BRIDGE_WS_URL ?? process.env.CC_CONNECT_BRIDGE_URL ?? 'ws://127.0.0.1:9810/bridge/ws'}`
  );
  app.log.info(`static:               ${STATIC_DIR}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// graceful shutdown
const shutdown = async () => {
  try {
    imLiveWatcher.stop();
    directCliManager.shutdown();
    bridgeLauncher.stop();
    bridge.dispose?.();
    // Bound app.close() so a stuck SSE/websocket client can't hold the process
    // alive forever on SIGINT/SIGTERM (which would otherwise need kill -9 and
    // leak orphan claude subprocesses that the sync exit hook can't reap).
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
    process.exit(0);
  } catch {
    process.exit(1);
  }
};
// Last-resort safety net: log unhandled rejections instead of letting them
// kill the process (Node 16+ default). Without this, any fire-and-forget async
// (telemetry interval, redis message handler, …) that rejects on a transient
// IO error would crash the whole server. Concrete call sites still get their
// own .catch; this is the catch-all backstop.
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'unhandledRejection (logged, not crashing)');
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Sync backstop: reap direct-CLI subprocesses on any exit path that skips the async
// shutdown (e.g. process killed without a delivered signal). child.kill() is synchronous.
process.on('exit', () => directCliManager.shutdown());
