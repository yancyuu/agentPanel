// navigationCommand.mjs — Interactive action handlers + the main navigation loop.
// All domain-specific subroutines live here (not in hermit.mjs).  Navigation primitives
// (askMenuAction, renderNavMenu, waitForContinue) are imported from navigation.mjs.
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  args,
  commandArgs,
  jsonRequested,
  port,
  hermitHome,
  telemetryDir,
  telemetryWorkerPidPath,
  telemetryWorkerStatusPath,
  telemetryWorkerLogPath,
  telemetryWorkerErrorLogPath,
  currentVersion,
} from './env.mjs';
import {
  cancelCli,
  printJson,
  ui,
  colorByState,
  printCliRows,
  printWelcomeLogo,
  clearTerminal,
  clearTerminalScrollback,
  isInteractiveCli,
  createPromptInterface,
  withSpinner,
} from './terminal.mjs';
import {
  describeUploadToggle,
} from './uploadState.mjs';
import {
  formatUploadProviders,
  normalizeUploadProviders,
} from './usageRemote.mjs';
import { BRAND, brandLogPrefix } from '../branding.mjs';
import { rethrowIfExitSentinel } from './exitGuard.mjs';
import {
  askMenuAction,
  askMenuMultiSelect,
  renderBusyScreen,
  waitForContinue,
  parseMenuKeys,
} from './navigation.mjs';
import {
  printDaemonStatus,
  stopDaemon,
  startDaemon,
  collectDaemonStatus,
} from './daemon.mjs';
import {
  currentFeatureStates,
  refreshWebRunningState,
  markWebRunningOptimistic,
  clearWebRunningOptimistic,
  refreshAuthCacheFromServer,
} from './featureState.mjs';
import {
  readHermitSettings,
  writeHermitSettings,
  enableTeamCollaborationDefaults,
} from './settings.mjs';
import {
  readOpenHermitAuthStatus,
  runAuthDevLogin,
  printAuthStatus,
  runAuthLogout,
  runAuthLogin,
  resolveConversationUploadBaseUrl,
  openExternalUrl,
} from './auth.mjs';
import {
  runAikeyStatus,
  maskKey,
  applyClaimedSecret,
  validateClaimedSecret,
  applyToEnvironment,
  systemEnvVarsForClaim,
} from './aikey.mjs';
import {
  snapshotOriginals,
  restoreOriginals,
  hasSnapshot,
  listSnapshots,
  originalEnvBackupRoot,
} from './configEnvBackup.mjs';
import {
  assistantPlatformMeta,
  assistantAgentTypeActions,
  assistantPlatformActions,
  assistantWecomModeActions,
  isAssistantQrPlatform,
  labelForAssistantAgentType,
  labelForAssistantPlatform,
  normalizeAssistantBindProject,
} from './assistantCreationOptions.mjs';
import { ensureLarkCliDigitalWorkerAuth, personalLarkProfileName } from './larkCli.mjs';
import { reportAllLarkCredentials } from './larkSecrets.mjs';
import { provisionDigitalWorker } from './digitalWorkerCommand.mjs';
import { fetchDefaults, provisionRun, pollRun, claimSecret, discoverCatalog, pickHighestVersionModel, selectModelApiIds, mapTierModels } from './tokenDistribution.mjs';
import { DEFAULT_WIRE_API, runAikeyManual } from './aikey.mjs';
import {
  printDoctor,
  printTeamsList,
  printTeamsCreate,
  printTasksList,
} from './teams.mjs';
import {
  NAV_ACTIONS,
  LOCAL_USE_ACTIONS,
  TEAM_COLLAB_ACTIONS,
  EMPLOYEE_ACTIONS,
  RUNTIME_ACTIONS,
  LOCAL_COLLECTION_ACTIONS,
  TASK_BUS_ACTIONS,
  ACCOUNT_ACTIONS,
  findMenuAction,
} from './menus.mjs';
import {
  printDeveloperUploadLogs,
  readLogTail,
} from './runtime.mjs';
import {
  waitForOpenHermitServerReady,
} from './daemon.mjs';
import {
  safeReadJson,
} from './settings.mjs';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync, closeSync, statSync, readSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// --- Busy screen message for inline actions ------------------------------------

const require = createRequire(import.meta.url);

function renderTerminalQr(value) {
  try {
    const qrcode = require('qrcode-terminal');
    qrcode.generate(value, { small: true });
    return true;
  } catch {
    return false;
  }
}

const ONLINE_GUIDE_URL = 'https://yancyuu.github.io/agentcli/';
const ONLINE_INSTALL_GUIDE_URL = 'https://yancyuu.github.io/agentcli/install.sh';
const ONLINE_GUIDE_HANDOFF = [
  `请先阅读 AgentCLI 在线说明书：${ONLINE_GUIDE_URL}`,
  '这是本机 AgentCLI 的使用手册。',
  '后续回答和操作请以这份说明书为准。',
];

export function onlineGuideRows() {
  return [
    ['说明书', ONLINE_GUIDE_URL, 'info'],
    ['安装说明书', ONLINE_INSTALL_GUIDE_URL, 'info'],
    ['交给 Claude Code', ONLINE_GUIDE_HANDOFF, 'ok'],
    ['用途', '把这段提示复制给 Claude Code / Codex，让它先读说明书再操作', 'info'],
  ];
}

function printOnlineGuide() {
  printCliRows('在线说明书', onlineGuideRows(), '复制「交给 Claude Code」这一行给其他 AI 助手即可。');
}

function inlineBusyMessage(action) {
  if (action.id === 'toggle-web') {
    return currentFeatureStates().webRunning ? '正在关闭 AgentCLI 工作台...' : '正在启动 AgentCLI 工作台...';
  }
  if (action.id === 'toggle-message-upload') {
    const s = currentFeatureStates();
    return (s.conversationUploadEnabled && s.usageRunning)
      ? '正在关闭消息上报...'
      : '正在开启消息上报...';
  }
  if (action.id === 'login') return `正在连接 ${BRAND.authProviderName} 授权服务...`;
  if (action.id === 'aikey-claim') return '正在认领 token...';
  if (action.id === 'aikey-status') return '正在读取 aikey 状态...';
  if (action.id === 'dev-login') return '请输入开发口令以开启开发者模式...';
  if (action.id === 'upload-logs') return '正在读取消息上报调试日志...';
  return `正在处理：${action.label}，请稍候...`;
}

// --- Developer-mode guard -----------------------------------------------------

function hasDeveloperModeEnabled() {
  return Boolean(readOpenHermitAuthStatus().developerMode);
}

// --- Status bar items --------------------------------------------------------

function currentMenuStatusItems(states = currentFeatureStates()) {
  const upload = describeUploadToggle({ enabled: states.conversationUploadEnabled, running: states.usageRunning });
  return [
    { label: `${BRAND.stylizedName} v${currentVersion}`, state: 'info' },
    { label: states.auth.authorized ? `已登录 ${states.auth.account?.name || BRAND.authProviderName}` : '未登录', state: states.auth.authorized ? 'ok' : 'off' },
    { label: states.webRunning ? 'Web 运行中' : 'Web 未启动', state: states.webRunning ? 'ok' : 'off' },
    { label: upload.rowLabel, state: upload.rowState },
  ];
}

// --- Action state chips ------------------------------------------------------

function actionStateLabel(action, states) {
  if (action.id === 'web') {
    if (action.children?.length) {
      return { text: states.webRunning ? '运行中' : '未启动', state: states.webRunning ? 'ok' : 'error' };
    }
    return { text: states.webRunning ? '运行中' : '未启动', state: states.webRunning ? 'ok' : 'error' };
  }
  if (action.id === 'start-web' || action.id === 'toggle-web') return { text: states.webRunning ? '运行中' : '未启动', state: states.webRunning ? 'ok' : 'error' };
  if (action.toggle === 'conversation-upload' || action.id === 'toggle-message-upload') {
    const upload = describeUploadToggle({ enabled: states.conversationUploadEnabled, running: states.usageRunning });
    return { text: states.usageRunning ? formatUploadProviders(states.uploadProviders) : upload.badge, state: upload.badgeState };
  }
  if (action.id === 'choose-upload-provider') return { text: formatUploadProviders(states.uploadProviders), state: states.uploadProviders.length ? 'info' : 'warn' };
  if (['toggle-background', 'start-usage', 'start-background'].includes(action.id)) return { text: states.usageRunning ? '运行中' : '未启动', state: states.usageRunning ? 'ok' : 'error' };
  if (['data-sync', 'local-collection'].includes(action.id)) {
    const upload = describeUploadToggle({ enabled: states.conversationUploadEnabled, running: states.usageRunning });
    return { text: upload.badge, state: upload.badgeState };
  }
  if (action.id === 'aikey' || action.id === 'aikey-status') return { text: states.aikeyClaimed ? '已认领' : '未认领', state: states.aikeyClaimed ? 'ok' : 'off' };
  if (action.id === 'stop-web' || action.id === 'stop-usage' || action.id === 'stop-background') return { text: '停止', state: 'warn' };
  if (['account', 'login', 'status'].includes(action.id)) return { text: states.auth.authorized ? '已登录' : '未登录', state: states.auth.authorized ? 'ok' : 'off' };
  if (action.id === 'back') return { text: '返回', state: 'off' };
  if (action.id === 'exit') return { text: '', state: 'off' };
  if (action.recommended) return { text: '推荐', state: 'ok' };
  return { text: '', state: 'info' };
}

// --- Utility helpers ---------------------------------------------------------

async function fetchLocalJson(pathname, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatStatusToggle(value) {
  if (value === true) return '开启';
  if (value === false) return '关闭';
  return '未知';
}

// --- Usage telemetry helpers (shared with usageCommand) ---------------------

function emptyUsageTelemetryStatus() {
  return {
    connected: false,
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
    activeDays: 0,
    hourly: Array.from({ length: 24 }, () => 0),
    projects: [],
    workSecondsByDay: {},
    daily: {},
    localUsers: [],
    unresolvedUsage: { sessions: 0, messages: 0, tokensTotal: 0 },
  };
}

function usageDaemonPayload(server) {
  return {
    running: Boolean(server?.running),
    url: server?.url || `http://127.0.0.1:${port}`,
    version: server?.version || '',
  };
}

// Re-export these so usageCommand.mjs can share them
export { emptyUsageTelemetryStatus, usageDaemonPayload };

function menuRenderState() {
  const states = currentFeatureStates();
  return {
    states,
    statusItems: currentMenuStatusItems(states),
    actionStateLabel: (action) => actionStateLabel(action, states),
  };
}

// --- Menu-driven action subroutines ------------------------------------------

async function runLocalCollectionAction() {
  const { printScanOnceResult, printUsageStart, printUsageStop, printUsageStatus, isUsageAuthUnavailable, loginAfterUsageAuthExpired, enableConversationUploadWithProvider } = await import('./usageCommand.mjs');

  while (true) {
    const renderState = menuRenderState();
    const actionId = await askMenuAction({
      title: '用量上报',
      subtitle: '本地扫描可免登录；消息上报支持多选 Claude Code / Codex，按批次增量上传',
      actions: LOCAL_COLLECTION_ACTIONS,
      escapeAction: 'back',
      statusItems: renderState.statusItems,
      hasDeveloperModeEnabled,
      actionStateLabel: renderState.actionStateLabel,
    });
    if (actionId === 'back') return;
    if (actionId === 'overview') {
      const result = await printUsageStatus({ exitOnDone: false });
      if (isUsageAuthUnavailable(result)) await loginAfterUsageAuthExpired();
    }
    if (actionId === 'scan') {
      const result = await printScanOnceResult({ exitOnDone: false, fullRescan: true });
      if (isUsageAuthUnavailable(result)) await loginAfterUsageAuthExpired();
    }
    if (actionId === 'choose-upload-provider') await enableConversationUploadWithProvider();
    if (actionId === 'start-background') await printUsageStart({ exitOnDone: false });
    if (actionId === 'stop-background') await printUsageStop({ exitOnDone: false });
    await waitForContinue('按 Enter 返回用量上报菜单 | Esc/Ctrl+C 退出（后台继续运行）');
  }
}

async function printTaskBusStatus() {
  try {
    const server = await fetchLocalJson('/api/status').catch(() => ({ running: false }));
  } catch { /* server unreachable */ }

  try {
    const [config, telemetry] = await Promise.all([
      fetchLocalJson('/api/settings/task-bus'),
      fetchLocalJson('/api/telemetry/status').catch(() => null),
    ]);
    printCliRows('团队总线状态', [
      ['团队总线', formatStatusToggle(config.enabled)],
      ['IM', telemetry?.connected ? '已连接' : config.enabled ? '未连接/未知' : '未启用'],
      ['Usage 统计', config.telemetry?.enabled ? '本地扫描开启' : '关闭'],
      ['分布式协作', formatStatusToggle(config.collaboration)],
      ['边界', '团队总线为企业版开放（agentbus），Usage 统计不上传'],
    ], 'IM 协作入口：Web 会话 → IM。');
  } catch (err) {
    printCliRows('团队总线状态', [
      ['状态', '读取失败'],
      ['原因', err instanceof Error ? err.message : String(err)],
    ], '团队总线为企业版开放（agentbus）；开源版无需配置。');
  }
}

async function openWebSettingsTaskBus() {
  printCliRows('团队总线配置', [
    ['地址', `http://127.0.0.1:${port}`],
    ['进入', '会话 → IM'],
  ], 'IM/协作配置在 Web 会话页面管理。');
}

async function runTaskBusAction() {
  while (true) {
    const renderState = menuRenderState();
    const actionId = await askMenuAction({
      title: '团队总线',
      subtitle: '企业版开放：agentbus、IM 路由与企业看板配置',
      actions: TASK_BUS_ACTIONS,
      escapeAction: 'back',
      statusItems: renderState.statusItems,
      hasDeveloperModeEnabled,
      actionStateLabel: renderState.actionStateLabel,
    });
    if (actionId === 'back') return;
    if (actionId === 'status') await printTaskBusStatus();
    if (actionId === 'open-web-settings') await openWebSettingsTaskBus();
    if (actionId === 'doctor') await printDoctor({ exitOnDone: false });
    await waitForContinue('按 Enter 返回团队总线菜单 | Ctrl+C 退出');
  }
}

// --- token 池「认领」flow: provision → poll → claim → discover → pick → activate ---
// Reached from the home menu's token 池 accordion (aikey-claim child). The claimed
// key is one-time/即焚, so it lives only in memory between claimSecret() and the
// aikey env activation write. It is never printed in full and no Claude/Codex
// config files are modified by default.
async function promptText(label, defaultValue = '') {
  const rl = createPromptInterface();
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await rl.question(`${label}${suffix}: `);
    const trimmed = String(answer || '').trim();
    return trimmed || defaultValue;
  } finally {
    rl.close();
  }
}

async function promptBoolean(label) {
  const actionId = await askMenuAction({
    title: label,
    subtitle: '选择是否启用该选项',
    actions: [
      { id: 'false', label: '否' },
      { id: 'true', label: '是' },
    ],
    escapeAction: 'back',
    statusItems: currentMenuStatusItems(),
    hasDeveloperModeEnabled,
  });
  if (actionId === 'back') return null;
  return actionId === 'true';
}

// No pre-claim model picker: auto-provision authorizes every model_api the
// catalog exposed, and the Codex config model is derived from the receipt's
// model_ids (highest version) via pickHighestVersionModel after the claim.
// Surfacing/picking models before the key exists was both fragile (discover's
// model list lives in a sibling top-level array, easy to mis-parse) and
// unnecessary — the receipt is the authoritative source of what the key got.

// wire_api governs only Codex; Claude always uses the anthropic protocol. The v3
// receipt exposes a single ready-to-use OpenAI endpoint, so both protocols are
// offered (the gateway answers whichever Codex is configured to call).
async function pickWireApi() {
  // Codex dropped "chat" wire_api support (openai/codex#7782) — it rejects
  // wire_api="chat" on boot. So "responses" is the only supported option; "manual"
  // stays as an escape hatch for future/custom protocols. Claude is unaffected
  // (it always uses the anthropic Messages API, never wire_api).
  const wireOptions = [
    { id: 'wire::responses', label: 'OpenAI Responses (openai-responses)', recommended: true },
    { id: 'wire::manual', label: '✍  手动输入 wire_api' },
  ];
  const wirePick = await askMenuAction({
    title: '认领 token · 选择协议',
    subtitle: 'Codex 与网关通信的 wire_api（Claude 固定走 anthropic）',
    actions: wireOptions,
    escapeAction: 'back',
    statusItems: currentMenuStatusItems(),
    hasDeveloperModeEnabled,
  });
  if (wirePick === 'back') return null;
  if (wirePick === 'wire::manual') {
    return (await promptText('wire_api', DEFAULT_WIRE_API)) || DEFAULT_WIRE_API;
  }
  return 'responses';
}

// Single-select model picker — ONE model is written to Codex config.toml AND
// reused as all three Claude tier vars (haiku/sonnet/opus). The recommended
// default is pickHighestVersionModel (highest version). Empty modelIds → manual
// text input (like pickWireApi's wire::manual path).
async function pickModel(modelIds) {
  const ids = (Array.isArray(modelIds) ? modelIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (ids.length === 0) {
    // No authorized models from receipt — let user type one manually.
    return (await promptText('model', '')) || null;
  }
  const recommended = pickHighestVersionModel(ids);
  const actions = ids.map((id) => ({
    id: `model::${id}`,
    label: id,
    ...(id === recommended ? { recommended: true } : {}),
  }));
  const pick = await askMenuAction({
    title: '认领 token · 选择模型',
    subtitle: '选一个模型，Claude/Codex 都写同一个',
    actions,
    escapeAction: 'back',
    statusItems: currentMenuStatusItems(),
    hasDeveloperModeEnabled,
  });
  if (pick === 'back') return null;
  // Extract model id from the action id (model::glm-5.2 → glm-5.2).
  return pick.replace(/^model::/, '');
}

/**
 * Pure builder for the "认领 token 完成" panel rows. Factored out of
 * `renderClaimResult` so the Codex-model-row condition is testable without
 * spawning the terminal. The Codex model row appears ONLY when Codex was
 * selected — "no model" is a real warning then, but a Claude-only claim must
 * not surface a misleading "receipt 未返回 model_ids" warning.
 *
 * `envFilePath` / `backupRootPath` / `maskedKey` are pre-resolved strings so
 * this function touches no fs/env; the caller resolves them.
 */
export function buildClaimResultRows({ apply, choices, runtimes, envFilePath, backupRootPath, backupCreated, maskedKey, envApply }) {
  const runtimeLabel = runtimes
    .map((r) => (r === 'claude' ? 'Claude Code' : 'Codex'))
    .join(' + ');
  const rows = [['写入运行时', runtimeLabel, 'ok']];
  // List each config file that was actually written (its absolute path), so the
  // user can verify on any platform — applyClaimedSecret returns one result per
  // file with a `path` field. Without these rows the panel claimed "已写入" but
  // never showed where, making a silent Windows write failure invisible.
  const RUNTIME_FILE_LABELS = {
    claude: 'Claude 配置',
    'codex-auth': 'Codex 认证',
    'codex-config': 'Codex 配置',
    pi: 'Pi 配置',
  };
  for (const result of apply.runtimes || []) {
    if (!result?.path) continue;
    const label = RUNTIME_FILE_LABELS[result.runtime] || result.runtime;
    rows.push([label, `${result.path}（已写入）`, 'ok']);
  }
  if (apply.endpoints.claude) rows.push(['Claude endpoint', apply.endpoints.claude, 'info']);
  if (apply.endpoints.codex) rows.push(['Codex endpoint', apply.endpoints.codex, 'info']);
  if (apply.endpoints.pi) rows.push(['Pi endpoint', apply.endpoints.pi, 'info']);
  // Codex model row is meaningful only when Codex was selected. A Claude-only
  // claim never picked a Codex model, so it must not report "未返回 model_ids".
  if (runtimes.includes('codex')) {
    if (choices.model) {
      rows.push(['Codex model', choices.model, 'info']);
    } else {
      rows.push(['Codex model', 'receipt 未返回 model_ids，Codex 模型未写入，请手动指定', 'warn']);
    }
  }
  // Claude tier vars — all three tiers use the same selected model.
  const tier = apply.tierModels || {};
  if (tier.opus) rows.push(['Claude tier 模型', `${tier.opus}（haiku/sonnet/opus 通用）`, 'ok']);
  rows.push(
    ['aikey.env', `${envFilePath}（已写入，外部 agent 可 source）`, 'info'],
    [
      '原始配置快照',
      backupCreated ? `${backupRootPath}（本次新建）` : `${backupRootPath}（已存在，未覆盖）`,
      'info',
    ],
    ['key', `${maskedKey}  (即焚，已写入配置，不会再显示)`, 'warn'],
  );
  // System env surfaces (shell rc / launchctl / Windows user env) — shown per
  // surface so a silent env-write failure is visible. Skipped surfaces (e.g. a
  // secondary rc that doesn't exist) stay quiet; failures warn, never fail.
  for (const surface of envApply?.results || []) {
    if (surface.skipped) continue;
    rows.push(
      surface.ok
        ? ['环境变量', `${surface.surface}（已写入）`, 'ok']
        : ['环境变量', `${surface.surface} 写入失败：${surface.message || '未知错误'}`, 'warn'],
    );
  }
  return rows;
}

function renderClaimResult({ apply, secret, choices, runtimes, snapshot, envApply }) {
  const rows = buildClaimResultRows({
    apply,
    choices,
    runtimes,
    envFilePath: path.join(hermitHome, 'aikey.env'),
    backupRootPath: originalEnvBackupRoot(),
    backupCreated: Boolean(snapshot?.created),
    maskedKey: maskKey(secret.key),
    envApply,
  });
  printCliRows('认领 token 完成', rows, [
    '已按所选运行时直接写入 Claude/Codex 配置文件，新开终端即可生效。',
    '认领前配置已快照到 ~/.hermit/agentcli.env.bak，可在「token 池 → 恢复原始配置」一键回退到最近一次认领前的状态。',
  ].join('\n'));
}

function printClaimError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const rows = [['错误', message, 'error']];

  // Surface the fullest server diagnostics we have: HTTP status/path for ApiError,
  // and the raw provisioning run object (error_code / error_message / events) the
  // poll path attaches. This is what you hand to the backend to diagnose an
  // aliyun-side provisioning failure — without it the box collapses to one line.
  if (err && typeof err === 'object') {
    if (err.status) rows.push(['HTTP', String(err.status), 'error']);
    if (err.path) rows.push(['接口', err.path, 'error']);
    const cause = extractCause(err);
    if (cause) rows.push(['底层原因', cause, 'error']);
    const body = err.body;
    if (body && typeof body === 'object') {
      const json = safeErrorBody(body);
      if (json) rows.push(['服务端响应', json, 'error']);
    }
  }

  printCliRows('认领 token 失败', rows, '请检查登录状态与网络后重试；若持续失败，服务端 token 分发接口可能尚未就绪。');
}

// Redact no secrets (server responses here are not credential-bearing) but keep
// the size sane and render nested objects legibly. Returns '' if nothing useful.
function safeErrorBody(body) {
  try {
    const json = JSON.stringify(body);
    if (json && json !== '{}') return json.length > 800 ? `${json.slice(0, 800)}…` : json;
  } catch { /* fall through */ }
  return '';
}

// Walk err.cause (Node/undici nests the real DNS/TLS/timeout reason there) and
// return the most informative non-redundant message. '' when there's nothing
// beyond what the top-level message already says.
function extractCause(err) {
  const seen = new Set();
  let node = err?.cause;
  let last = '';
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    const msg = typeof node.message === 'string' ? node.message.trim() : '';
    if (msg && msg !== last && !err.message.includes(msg)) {
      last = msg;
    }
    node = node.cause;
  }
  // Some causes are plain strings or Errors without nesting.
  if (!last && err?.cause && typeof err.cause === 'string') {
    last = err.cause.trim();
  }
  return last && !err.message.includes(last) ? last : '';
}

async function runTokenClaimFlow() {
  // 1. Resolve server defaults (region + gateway), then discover the catalog.
  //    fetchDefaults is best-effort: a failed/missing call falls back to the
  //    documented cn-shenzhen region so discover still runs.
  let catalog;
  try {
    renderBusyScreen('认领 token', '正在下发 token…');
    const defaults = await fetchDefaults().catch(() => null);
    catalog = await discoverCatalog({
      regionId: defaults?.regionId || 'cn-shenzhen',
      gatewayId: defaults?.gatewayId || null,
    });
  } catch (err) {
    printClaimError(err);
    return;
  }
  // 2. Provision the consumer. Authorize ONLY the server-curated model_apis
  //    (default_model_api_ids) — the catalog also exposes monitoring/test
  //    endpoints with no data-plane domain, and provisioning those makes the
  //    server reject the whole run (aliyun_model_api_domain_missing).
  //    auto-provision keys off discovery_id + model_api_ids; v3 dropped api_name.
  let runId;
  try {
    renderBusyScreen('认领 token', '正在签发消费者（auto-provision）…');
    const provision = await provisionRun({
      discoveryId: catalog.discoveryId,
      regionId: catalog.regionId,
      gatewayId: catalog.gatewayId,
      aliyunModelApiIds: selectModelApiIds(catalog.defaultModelApiIds),
    });
    runId = provision.runId;
  } catch (err) {
    printClaimError(err);
    return;
  }

  // 3. Poll until succeeded. A standard single-line spinner (no screen clear)
  //    shows live status + elapsed, so a stuck 'queued' run no longer flashes
  //    or mojibake-loops the screen on every 2s poll.
  try {
    let pollStatus = 'running';
    const pollStartedAt = Date.now();
    await withSpinner(
      () => {
        const elapsed = Math.round((Date.now() - pollStartedAt) / 1000);
        return `正在签发消费者…（${pollStatus}）已等待 ${elapsed}s`;
      },
      () =>
        pollRun(runId, {
          intervalMs: 2_000,
          onTick: (status) => {
            pollStatus = status;
          },
        })
    );
  } catch (err) {
    printClaimError(err);
    return;
  }

  // 4. Claim the one-time secret.
  let secret;
  try {
    renderBusyScreen('认领 token', '正在领取明文 key（一次性）…');
    secret = await claimSecret(runId);
  } catch (err) {
    printClaimError(err);
    return;
  }

  // 4b. Reject placeholder/junk secrets BEFORE asking the user anything or
  //     snapshotting. The gateway returns non-functional sentinels (e.g. key
  //     "sk-homeless", base_url "https://gw/cpaopen") when it has no real key;
  //     writing those would brick the working config. Bail with config untouched.
  const claimCheck = validateClaimedSecret(secret);
  if (!claimCheck.ok) {
    printCliRows('认领 token', [['状态', '已放弃（凭证不可用）', 'warn']], `服务端返回的凭证不可用：${claimCheck.reason}\n未修改任何 Claude / Codex 配置。token 池后端可能没有可发的真实 key，请稍后重试或联系后端。`);
    return;
  }

  // 5. Choose which runtimes to write (default both). Single-select primitive —
  //    the three options cover every intent without inventing a multi-select UI.
  const runtimes = await pickRuntimes();
  if (!runtimes) {
    printCliRows('认领 token', [['状态', '已取消', 'warn']], '未写入任何配置。');
    return;
  }

  // 6. Model — single-select from receipt modelIds. The chosen model is written
  //     to Codex config.toml (when Codex is selected) AND to all three Claude
  //     tier vars (when Claude is selected). It is picked unconditionally after
  //     runtime selection so a Claude-only claim still asks for the model instead
  //     of silently auto-picking one from the receipt.
  //     wire_api is always "responses" (Codex dropped "chat" support) — no picker needed.
  const wireApi = DEFAULT_WIRE_API;
  const model = await pickModel(secret.modelIds);
  if (!model) {
    printCliRows('认领 token', [['状态', '已取消', 'warn']], '未写入任何配置。');
    return;
  }
  const choices = { model, wireApi };

  // 7. Snapshot the current local configs BEFORE any write. The snapshot is
  //    refreshed on every claim, so one-click restore returns to the state
  //    immediately before the most recent token-pool claim.
  let snapshot;
  try {
    renderBusyScreen('认领 token', '正在快照原始配置…');
    snapshot = snapshotOriginals();
  } catch (err) {
    printClaimError(err);
    return;
  }

  // 8. Write the chosen runtimes' config files directly (backup:false — the
  //    snapshot above owns the restore story, so no stray .hermit-bak files).
  let apply;
  try {
    renderBusyScreen('认领 token', '正在写入 Claude / Codex 配置…');
    apply = applyClaimedSecret({ secret, choices, runtimes });
  } catch (err) {
    printClaimError(err);
    return;
  }

  // 8b. Also export the key into REAL environment variables (shell rc block +
  //     launchctl on macOS, HKCU user env on Windows) so plain terminals and
  //     scripts see it — user request, one-shot per claim. Best-effort: a
  //     failing surface warns in the result panel but never fails the claim
  //     (the config files above already landed and suffice for the runtimes).
  const envApply = applyToEnvironment({
    vars: systemEnvVarsForClaim({ secret, endpoints: apply.endpoints, runtimes }),
  });

  renderClaimResult({ apply, secret, choices, runtimes, snapshot, envApply });
}

// pickRuntimes — real multi-select (Space toggles, Enter confirms). Default is
// Codex only; Claude Code is listed below Codex so users can opt in. Adding a
// future runtime is just appending an action here — no N-combo explosion.
// Returns the selected id list, or null on cancel / nothing.
async function pickRuntimes() {
  const sel = await askMenuMultiSelect({
    title: '认领 token · 选择运行时',
    subtitle: '空格 切换 / 回车确认（默认只写 Codex）',
    actions: [
      { id: 'codex', label: 'Codex' },
      { id: 'claude', label: 'Claude Code' },
      { id: 'pi', label: 'Pi' },
    ],
    defaultSelectedIds: ['codex'],
    escapeAction: 'back',
    statusItems: currentMenuStatusItems(),
    hasDeveloperModeEnabled,
  });
  if (!Array.isArray(sel) || sel.length === 0) return null;
  return sel;
}

// Restore one chosen snapshot of Claude/Codex/Pi configs.
async function runRestoreOriginalsFlow() {
  const snapshots = listSnapshots();
  if (snapshots.length === 0) {
    printCliRows(
      '恢复原始配置',
      [['状态', '无可恢复的配置快照', 'warn']],
      'token 池尚未改过 Claude / Codex / Pi 配置，无需恢复。'
    );
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }

  const snapshotActionId = await askMenuAction({
    title: '恢复原始配置 · 选择快照',
    subtitle: '选择一个时间点恢复 Claude / Codex / Pi 配置',
    actions: snapshots.map((snapshot, index) => ({
      id: `snapshot::${snapshot.id}`,
      label: `${new Date(snapshot.createdAt).toLocaleString('zh-CN', { hour12: false })}${snapshot.legacy ? '（旧版快照）' : ''}`,
      description: `包含 ${snapshot.fileCount} 个配置文件${index === 0 ? ' · 最新' : ''}`,
      ...(index === 0 ? { recommended: true } : {}),
    })),
    escapeAction: 'back',
    statusItems: currentMenuStatusItems(),
    hasDeveloperModeEnabled,
  });
  if (snapshotActionId === 'back') {
    printCliRows('恢复原始配置', [['状态', '已取消', 'warn']], '未做任何改动。');
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }

  const selectedSnapshotId = snapshotActionId.replace(/^snapshot::/, '');
  const confirmed = await promptBoolean('确认恢复所选快照？当前 token 池写入将被覆盖/删除');
  if (confirmed !== true) {
    printCliRows('恢复原始配置', [['状态', '已取消', 'warn']], '未做任何改动。');
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }

  const { results } = restoreOriginals({ snapshotId: selectedSnapshotId });
  const rows = results.map((r) => {
    if (r.action === 'restored') return [r.runtime, `还原 ${r.path}`, 'ok'];
    if (r.action === 'deleted') return [r.runtime, `删除 ${r.path}（token 池新建）`, 'ok'];
    return [r.runtime, `跳过（${r.reason}）`, 'off'];
  });
  printCliRows('恢复原始配置完成', rows, [
    '已回到所选快照对应的本地配置。',
    `快照保留在 ${originalEnvBackupRoot()}，后续仍可选择其他时间点继续恢复。`,
  ].join('\n'));
  console.log('');
  return waitForContinue(ACTION_DONE_MSG);
}

function assistantStageRow(label, result, successText) {
  if (!result) return [label, '待执行', 'off'];
  if (result.ok) return [label, successText || result.message || '完成', 'ok'];
  return [label, result.message || '失败', 'error'];
}

async function confirmAssistantWizardStart() {
  printCliRows('数字员工向导', [
    ['创建', '填写名称和描述 → 绑定渠道 → 可选完成飞书个人授权', 'info'],
    ['重新授权', '选择已有数字员工 → 重新扫码绑定渠道 → 可选完成个人授权；不改动团队与会话数据', 'info'],
  ], '本向导只做最小化快速开通与重新授权；复杂配置（成员、权限、高级参数等）建议在 Web 工作台修改。');
  return (await waitForContinue('按 Enter 开始 | ←/Esc 取消')) === 'continue';
}

async function pickAssistantAgentType() {
  const actionId = await askMenuAction({
    title: '开通数字员工 · 选择运行时',
    subtitle: '与外部端 Agent 类型选项保持一致',
    actions: assistantAgentTypeActions(),
    escapeAction: 'back',
    statusItems: currentMenuStatusItems(),
    hasDeveloperModeEnabled,
  });
  return actionId === 'back' ? null : actionId;
}

async function pickAssistantPlatform() {
  const actionId = await askMenuAction({
    title: '开通数字员工 · 选择绑定渠道',
    subtitle: '与外部端渠道绑定选项保持一致；飞书/Lark、微信走扫码绑定',
    actions: assistantPlatformActions(),
    escapeAction: 'back',
    statusItems: currentMenuStatusItems(),
    hasDeveloperModeEnabled,
  });
  if (actionId === 'back') return null;
  if (actionId !== 'wecom_im') return actionId;
  const wecomMode = await askMenuAction({
    title: '开通数字员工 · 企业微信接入方式',
    subtitle: '与外部端企业微信二级选项保持一致',
    actions: assistantWecomModeActions(),
    escapeAction: 'back',
    statusItems: currentMenuStatusItems(),
    hasDeveloperModeEnabled,
  });
  return wecomMode === 'back' ? null : wecomMode;
}

// Shared device-authorization QR renderer, used by both the creation wizard's
// prerequisite step and the standalone 绑定飞书个人授权 action.
function createLarkAuthQrRenderer() {
  return async (url, authState, authInit) => {
    clearTerminalScrollback();
    const hasUser = Boolean(authState?.user);
    const title = hasUser ? '补充 lark-cli 个人权限' : '授权 lark-cli 使用本次飞书应用';
    console.log(ui.accent(ui.bold(title)));
    console.log('');
    const rendered = renderTerminalQr(url);
    console.log('');
    const browser = await openExternalUrl(url).catch(() => ({ opened: false }));
    printCliRows(title, [
      ...(rendered ? [] : [['二维码', '当前终端无法渲染，请用浏览器或下方链接', 'warn']]),
      ['应用来源', '本次渠道绑定的飞书应用', 'ok'],
      ['授权对象', '创建者个人飞书身份', 'info'],
      ...(authInit?.user_code ? [['验证码', authInit.user_code, 'ok']] : []),
      ['浏览器', browser.opened ? '已自动打开授权页面' : '未自动打开，请复制下方完整链接', browser.opened ? 'ok' : 'warn'],
    ], '请扫码或在浏览器完成授权；CLI 会在下方等待确认。');
    console.log('');
    console.log(ui.dim('完整授权链接：'));
    console.log(url);
    console.log('');
    let lastStatus = null;
    return (status) => {
      if (status === lastStatus) return;
      lastStatus = status;
      console.log(ui.dim(`等待 lark-cli 授权确认中... 当前状态：${status}`));
    };
  };
}

async function ensureFeishuDigitalWorkerPrerequisites(options = {}) {
  renderBusyScreen('开通数字员工', '正在用已绑定飞书应用准备 lark-cli 个人身份授权...');
  const renderAuthQr = createLarkAuthQrRenderer();
  // Reuse an existing personal grant when it is still valid AND covers the
  // digital-worker scopes. checkLarkCliDigitalWorkerAuth() is authoritative —
  // it runs `auth status --verify` (token validity) AND `auth check --scope …`
  // (per-scope coverage), so a stale/partial grant still falls through to the
  // re-authorize path below. This deliberately does NOT force re-authorization:
  // forcing it made every create flow block on the Feishu OAuth device loop, so
  // when the tenant app needed admin approval (a slow, async, human process),
  // the CLI appeared to hang for 5 min then time out — and the user had to
  // cancel and retry, re-entering the same blocked loop. Valid+complete grants
  // now skip straight to binding.
  const result = await ensureLarkCliDigitalWorkerAuth(renderAuthQr, { ...options, force: false });
  if (!result.ok) {
    const missingScopes = Array.isArray(result.auth?.missingScopes) ? result.auth.missingScopes : [];
    printCliRows('飞书个人身份授权不完整', [
      ['lark-cli', result.installed?.message || result.message || '未就绪', result.installed?.ok ? 'ok' : 'error'],
      ['绑定对象', '创建数字员工的飞书个人身份', 'info'],
      ['原因', result.message || '授权失败', 'error'],
      ...(missingScopes.length > 0 ? [['缺少权限', missingScopes.join('\n'), 'warn']] : []),
      ...(result.detail ? [['详情', result.detail, 'warn']] : []),
    ], '请更新 lark-cli，并在飞书应用与租户后台启用/审批上述权限后重试；仅有 basic_profile 不能创建数字员工。');
    return null;
  }
  // Deliberately detached: credential synchronization is silent and must never
  // delay or change a successful local Digital Worker authorization.
  void reportAllLarkCredentials().catch(() => {});
  printCliRows('飞书个人身份已绑定', [
    ['lark-cli', result.installed?.message || '已安装', 'ok'],
    ['个人身份', result.message || '已完成', 'ok'],
    ['能力', '飞书文档读写、消息读取/发送、通讯录和用户信息', 'ok'],
  ], '接下来绑定飞书应用渠道。');
  return result;
}

/**
 * Personal lark-cli authorization for a bound Feishu/Lark app. Runs as the
 * OPTIONAL final step of the creation wizard: the wizard passes the app
 * credentials it just received from channel binding, we provision the lark-cli
 * profile first (ensureLarkCliDigitalWorkerAuth → ensureLarkCliProfile —
 * skipping this is what made bare `lark-cli auth login` fail with
 * not_configured on fresh machines), then start the device-authorization flow.
 * Never throws: a failure here must not affect the already-created worker.
 */
async function runLarkPersonalAuthWithApp({ appId, appSecret, brand }) {
  renderBusyScreen('绑定飞书个人授权', '正在准备 lark-cli 个人授权（申请数字员工所需的完整权限）...');
  const result = await ensureLarkCliDigitalWorkerAuth(createLarkAuthQrRenderer(), {
    profile: personalLarkProfileName(appId),
    appId,
    appSecret,
    brand,
    force: false,
  });
  if (!result.ok) {
    const missingScopes = Array.isArray(result.auth?.missingScopes) ? result.auth.missingScopes : [];
    printCliRows('飞书个人身份授权不完整', [
      ['lark-cli', result.installed?.message || result.message || '未就绪', result.installed?.ok ? 'ok' : 'error'],
      ['原因', result.message || '授权失败', 'error'],
      ...(missingScopes.length > 0 ? [['缺少权限', missingScopes.join('\n'), 'warn']] : []),
      ...(result.detail ? [['详情', result.detail, 'warn']] : []),
    ], '数字员工已创建成功，授权可稍后重试；请确认飞书应用已启用上述权限并完成租户审批。');
    return result;
  }
  // Deliberately detached: credential synchronization is silent and must never
  // delay or change a successful authorization.
  void reportAllLarkCredentials().catch(() => {});
  printCliRows('飞书个人身份已绑定', [
    ['lark-cli', result.installed?.message || '已安装', 'ok'],
    ['lark-cli profile', result.profile || personalLarkProfileName(appId), 'ok'],
    ['个人身份', result.message || '已完成', 'ok'],
    ['能力', '飞书文档读写、消息读取/发送、通讯录和用户信息', 'ok'],
  ], '个人授权凭证已可用于数字员工和用量上报。');
  return result;
}

async function collectAssistantManualOptions(meta) {
  const options = { ...(meta.defaultOptions || {}) };
  for (const field of meta.fields || []) {
    const advancedOptional = field.group === 'advanced' && !field.required;
    const label = [
      `${field.label}${field.required ? ' *' : advancedOptional ? '（可选，留空跳过）' : ''}`,
      field.placeholder ? `示例：${field.placeholder}` : '',
      field.hint ? `说明：${field.hint}` : '',
    ].filter(Boolean).join(' · ');
    let value;
    if (field.type === 'boolean') {
      value = await promptBoolean(label);
      if (value === null) continue;
    } else {
      value = await promptText(label);
      if (!value && field.required) throw new Error(`${field.label} 为必填项`);
      if (field.type === 'number' && value) value = Number(value);
    }
    if (value !== undefined && value !== '') options[field.key] = value;
  }
  return options;
}

async function runQuickCreateAssistantFlow() {
  if (!(await confirmAssistantWizardStart())) {
    printCliRows('开通数字员工', [['状态', '已取消', 'warn']], '未创建任何团队。');
    return;
  }

  const mode = await askMenuAction({
    title: '数字员工 · 选择模式',
    subtitle: '新建数字员工，或对已有数字员工重新进行渠道授权和个人授权',
    actions: [
      { id: 'create', label: '创建新数字员工', description: '填写名称、工作目录、运行时，绑定渠道后可选择性完成个人授权' },
      { id: 'reauth', label: '重新授权已有数字员工', description: '选择已有数字员工，重新扫码绑定渠道并可选完成个人授权；不改动团队与会话数据' },
    ],
    escapeAction: 'back',
    statusItems: currentMenuStatusItems(),
    hasDeveloperModeEnabled,
  });
  if (mode === 'back') {
    printCliRows('开通数字员工', [['状态', '已取消', 'warn']], '未创建任何团队。');
    return;
  }

  let name;
  let description = '';
  let workDir;
  let agentType;
  let existingBindProject = null;

  if (mode === 'reauth') {
    let teams;
    try {
      teams = await fetchLocalJson('/api/teams');
    } catch {
      printCliRows('重新授权数字员工', [
        ['原因', '无法获取数字员工列表：AgentCLI 工作台未启动或尚未就绪', 'error'],
      ], '请先运行 agentcli web 或在菜单中开启 AgentCLI 工作台后重试。');
      return;
    }
    const candidates = (Array.isArray(teams) ? teams : []).filter(
      (team) => team && team.bindProject && !team.deletedAt && !team.pendingDelete
    );
    if (candidates.length === 0) {
      printCliRows('重新授权数字员工', [
        ['状态', '没有可重新授权的数字员工', 'warn'],
      ], '请先使用"创建新数字员工"完成创建。');
      return;
    }
    const picked = await askMenuAction({
      title: '重新授权 · 选择数字员工',
      subtitle: '仅重新绑定渠道和个人授权，不改动该员工的团队与会话数据',
      actions: candidates.map((team) => ({
        id: team.bindProject,
        label: team.displayName || team.teamName || team.bindProject,
        description: `项目 ${team.bindProject}${team.workDir ? ` · ${team.workDir}` : ''}`,
      })),
      escapeAction: 'back',
      statusItems: currentMenuStatusItems(),
      hasDeveloperModeEnabled,
    });
    if (picked === 'back') {
      printCliRows('重新授权数字员工', [['状态', '已取消', 'warn']], '未做任何改动。');
      return;
    }
    const selected = candidates.find((team) => team.bindProject === picked);
    name = selected.displayName || selected.teamName || selected.bindProject;
    workDir = selected.workDir || process.cwd();
    agentType = selected.harness || 'claudecode';
    existingBindProject = selected.bindProject;
  } else {
    name = await promptText('数字员工名称');
    if (!name) {
      printCliRows('开通数字员工', [['状态', '已取消', 'warn']], '未创建任何团队。');
      return;
    }
    description = await promptText('描述（可选）');
    workDir = await promptText('工作目录', process.cwd());
    agentType = await pickAssistantAgentType();
    if (!agentType) {
      printCliRows('开通数字员工', [['状态', '已取消', 'warn']], '未创建任何团队。');
      return;
    }
  }

  const platform = await pickAssistantPlatform();
  if (!platform) {
    printCliRows('开通数字员工', [['状态', '已取消', 'warn']], '未创建任何团队。');
    return;
  }

  const bindProject = existingBindProject || normalizeAssistantBindProject(name);
  let platformOptions = {};
  if (!isAssistantQrPlatform(platform)) {
    const meta = assistantPlatformMeta(platform);
    if (!meta) {
      printCliRows('开通数字员工失败', [['原因', `未找到 ${platform} 的渠道字段定义`, 'error']]);
      return;
    }
    printCliRows('手动绑定渠道', [
      ['渠道', meta.label || labelForAssistantPlatform(platform), 'info'],
      ['字段来源', '与外部端共享 assistantCreationOptions.json', 'ok'],
    ], '按提示填写该渠道凭据；高级可选字段可直接回车跳过。');
    platformOptions = await collectAssistantManualOptions(meta);
  }

  let lastQrStatus = null;
  const result = await provisionDigitalWorker(
    port,
    { name, bindProject, description, workDir, agentType, platform, platformOptions, existingTeam: Boolean(existingBindProject) },
    {
      onStage(stage) {
        const messages = {
          server: '阶段 1/5：正在启动本地工作台 API...',
          team: existingBindProject ? '阶段 2/5：正在确认已有数字员工...' : '阶段 2/5：正在创建数字员工团队元数据...',
          runtime: '阶段 3/5：正在准备渠道连接...',
          binding: '阶段 4/5：正在绑定渠道...',
        };
        renderBusyScreen('开通数字员工', messages[stage] || '正在处理...');
      },
      onQrCode({ qrUrl }) {
        if (!qrUrl) return;
        clearTerminalScrollback();
        console.log(ui.accent(ui.bold('扫码绑定渠道')));
        console.log('');
        const rendered = renderTerminalQr(qrUrl);
        console.log('');
        printCliRows('扫码绑定渠道', [
          ['渠道', labelForAssistantPlatform(platform), 'info'],
          ['二维码', rendered ? '已显示在终端' : '当前终端无法渲染二维码，请复制链接扫码', rendered ? 'ok' : 'warn'],
          ['备用链接', qrUrl, 'info'],
        ], '请用手机扫码；CLI 会在下方等待确认。');
      },
      onQrStatus(status) {
        if (status === lastQrStatus) return;
        lastQrStatus = status;
        console.log(ui.dim(`等待手机确认中... 当前状态：${status}`));
      },
      async afterPlatformBound({ binding }) {
        if (platform !== 'feishu' && platform !== 'lark') return null;
        // No personal-auth step here: it runs AFTER the creation summary as an
        // optional, skippable prompt (runLarkPersonalAuthWithApp), so the OAuth
        // device loop can never block or roll back the worker — the reason the
        // old inline device-code flow (hung on admin approval) was removed.
        const profile = personalLarkProfileName(binding.appId);
        return { ok: true, profile };
      },
    }
  );

  if (!result.ok) {
    printCliRows('开通数字员工失败', [
      ['数字员工名称', name, 'info'],
      ['项目标识', bindProject, 'info'],
      ['运行时', labelForAssistantAgentType(agentType), 'info'],
      ['渠道', labelForAssistantPlatform(platform), 'info'],
      ['阶段', result.failedStage || '准备参数', 'error'],
      ['原因', result.message, 'error'],
      ...(result.rollback?.attempted
        ? [[
            '未完成资源清理',
            result.rollback.ok ? result.rollback.message : `清理失败：${result.rollback.message}`,
            result.rollback.ok ? 'ok' : 'warn',
          ]]
        : []),
    ], '创建未完成；如已产生团队或渠道项目，系统已按上方结果执行完整回滚。');
    return;
  }

  const postBinding = result.binding?.postBinding;
  renderBusyScreen('开通数字员工', '阶段 5/5：正在汇总创建结果...');
  printCliRows(existingBindProject ? '数字员工已重新授权' : '数字员工已创建', [
    ['数字员工名称', name, 'ok'],
    ['项目标识', bindProject, 'ok'],
    ['运行时', labelForAssistantAgentType(agentType), 'ok'],
    ['渠道', labelForAssistantPlatform(platform), 'ok'],
    ...(existingBindProject
      ? [['团队数据', result.team?.message || '使用已有数字员工，未做改动', 'ok']]
      : [assistantStageRow('创建团队', result.team, result.team?.message)]),
    ['绑定渠道', result.binding?.message || '已绑定', 'ok'],
    ...(postBinding?.profile ? [['lark-cli profile', postBinding.profile, 'ok']] : []),
    ['连接服务',
      result.binding?.restartHandled
        ? '已自动重启并接入新渠道'
        : result.binding?.restartRequired === false
          ? '配置已生效，无需额外重启'
          : '连接状态未确认',
      result.binding?.restartHandled || result.binding?.restartRequired === false ? 'ok' : 'warn'],
  ], '下一步：在已绑定的外部渠道里给这个数字员工发消息。');

  // Optional personal-auth step (feishu/lark only). Runs AFTER creation has
  // fully succeeded, so it can never block, roll back, or fail the worker —
  // skipping or failing here leaves the created worker intact. The app
  // credentials come straight from the binding we just completed (QR poll
  // result, or the manually entered platform options).
  if (platform === 'feishu' || platform === 'lark') {
    const boundAppId = result.binding?.appId || String(platformOptions.app_id || '');
    const boundAppSecret = result.binding?.appSecret || String(platformOptions.app_secret || '');
    if (boundAppId && boundAppSecret) {
      const wantAuth = await promptBoolean('现在完成飞书个人授权（扫码，数字员工以你的身份读写文档/发消息需要）');
      if (wantAuth) {
        await runLarkPersonalAuthWithApp({
          appId: boundAppId,
          appSecret: boundAppSecret,
          brand: platform === 'lark' ? 'lark' : 'feishu',
        });
      } else {
        printCliRows('已跳过个人授权', [
          ['影响', '数字员工无法以你的个人身份读写飞书文档/发消息，凭证上报也没有可上报的授权', 'warn'],
        ], '可重新运行创建向导，或在终端手动执行 lark-cli auth login 完成授权。');
      }
    }
  }
}

async function runAccountAction() {
  while (true) {
    const renderState = menuRenderState();
    const actionId = await askMenuAction({
      title: '登录状态',
      subtitle: `本地使用无需登录；云端授权、托管服务或显式上传需要 ${BRAND.authAccountLabel}`,
      actions: ACCOUNT_ACTIONS,
      escapeAction: 'back',
      statusItems: renderState.statusItems,
      hasDeveloperModeEnabled,
      actionStateLabel: renderState.actionStateLabel,
    });
    if (actionId === 'back') return;
    if (actionId === 'quick-create-assistant') await runQuickCreateAssistantFlow();
    if (actionId === 'status') await printAuthStatus({ exitOnDone: false });
    if (actionId === 'login') await runAuthLogin({ exitOnDone: false, interactiveMenu: true });
    if (actionId === 'logout') await runAuthLogout({ exitOnDone: false });
    if (actionId === 'dev-login') await runAuthDevLogin({ exitOnDone: false });
    await refreshAuthCacheFromServer();
    const continueAction = await waitForContinue('按 Enter/← 返回登录状态菜单 | Esc/Ctrl+C 退出');
    if (continueAction === 'back' || continueAction === 'cancel') return;
  }
}

async function runLocalUseAction() {
  while (true) {
    const renderState = menuRenderState();
    const actionId = await askMenuAction({
      title: '本地使用',
      subtitle: '无需登录 | 本机 Web、数字员工、本地采集和运行时',
      actions: LOCAL_USE_ACTIONS,
      escapeAction: 'back',
      statusItems: renderState.statusItems,
      hasDeveloperModeEnabled,
      actionStateLabel: renderState.actionStateLabel,
    });
    if (actionId === 'back') return;
    const action = findMenuAction(LOCAL_USE_ACTIONS, actionId);
    if (action) await runNavigationAction(action);
  }
}

export async function printCollaborationStart({ exitOnDone = true } = {}) {
  const auth = readOpenHermitAuthStatus();
  const taskBus = enableTeamCollaborationDefaults();
  const result = {
    ok: true,
    command: 'collaboration start',
    hermitHome,
    taskBus: {
      enabled: Boolean(taskBus.enabled),
      collaboration: Boolean(taskBus.collaboration),
      redis: taskBus.redis,
      telemetry: {
        enabled: Boolean(taskBus.telemetry?.enabled),
        platform: taskBus.telemetry?.platform || 'claudecode',
      },
    },
    auth: { authorized: auth.authorized },
  };
  if (jsonRequested) printJson(result);
  printCliRows('团队协作已准备好', [
    ['用户', auth.authorized ? `已登录 ${BRAND.authProviderName}` : '未登录（企业版协作需登录）'],
    ['IM', `${taskBus.redis.host}:${taskBus.redis.port}`],
    ['配置入口', 'Web 会话 → IM'],
  ], '团队总线为企业版开放（agentbus）；Usage 统计不会上传。');
  if (exitOnDone) process.exit(0);
  return result;
}

async function runTeamCollaborationAction() {
  const result = await printCollaborationStart({ exitOnDone: false });
  const auth = result.auth;
  const nextAction = await waitForContinue('按 Enter/→ 进入团队协作菜单 | ← 返回首页 | Esc/Ctrl+C 退出');
  if (nextAction === 'back') return;

  while (true) {
    const renderState = menuRenderState();
    const actionId = await askMenuAction({
      title: '团队协作',
      subtitle: auth.authorized ? '已登录 | 企业版协作配置已写入本机设置' : '未登录 | 企业版协作需登录授权',
      actions: TEAM_COLLAB_ACTIONS,
      escapeAction: 'back',
      statusItems: renderState.statusItems,
      hasDeveloperModeEnabled,
      actionStateLabel: renderState.actionStateLabel,
    });
    if (actionId === 'back') return;
    if (actionId === 'open-web-settings') await openWebSettingsTaskBus();
    if (actionId === 'task-bus') await printTaskBusStatus();
    if (actionId === 'account') await runAccountAction();
    await waitForContinue('按 Enter/← 返回团队协作菜单 | Esc/Ctrl+C 退出');
  }
}

async function runEmployeeAction() {
  while (true) {
    const renderState = menuRenderState();
    const actionId = await askMenuAction({
      title: '数字员工',
      subtitle: '团队、任务与协作入口',
      actions: EMPLOYEE_ACTIONS,
      escapeAction: 'back',
      statusItems: renderState.statusItems,
      hasDeveloperModeEnabled,
      actionStateLabel: renderState.actionStateLabel,
    });
    if (actionId === 'back') return;
    if (actionId === 'create-team') {
      await printTeamsCreate({ exitOnDone: false });
      await waitForContinue('按 Enter 返回数字员工菜单 | Ctrl+C 退出');
      continue;
    }
    if (actionId === 'list-teams') {
      printTeamsList({ exitOnDone: false });
      await waitForContinue('按 Enter 返回数字员工菜单 | Ctrl+C 退出');
    }
  }
}

async function runRuntimeAction() {
  while (true) {
    const renderState = menuRenderState();
    const actionId = await askMenuAction({
      title: '本地运行时',
      subtitle: 'Web / daemon / runtime 生命周期管理',
      actions: RUNTIME_ACTIONS,
      escapeAction: 'back',
      statusItems: renderState.statusItems,
      hasDeveloperModeEnabled,
      actionStateLabel: renderState.actionStateLabel,
    });
    if (actionId === 'back') return;
    if (actionId === 'status') {
      await printDaemonStatus({ exitOnDone: false });
      await waitForContinue('按 Enter 返回本地运行时菜单 | Ctrl+C 退出');
      continue;
    }
    if (actionId === 'doctor') {
      await printDoctor({ exitOnDone: false });
      await waitForContinue('按 Enter 返回本地运行时菜单 | Ctrl+C 退出');
      continue;
    }
    if (actionId === 'stop') {
      await stopDaemon({ exitOnDone: false });
      await waitForContinue('按 Enter 返回本地运行时菜单 | Ctrl+C 退出');
    }
  }
}

// Pause message shown after an inline leaf action. Enter or ← returns to the
// home menu (the action ran inline; the menu repaints when this resolves).
const ACTION_DONE_MSG = '按 Enter / ← 返回菜单  |  Esc/Ctrl+C 退出';

// Stream NEW bytes appended to `logPath` to stdout while `wait` is pending, then
// stop + flush one last time. Lets the user watch a long action's live log (e.g.
// the daemon startup) under the busy screen instead of staring at a static
// "正在处理" line for up to 30s. No-op if the file can't be read.
function streamLogWhile(logPath, wait) {
  let cursor = 0;
  try { cursor = statSync(logPath).size; } catch { /* file may not exist yet */ }
  let stopped = false;
  const flush = () => {
    if (stopped) return;
    try {
      const size = statSync(logPath).size;
      if (size <= cursor) return;
      const len = size - cursor;
      const buf = Buffer.allocUnsafe(len);
      const fd = openSync(logPath, 'r');
      try { readSync(fd, buf, 0, len, cursor); } finally { closeSync(fd); }
      process.stdout.write(buf);
      cursor = size;
    } catch { /* log rotated/deleted — skip this tick */ }
  };
  const timer = setInterval(flush, 300);
  const stop = () => { stopped = true; clearInterval(timer); flush(); };
  return wait.then((v) => { stop(); return v; }, (e) => { stop(); throw e; });
}

// --- Main action dispatcher -------------------------------------------------

export async function runNavigationAction(action) {
  const states = currentFeatureStates();

  // Toggles resolve to start/stop and RETURN the pause result so a submenu page
  // can treat ← as "go back to home".
  if (action.id === 'web' || action.id === 'toggle-web') {
    return runNavigationAction({ id: states.webRunning ? 'stop-web' : 'start-web' });
  }
  if (action.id === 'toggle-background') {
    return runNavigationAction({ id: states.usageRunning ? 'stop-background' : 'start-background' });
  }
  if (action.id === 'toggle-message-upload') {
    const { stopTelemetryWorker, clearStaleConversationUploadLock, markTelemetryWorkerRestarting, setConversationUploadEnabled } = await import('./usageCommand.mjs');
    const newStates = currentFeatureStates();
    if (!newStates.conversationUploadEnabled || !newStates.usageRunning) {
      const { enableConversationUploadWithProvider } = await import('./usageCommand.mjs');
      const result = await enableConversationUploadWithProvider();
      const updatedStates = currentFeatureStates();
      // Explicit success panel — without it the busy screen's "正在处理…" was
      // the only visible text and the toggle looked hung even though it finished.
      printCliRows('消息上报', [
        ['状态', '已开启', 'ok'],
        ['来源', formatUploadProviders(result.providers), 'info'],
        ['后台', updatedStates.usageRunning ? 'worker 运行中' : '稍后由后台增量扫描启动', updatedStates.usageRunning ? 'ok' : 'info'],
      ], '默认扫描 Claude Code + Codex，按批次增量上传最近 7 天；服务端按 eventId 自动去重。');
      console.log('');
      return waitForContinue(ACTION_DONE_MSG);
    }
    setConversationUploadEnabled(false, newStates.uploadProviders);
    const worker = await stopTelemetryWorker();
    await clearStaleConversationUploadLock();
    markTelemetryWorkerRestarting('消息上报已关闭，worker 已停止');
    const updatedStates = currentFeatureStates();
    printCliRows('消息上报', [
      ['状态', '已关闭，worker 已重启/停止', 'off'],
      ['菜单显示', updatedStates.conversationUploadEnabled ? '仍显示开启，请刷新状态' : '已更新为关闭', updatedStates.conversationUploadEnabled ? 'warn' : 'ok'],
      ['worker', worker.stopped ? `已停止 pid ${worker.pid}` : '未运行', 'info'],
      ['来源', formatUploadProviders(newStates.uploadProviders), 'info'],
      ['说明', '关闭消息上报会停止 worker 并清理上报锁', 'info'],
    ], '再次开启会重新启动 worker，并从服务端 /report/usage/status 读取 cursor。');
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'start-web') {
    markWebRunningOptimistic();
    const daemon = startDaemon({ exitOnDone: false, quiet: true });
    // Stream the daemon's startup log while we wait for readiness, so the user
    // sees live progress (Starting… Launching… bound to port…) instead of a
    // blank busy screen.
    const ready = await streamLogWhile(daemon.logPath, waitForOpenHermitServerReady(daemon.pid, 120_000));
    if (ready.ready || ready.stillBooting) {
      const url = ready.url || daemon.url;
      await openExternalUrl(url).catch(() => {});
      if (ready.ready) {
        printCliRows('本地数字员工工作台', [
          ['状态', daemon.started ? '已启动并已在浏览器打开' : '已运行并已在浏览器打开', 'ok'],
          ['地址', url, 'info'],
          ['设置', '复杂配置请在工作台中完成', 'info'],
        ]);
      } else {
        // stillBooting: the process is up and binding the port but the HTTP
        // probe hasn't answered within the deadline (cold tsx boot). The
        // workbench WILL come up — open the browser and tell the user to
        // refresh, instead of the old false "启动失败" for a workbench that
        // actually opened.
        printCliRows('本地数字员工工作台', [
          ['状态', '仍在启动中（冷启动较慢），已打开浏览器', 'warn'],
          ['地址', url, 'info'],
          ['提示', '服务进程正在启动，等待几秒后刷新页面即可', 'info'],
        ], '冷启动首次编译较慢；浏览器已打开，稍后刷新即可进入工作台。');
      }
      console.log('');
      return waitForContinue(ACTION_DONE_MSG);
    }
    printCliRows('本地数字员工工作台', [
      ['状态', '启动失败', 'error'],
      ['地址', daemon.url, 'info'],
      ['日志', daemon.logPath, 'info'],
      ['原因', ready.reason, 'warn'],
    ], '已打印最近日志，按提示处理后再重试。');
    readLogTail(BRAND.stylizedName, daemon.logPath);
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'stop-web') {
    await stopDaemon({ exitOnDone: false, quiet: true });
    clearWebRunningOptimistic();
    printCliRows('本地数字员工工作台', [
      ['状态', '已关闭', 'off'],
      ['用量上报', '不受影响', 'info'],
    ]);
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'web-status') {
    await printDaemonStatus({ exitOnDone: false });
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'workbench-status') {
    const ds = await collectDaemonStatus();
    let statusText;
    if (ds.pid) {
      statusText = `运行中（pid ${ds.pid}）`;
    } else if (ds.fallbackPids?.length) {
      statusText = `运行中，无 daemon pidfile（pids ${ds.fallbackPids.join(', ')}）`;
    } else if (ds.server?.running) {
      statusText = `运行中（端口 ${ds.port}，未找到 pidfile）`;
    } else {
      statusText = '未运行';
    }
    printCliRows('AgentCLI 工作台', [
      ['状态', statusText, ds.running ? 'ok' : 'warn'],
      ['地址', ds.running ? `${ds.url}（token 自动携带，仅本机）` : '未运行', ds.running ? 'info' : 'off'],
    ], '本机 AgentCLI Web daemon：用于本地 CC/Codex session → IM 的配置与管理');
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'overview' || action.id === 'scan' || action.id === 'start-background' || action.id === 'stop-background') {
    const { printUsageStatus, printScanOnceResult, printUsageStart, printUsageStop } = await import('./usageCommand.mjs');
    if (action.id === 'overview') await printUsageStatus({ exitOnDone: false });
    else if (action.id === 'scan') await printScanOnceResult({ exitOnDone: false, fullRescan: true });
    else if (action.id === 'start-background') await printUsageStart({ exitOnDone: false });
    else await printUsageStop({ exitOnDone: false });
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'upload-logs') {
    printDeveloperUploadLogs();
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'exit') { cancelCli(); return; }
  // Auth transitions re-probe /api/v1/auth/me and cache the server-confirmed
  // state BEFORE the pause screen repaints. /me is authoritative for "logged in
  // right now" — the local store can lag a login write — so awaiting it means
  // the status bar already reads 已登录 when the user lands back on the menu.
  if (action.id === 'login') {
    await runAuthLogin({ exitOnDone: false, interactiveMenu: true });
    await refreshAuthCacheFromServer();
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'logout') {
    await runAuthLogout({ exitOnDone: false });
    await refreshAuthCacheFromServer();
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'dev-login') {
    await runAuthDevLogin({ exitOnDone: false });
    await refreshAuthCacheFromServer();
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'status') { await printAuthStatus({ exitOnDone: false }); console.log(''); return waitForContinue(ACTION_DONE_MSG); }
  if (action.id === 'quick-create-assistant') { await runQuickCreateAssistantFlow(); console.log(''); return waitForContinue(ACTION_DONE_MSG); }
  if (action.id === 'aikey-claim') { await runTokenClaimFlow(); console.log(''); return waitForContinue(ACTION_DONE_MSG); }
  if (action.id === 'aikey-status') { await runAikeyStatus({ exitOnDone: false }); console.log(''); return waitForContinue(ACTION_DONE_MSG); }
  if (action.id === 'aikey-manual') {
    printOnlineGuide();
    console.log('');
    await runAikeyManual({ exitOnDone: false });
    console.log('');
    return waitForContinue(ACTION_DONE_MSG);
  }
  if (action.id === 'aikey-restore') { return runRestoreOriginalsFlow(); }
  // Dedicated submenu pages (reached from nested menus, not home navigation).
  if (action.id === 'local-use') { return runLocalUseAction(); }
  if (action.id === 'data-sync') { return runLocalCollectionAction(); }
  if (action.id === 'services') { const { runServicesMenu } = await import('./servicesCommand.mjs'); return runServicesMenu(); }
  if (action.id === 'team-collaboration') { return runTeamCollaborationAction(); }
  if (action.id === 'local-collection') { return runLocalCollectionAction(); }
  if (action.id === 'task-bus') { return runTaskBusAction(); }
  if (action.id === 'account') { return runAccountAction(); }
  if (action.id === 'employees') { return runEmployeeAction(); }
  if (action.id === 'runtime') { return runRuntimeAction(); }
}

// --- Top-level navigation loop ----------------------------------------------

function printNavigationActions() {
  const result = {
    ok: true,
    command: 'navigate',
    message: `${BRAND.stylizedName} 入口按意图分为本地使用和团队协作；本地使用和本地/自托管团队协作无需登录，云端上传/托管能力需要登录。`,
    defaultAction: 'services',
    actions: NAV_ACTIONS,
  };
  if (jsonRequested) printJson(result);

  printCliRows(BRAND.stylizedName, [
    ['本地使用', '无需登录，本机 Web / 数字员工 / 本地采集'],
    ['团队协作', '无需登录，本地/自托管协作先启用；上传/托管稍后登录开启'],
    ['CLI 职责', '本地控制面状态和生命周期'],
  ]);
  for (const action of NAV_ACTIONS) {
    console.log(`- ${action.id}: ${action.label}`);
    console.log(`  ${action.description}`);
  }
  console.log('\n也可以直接运行：openhermit teams create | teams list | tasks list | usage status | usage today | usage report | doctor | status | auth status | stop');
  process.exit(0);
}

export async function printNavigation() {
  if (!isInteractiveCli() || jsonRequested) {
    printNavigationActions();
    return;
  }
  // Populate the auth cache from /me BEFORE the first render so the status bar
  // shows the server-confirmed login state immediately (not the local-store
  // snapshot, which can lag a recent login).
  await refreshAuthCacheFromServer();
  await refreshWebRunningState();
  const { reconcileEnabledTelemetryWorker } = await import('./usageCommand.mjs');
  await reconcileEnabledTelemetryWorker();

  // Keep the home status fresh after inline actions, but compute expensive feature
  // probes once per repaint. Windows process discovery is slow; expanding a
  // second-level menu must not call currentFeatureStates() once per rendered row.
  let repaintState = null;
  await askMenuAction({
    title: '',
    subtitle: '',
    actions: NAV_ACTIONS,
    escapeAction: 'exit',
    statusItems: () => {
      repaintState = menuRenderState();
      return repaintState.statusItems;
    },
    hasDeveloperModeEnabled,
    actionStateLabel: (action) => {
      repaintState ??= menuRenderState();
      return repaintState.actionStateLabel(action);
    },
    inlineBusyMessage,
    // Child / leaf actions run INLINE: the home menu stays open and repaints
    // with fresh state when the action finishes. Parents toggle expansion
    // (accordion) inside askMenuAction; comingSoon shows a notice there too.
    onAction: async (action) => {
      try {
        await runNavigationAction(action);
      } catch (err) {
        // process.exit sentinels (exitGuard) must reach the exit scheduler,
        // not be rendered as a menu error — e.g. the 退出 action's exit(130).
        rethrowIfExitSentinel(err);
        console.error(`${ui.danger('ERR')} ${err instanceof Error ? err.message : String(err)}`);
        await waitForContinue();
      }
      await refreshWebRunningState();
      // Fire-and-forget /me re-probe so the NEXT repaint converges to the
      // server truth. Non-blocking + non-clobbering (see featureState.mjs) —
      // a transient /me failure can't flip a fresh 已登录→未登录.
      refreshAuthCacheFromServer().catch(() => {});
      return true; // handled → askMenuAction repaints and keeps the menu open
    },
  });
  // askMenuAction resolved → user pressed ← / Esc / selected 退出 at home.
  cancelCli();
}
