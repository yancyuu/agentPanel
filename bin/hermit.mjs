#!/usr/bin/env node
/**
 * AgentCLI - production entry point (legacy filename retained for compatibility).
 *
 * Usage:
 *   npm install -g @yancyyu/agentcli
 *   agentcli                # open terminal navigation
 *   agentcli --daemon       # start Web UI on default port 5680
 *   agentcli --version      # show version
 *   agentcli update         # check and install updates
 *   agentcli restart        # restart web + usage worker on current code (after update)
 *
 * Or without global install:
 *   npx @yancyyu/agentcli
 *   npx @yancyyu/agentcli --port 8080
 */

// Windows spawn sites historically pass { shell: true } to execute .cmd shims,
// which makes Node print DEP0190 ("args with shell:true") plus other runtime
// deprecation noise (e.g. fastify FSTDEP023) into the interactive CLI. None of
// them are actionable for end users — suppress them at the entry point.
process.noDeprecation = true;

import { installProcessExitGuard } from './lib/exitGuard.mjs';

// Node 24 Windows libuv abort on process.exit with idle undici keep-alive
// connections — see lib/exitGuard.mjs. Must run before any command dispatch.
installProcessExitGuard();

import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BRAND, brandCommand, brandLogPrefix } from './branding.mjs';
import {
  args,
  commandArgs,
  jsonRequested,
  currentVersion,
  pkg,
  repoRoot,
  binDir,
  require,
  port,
  skipHermitBridge,
  hermitHome,
  daemonRequested,
  daemonChild,
  daemonPidPath,
  daemonLogPath,
  runtimeLogPath,
  serverLogPath,
  hermitSettingsPath,
  telemetryDir,
  telemetryWorkerPidPath,
  telemetryWorkerStatusPath,
  telemetryWorkerLogPath,
  telemetryWorkerErrorLogPath,
  conversationUploadLogPath,
  legacyRuntimeBridgeDir,
  ccConnectDir,
  legacyRuntimeBridgeConfigPath,
  defaultCcConnectConfigPath,
  legacyRuntimeBridgeDataDir,
  defaultCcConnectDataDir,
  hermitBridgeConfigPath,
  starterProjectName,
  findOptionValue,
  findOptionValues,
  findAnyOptionValues,
  findAnyOptionValue,
} from './lib/env.mjs';
import {
  cancelCli,
  printJson,
  ansi,
  ui,
  glyphs,
  useUnicodeUi,
  isInteractiveCli,
  createPromptInterface,
  askText,
  askRequired,
  askChoice,
  charDisplayWidth,
  stripAnsi,
  displayWidth,
  fitDisplay,
  truncateDisplay,
  statusDot,
  rowStatusDot,
  formatStatusPill,
  colorByState,
  rowStateFromValue,
  printStatusBar,
  boxLine,
  boxContentLine,
  boxColumnsLine,
  menuColumnsLine,
  panelWidth,
  printCliRows,
  menuBrandTitle,
  navHeaderLine,
  printWelcomeLogo,
  clearTerminal,
} from './lib/terminal.mjs';
import {
  checkDependency,
  escapeTomlPath,
  parseTomlToken,
  randomToken,
  escapeRegExp,
  findProjectBlock,
  isManagedBootstrapBlock,
  isStarterProjectConfig,
  configRequiresClaudeCode,
  hasProjectEntries,
  commandExists,
  ensureClaudeCodeCliIfNeeded,
  ensureCcConnectBinary,
  hasTomlSection,
  buildOpenHermitStarterConfig,
  normalizeMigratedHermitBridgeConfig,
  migrateLegacyHermitBridgeDataIfNeeded,
  normalizeHermitBridgeConfigFileIfNeeded,
  migrateLegacyHermitBridgeConfigIfNeeded,
  ensureOpenHermitRuntimeConfig,
  readHermitBridgeConfigState,
  waitForHermitBridge,
  appendLog,
  printLogTail,
  readLogTail,
  printDeveloperUploadLogs,
  waitForRuntimeReady,
  resolveHermitBridgeRunner,
  resolveTsxLoader,
  resolveAliasLoaderRegister,
  checkExistingOpenHermitServer,
  isTcpPortAvailable,
  assertWebPortAvailable,
} from './lib/runtime.mjs';
import { runUpdate, runAddPlugin } from './lib/update.mjs';
import { runRestart } from './lib/restart.mjs';
import { telemetryWorkerChildArgs } from './lib/telemetryWorker.mjs';
import { runAikey, runAikeyStatus, runAikeyManual } from './lib/aikey.mjs';
import {
  printNavigation,
  runNavigationAction,
  printCollaborationStart,
} from './lib/navigationCommand.mjs';
import {
  printUsageStatus,
  printUsageToday,
  printUsageReport,
  printUsageStart,
  printUsageStop,
  printUsageAutostart,
  printScanOnceResult,
  restartUsageWorkerIfRunning,
} from './lib/usageCommand.mjs';
import {
  printServicesCommand,
  printServicesStatus,
  runServiceAction,
} from './lib/servicesCommand.mjs';
import { describeUploadToggle, resolveConversationUploadEnabled } from './lib/uploadState.mjs';
import {
  createDigitalWorkerCommand,
  buildDigitalWorkerCommandOptions,
} from './lib/digitalWorkerCommand.mjs';
import { createFeishuAssistant, listFeishuAssistants } from './lib/feishuAssistant.mjs';
import {
  USAGE_UPLOAD_PROVIDER_OPTIONS,
  fetchAuthoritativeUsage,
  fetchRemoteUsageStatus,
  formatUploadProviders,
  normalizeUploadProviders,
  uploadProviderLabel,
} from './lib/usageRemote.mjs';
import {
  cursorPendingRows,
  formatNumber,
  localServerRows,
  serverUsageUnauthorized,
} from './lib/usageRows.mjs';
import {
  absoluteProgressLabel,
  aggregateUploadProgress,
  foldFinishedBatches,
  uploadProgressLabel,
} from './lib/usageProgress.mjs';
import {
  NAV_ACTIONS,
  WEB_ENTRY_ACTIONS,
  SERVICE_ACTIONS,
  LOCAL_USE_ACTIONS,
  TEAM_COLLAB_ACTIONS,
  EMPLOYEE_ACTIONS,
  RUNTIME_ACTIONS,
  LOCAL_COLLECTION_ACTIONS,
  TASK_BUS_ACTIONS,
  ACCOUNT_ACTIONS,
  findMenuAction,
  menuFooterForEscape,
} from './lib/menus.mjs';
import { installLarkCli } from './lib/larkCli.mjs';
import {
  readPidFile,
  readDaemonPid,
  refreshDaemonPidFromReadyServer,
  isPidRunning,
  removeDaemonPidFile,
  signalDaemon,
  listProcessesWin,
  collectFallbackPids,
  collectOrphanedDaemonChildPids,
  stopFallbackProcesses,
  collectDaemonStatus,
  printDaemonStatus,
  stopDaemon,
  waitForOpenHermitServerReady,
  startDaemon,
} from './lib/daemon.mjs';
import {
  currentFeatureStates,
  readAikeyClaimed,
  refreshWebRunningState,
  markWebRunningOptimistic,
  clearWebRunningOptimistic,
  invalidateAuthCache,
} from './lib/featureState.mjs';
import {
  chmodBestEffort,
  safeReadJson,
  readHermitSettings,
  writeHermitSettings,
  buildTeamCollaborationTaskBusConfig,
  enableTeamCollaborationDefaults,
} from './lib/settings.mjs';
import {
  getAuthStorePath,
  ensureAuthStoreDir,
  normalizeExpiry,
  readOpenHermitAuthStore,
  isAuthTokenExpired,
  authStatusFromStore,
  normalizeScopes,
  normalizeAccessTokenPayload,
  mergeAuthToken,
  readOpenHermitAuthStatus,
  writeOpenHermitAuthStore,
  deleteOpenHermitAuthStore,
  getOAuthConfig,
  hasRawOAuthConfig,
  normalizeControlUrl,
  resolveConversationUploadBaseUrl,
  isSourceCheckout,
  getDefaultDeviceAuthBaseUrl,
  getDeviceAuthConfig,
  assertOAuthConfigured,
  base64Url,
  randomOAuthValue,
  buildCodeChallenge,
  buildAuthorizationUrl,
  openExternalUrl,
  escapeHtml,
  buildAuthCallbackHtml,
  startOAuthCallbackServer,
  exchangeAuthorizationCode,
  fetchOAuthUserInfo,
  buildAuthStoreFromToken,
  performRawOAuthLogin,
  startDeviceAuthSession,
  normalizeHermitAuthIdentity,
  waitForAuthPollInterval,
  pollDeviceAuthToken,
  performDeviceAuthLogin,
  performOpenHermitLogin,
  refreshExpiredOpenHermitToken,
  refreshOpenHermitAuthStatus,
  authStatusPayload,
  failAuthRequired,
  requireOpenHermitAuthForCommand,
  isAuthCommandAllowedWithoutLogin,
  isLocalCommandAllowedWithoutLogin,
  requireOpenHermitAuthForEntry,
  parseAuthLoginOptions,
  buildDevAuthStore,
  promptDevUnlockCode,
  runAuthDevLogin,
  printAuthStatus,
  runAuthLogout,
  runAuthLogin,
  AUTH_CALLBACK_PATH,
  AUTH_STORE_SCHEMA_VERSION,
  OPENHERMIT_AUTH_BROKER_URL,
  OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL,
  DEV_AUTH_UNLOCK_CODE,
} from './lib/auth.mjs';
import { printTasksCommand } from './lib/tasks.mjs';
import {
  listDirectoryNames,
  isSafeTeamArg,
  isValidBindProject,
  normalizeWorkDir,
  generateBindProject,
  isHiddenTeam,
  collectTeams,
  resolveTeamSlug,
  mapTaskStatus,
  collectTasks,
  printDoctor,
  printTeamsList,
  buildTeamCreateSeed,
  promptForMissingTeamCreateFields,
  failTeamCreate,
  createLocalTeam,
  printTeamsCreate,
} from './lib/teams.mjs';

// Windows console UTF-8: PowerShell/cmd default to the system ANSI code page
// (often GBK/CP936 on zh-CN), so agentcli's UTF-8 box-drawing + Chinese output
// arrives as mojibake. Force the console code page to 65001 AND rebind Node's
// stdout/stderr encodings to UTF-8 so bytes are decoded correctly. Best-effort:
// failures (e.g. non-interactive pipe) are silently ignored.
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore', shell: true });
  } catch {
    /* non-interactive or chcp unavailable */
  }
  try {
    process.stdout?.write?.('');
    if (typeof process.stdout?.setDefaultEncoding === 'function') {
      process.stdout.setDefaultEncoding('utf-8');
      process.stderr?.setDefaultEncoding?.('utf-8');
    }
  } catch {
    /* stream may be unavailable */
  }
}

process.once('SIGINT', cancelCli);

const versionIndex = args.indexOf('--version');
if (versionIndex !== -1) {
  console.log(currentVersion);
  process.exit(0);
}

const helpIndex = args.indexOf('--help');
if (helpIndex !== -1) {
  console.log(`
${BRAND.stylizedName} - 本地 AI runtime 工作区控制面

用法:
  ${BRAND.cliCommand} [options]

常用选项:
  --port <number>    HTTP 服务端口（默认：5680）
  --no-hermit-bridge 不自动启动内置 runtime bridge
  --daemon           在后台启动 Web 控制台
  --version          显示当前版本
  --help             显示帮助

命令:
  ${BRAND.cliCommand}         打开终端导航，选择本地使用、团队协作或用户授权
  init [--json]
                     快速初始化：启动 Web daemon + 用量后台 worker（默认开机自启）
  web [--json]       直接启动并打开本地数字员工工作台（Web），跳过终端导航
  status [--json]    查看后台服务状态
  doctor [--json]    运行只读本地诊断
  teams list [--json]
                     查看本地团队，不启动 Web
  teams create [--name <name>] [--bind-project <id>] [--work-dir <path>] [--harness <runtime>] [--json]
                     创建本地团队元数据，不启动 Web、bridge 或 agent
  create-digital-worker --name <name> [--description <text>] [--bind-project <id>] [--work-dir <path>] [--agent-type <runtime>] [--platform <channel>] [--platform-options <json>] [--json]
                     开通数字员工；扫码渠道返回二维码链接，手动渠道按 JSON 绑定凭据
  tasks list --team <team> [--json]
                     查看分配给数字员工或由其创建的任务
  tasks create --team <team> --title <text> [--description <text>] [--assignee <team>] [--json]
                     在 AgentCLI 看板创建任务
  tasks claim --team <team> --id <task-id> [--json]
                     认领并开始执行任务
  tasks comment --team <team> --id <task-id> --text <text> [--json]
                     向任务追加协作评论
  tasks clarify --team <team> --id <task-id> --target lead|user|none [--json]
                     请求或清除任务澄清状态
  tasks complete --team <team> --id <task-id> --result <text> [--json]
                     提交任务结果并完成任务
  usage status [--json]
                     查看本地 Claude JSONL telemetry 状态，不上传
  usage today [--json]
                     查看今日本地 usage 摘要，不上传
  usage report [--full] [--json]
                     扫描并按服务端游标增量上报新增消息
                     --full 忽略游标、重扫并重传最近 24 小时（服务端按 eventId 去重）
  usage start [--no-autostart] [--json]
                     开启轻量后台 usage 采集并默认配置开机自启，仅扫描本机 JSONL
  usage stop [--keep-autostart] [--json]
                     停止轻量后台 usage 采集并默认关闭开机自启
  usage autostart status|enable|disable [--json]
                     管理 usage 采集开机自启（macOS launchd）
  services [--json]
                     打开终端服务菜单，选择要启动/停止的本地服务
  services start web|usage|collaboration|local [--json]
                     按项启动本地服务
  services stop web|usage [--json]
                     按项停止本地服务
  collaboration start [--json]
                     启用团队协作配置（企业版开放，由 agentbus 提供服务）
  auth status [--json]
                     查看 ${BRAND.authAccountLabel}状态，不启动 Web
  auth login [--control-url <url>] [--json]
                     通过 ${BRAND.authProviderName} 打开飞书授权；CLI 只保存 ${BRAND.authProviderName} 授权状态
  auth logout [--json]
                     退出 ${BRAND.authAccountLabel}，不影响本地 runtime 登录
  stop               停止后台服务
  update             检查并安装更新（完成后请执行 restart）
  restart            重启 Web 与用量 worker，确保运行最新代码（update 后必跑）
  add <plugin>       安装能力插件到 MCP library
                     例如：${BRAND.cliCommand} add worker-society

示例:
  npx ${BRAND.npmPackage}             # 不安装直接运行
  npx ${BRAND.npmPackage} --daemon --port 8080
  ${BRAND.cliCommand}                          # 全局安装后打开终端导航
  ${BRAND.cliCommand} init                     # 快速启动 Web + 用量后台
  ${BRAND.cliCommand} --daemon                 # 后台启动 Web 控制台
  ${BRAND.cliCommand} teams create
  ${BRAND.cliCommand} teams list
  ${BRAND.cliCommand} status
  ${BRAND.cliCommand} stop
`);
  process.exit(0);
}

// Command handlers (usage, services, navigation) are now in:
//   bin/lib/usageCommand.mjs, bin/lib/servicesCommand.mjs, bin/lib/navigationCommand.mjs

await requireOpenHermitAuthForEntry();

if (commandArgs[0] === 'init') {
  // 默认只启动轻量的用量上报 worker。Web 工作台会拉起 hermit-bridge 等
  // 后台进程并常驻,装完即起会拖慢系统(尤以 Windows 明显),故改为按需
  // 启动:需要时运行 `agentcli web`。
  const usage = await runServiceAction('start-usage');
  const result = { ok: true, command: 'init', hermitHome, usage: usage.usage };
  if (jsonRequested) printJson(result);
  printCliRows(
    'AgentCLI 已初始化',
    [
      [
        '用量后台',
        usage.usage?.worker?.running ? `运行中 (pid ${usage.usage.worker.pid})` : '已请求启动',
      ],
      ['开机自启', usage.usage?.autostart?.enabled ? '已开启' : '未开启/不支持'],
      ['Web 工作台', '默认未启动'],
    ],
    '需要 Web 工作台时运行：agentcli web；停止用量：agentcli usage stop。'
  );
  process.exit(0);
}

if (commandArgs[0] === 'status') {
  await printDaemonStatus();
}

if (commandArgs[0] === 'doctor') {
  await printDoctor();
}

if (commandArgs[0] === 'update') {
  await runUpdate({ onUpdated: restartUsageWorkerIfRunning });
  process.exit(0);
}

if (commandArgs[0] === 'restart') {
  const result = await runRestart({ quiet: jsonRequested });
  if (jsonRequested) printJson(result);
  process.exit(0);
}

if (commandArgs[0] === 'aikey' && commandArgs[1] === 'manual') {
  await runAikeyManual();
}

if (commandArgs[0] === 'usage' && commandArgs[1] === 'status') {
  await printUsageStatus();
}

if (commandArgs[0] === 'usage' && commandArgs[1] === 'today') {
  await printUsageToday();
}

if (commandArgs[0] === 'usage' && commandArgs[1] === 'report') {
  await printUsageReport();
}

if (commandArgs[0] === 'usage' && commandArgs[1] === 'start') {
  await printUsageStart();
}

if (commandArgs[0] === 'usage' && commandArgs[1] === 'stop') {
  await printUsageStop();
}

if (commandArgs[0] === 'usage' && commandArgs[1] === 'autostart') {
  await printUsageAutostart();
}

if (commandArgs[0] === 'services') {
  await printServicesCommand();
}

if (commandArgs[0] === 'collaboration' && commandArgs[1] === 'start') {
  await printCollaborationStart();
}

if (commandArgs[0] === '__telemetry-worker') {
  // Single-instance guard: launchd RunAtLoad / Task Scheduler logon trigger call
  // this wrapper. If a worker is already running (e.g. `usage start` started one,
  // or the supervisor already fired), do NOT spawn a duplicate — the supervisor
  // (KeepAlive / RestartOnFailure) restarts on a real crash, but stacking
  // parallel workers causes the orphan/pid-mismatch problem. --scan-once is a
  // one-shot and bypasses the guard.
  // Pass through the worker's own flags so diagnostic invocations work:
  //   __telemetry-worker --scan-once
  //   __telemetry-worker --report-lark-credentials-once --json
  //   __telemetry-worker --startup-once
  // Only --scan-once bypasses the single-instance guard above.
  const PASSTHROUGH_FLAGS = [
    '--scan-once',
    '--startup-once',
    '--report-lark-credentials-once',
    '--json',
  ];
  const extraArgs = PASSTHROUGH_FLAGS.filter((flag) => args.includes(flag));
  const existingPid = readPidFile(telemetryWorkerPidPath);
  if (!extraArgs.includes('--scan-once') && existingPid && isPidRunning(existingPid)) {
    process.exit(0);
  }
  const child = spawn(process.execPath, telemetryWorkerChildArgs(extraArgs), {
    cwd: repoRoot,
    windowsHide: true,
    env: { ...process.env, HERMIT_HOME: hermitHome },
    stdio: 'inherit',
  });
  // Wait on 'close' (not 'exit') so stdio is fully drained + torn down before
  // proceeding — 'exit' raced the pipe close and tripped libuv's
  // UV_HANDLE_CLOSING assertion on Windows (win/async.c).
  const code = await new Promise((resolve) => child.on('close', resolve));
  process.exit(Number(code) || 0);
}

if (commandArgs[0] === 'auth' && commandArgs[1] === 'status') {
  await printAuthStatus();
}

if (commandArgs[0] === 'auth' && commandArgs[1] === 'login') {
  await runAuthLogin();
  invalidateAuthCache();
}

if (commandArgs[0] === 'auth' && commandArgs[1] === 'dev-login') {
  await runAuthDevLogin();
  invalidateAuthCache();
}

if (commandArgs[0] === 'auth' && commandArgs[1] === 'logout') {
  await runAuthLogout();
  invalidateAuthCache();
}

if (commandArgs.length === 0 && !daemonChild && !daemonRequested) {
  if (isInteractiveCli() && !jsonRequested) {
    const navigationKeepAlive = setInterval(() => undefined, 2_147_483_647);
    try {
      await printNavigation();
    } finally {
      clearInterval(navigationKeepAlive);
    }
  } else {
    await printNavigation();
  }
}

if (commandArgs[0] === 'teams' && commandArgs[1] === 'list') {
  printTeamsList();
}

if (commandArgs[0] === 'teams' && commandArgs[1] === 'create') {
  await printTeamsCreate();
}

if (commandArgs[0] === 'create-digital-worker') {
  const options = buildDigitalWorkerCommandOptions(commandArgs, findArg);
  const result = options.ok
    ? await createDigitalWorkerCommand(port, options, {
        onQrCode({ qrUrl }) {
          if (qrUrl) console.error(`扫码链接：${qrUrl}`);
        },
        onQrStatus(status) {
          console.error(`扫码状态：${status}`);
        },
      })
    : options;
  if (jsonRequested) printJson(result, result.ok ? 0 : 1);
  if (!jsonRequested) {
    if (result.ok) {
      console.log(result.message);
      console.log(`数字员工：${result.name}`);
      console.log(`团队/项目：${result.teamSlug}`);
      console.log(`运行时：${result.agentTypeLabel || result.agentType}`);
      console.log(`渠道：${result.platformLabel || result.platform}`);
      if (result.binding?.qrUrl) console.log(`扫码链接：${result.binding.qrUrl}`);
    } else {
      console.error(result.message);
    }
  }
  process.exit(result.ok ? 0 : 1);
}

if (commandArgs[0] === 'tasks') {
  await printTasksCommand();
}

// `hermit create-feishu-assistant` — create a Feishu personal assistant via hermit-bridge.
if (commandArgs[0] === 'create-feishu-assistant') {
  const name = findArg(commandArgs, '--name');
  const aiKey = findArg(commandArgs, '--ai-key');
  const description = findArg(commandArgs, '--description');
  const appId = findArg(commandArgs, '--app-id');
  const appSecret = findArg(commandArgs, '--app-secret');
  const result = createFeishuAssistant({ name, aiKey, description, appId, appSecret });
  if (jsonRequested) printJson(result, result.ok ? 0 : 1);
  if (!jsonRequested) console.log(result.message);
  if (!result.ok) process.exit(1);
}

// `hermit list-feishu-assistants` — list all Feishu-assistant projects.
if (commandArgs[0] === 'list-feishu-assistants') {
  const result = listFeishuAssistants();
  if (jsonRequested) {
    printJson(result, result.ok ? 0 : 1);
  } else if (result.ok && result.projects.length > 0) {
    console.log('飞书个人助理：');
    for (const p of result.projects) {
      console.log(`  ${p.name}  (${p.teamSlug})  ${p.status}`);
    }
  } else if (result.ok) {
    console.log('暂无飞书个人助理，运行 hermit create-feishu-assistant --name <名称> 创建');
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

// Simple arg parser for flag=value or --flag value patterns.
function findArg(args, flag) {
  const i = args.indexOf(flag);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const prefixed = args.find((a) => a.startsWith(`${flag}=`));
  if (prefixed) return prefixed.slice(flag.length + 1);
  return null;
}

// `agentcli web` — start the local workbench (if not already running) and
// open it in the browser, bypassing the terminal nav menu. Thin orchestrator:
// heavy lifting (spawn/ready-wait) lives in daemon.mjs; browser open reuses the
// auth module's cross-platform opener.
async function runWebCommand() {
  const url = `http://127.0.0.1:${port}`;
  const server = await checkExistingOpenHermitServer();
  if (!server.running) {
    const daemon = startDaemon({ exitOnDone: false, quiet: true });
    const ready = await waitForOpenHermitServerReadyWithLogs(daemon.pid, 60_000);
    if (!ready.ready) {
      if (jsonRequested)
        printJson(
          { ok: false, command: 'web', url, reason: ready.reason, logPath: daemonLogPath },
          1
        );
      printCliRows(
        `${BRAND.stylizedName} 工作台`,
        [
          ['状态', '启动失败或仍在启动中', 'error'],
          ['地址', url],
          ['日志', daemonLogPath],
          ['原因', ready.reason || '请查看日志'],
        ],
        `排查后重试：${brandCommand('web')} 或 ${brandCommand('status')}`
      );
      process.exit(1);
    }
  }
  await openExternalUrl(url);
  if (jsonRequested) printJson({ ok: true, command: 'web', url });
  printCliRows(
    `${BRAND.stylizedName} 工作台`,
    [
      ['状态', '已就绪', 'ok'],
      ['地址', url],
    ],
    `已在浏览器打开；停止服务：${brandCommand('stop')}`
  );
  process.exit(0);
}

if (commandArgs[0] === 'stop') {
  // `stop` no longer tears down running services. Proactively killing the Web
  // daemon and/or the usage worker here cost the user their state on the next
  // launch ("退出再进来 web 和 worker 都没了"). These services are designed to
  // outlive the CLI process; stop them only via an explicit, granular command:
  //   services stop web   — stop the Web UI daemon
  //   usage stop          — stop the background upload worker
  printCliRows(
    '后台服务',
    [
      ['说明', 'stop 不再主动关闭 Web / 用量 worker'],
      ['Web', '如需停止：services stop web'],
      ['用量 worker', '如需停止：usage stop'],
    ],
    '后台服务会持续运行，退出 CLI 不影响它们。'
  );
  process.exit(0);
}

if (commandArgs[0] === 'web' && !daemonChild) {
  await runWebCommand();
}

if (commandArgs.length > 0 && !daemonRequested && !daemonChild) {
  const command = commandArgs.join(' ');
  const result = { ok: false, command, error: `Unknown command: ${command}` };
  if (jsonRequested) printJson(result, 1);
  console.error(`${brandLogPrefix()} 未知命令：${command}`);
  console.error(
    `${brandLogPrefix()} 可用命令：init | web | status | doctor | update | restart | services | services start/stop | teams list/create | tasks list/create/claim/comment/clarify/complete | usage status/today/report/start/stop/autostart | auth status/login/logout | stop`
  );
  process.exit(1);
}

if (daemonRequested && !daemonChild) {
  startDaemon();
}

// ---------------------------------------------------------------------------
// Check dependencies
// ---------------------------------------------------------------------------

let hermitBridgeProcess = null;
let bridgeTokens = {
  managementToken:
    process.env.HERMIT_BRIDGE_TOKEN || process.env.HERMIT_BRIDGE_MANAGEMENT_TOKEN || '',
  bridgeToken: process.env.HERMIT_BRIDGE_WS_TOKEN || process.env.HERMIT_BRIDGE_TOKEN || '',
};
let runtimeSetupMode = false;

await assertWebPortAvailable();

if (!skipHermitBridge) {
  let shouldStartRuntime = false;
  bridgeTokens = readHermitBridgeConfigState();
  const bridgeBaseUrl = process.env.HERMIT_BRIDGE_BASE_URL || 'http://127.0.0.1:9820';
  const alreadyRunning = await waitForHermitBridge(
    bridgeBaseUrl,
    bridgeTokens.managementToken,
    1_000
  );
  if (alreadyRunning) {
    console.log(`${brandLogPrefix()} Runtime service already running: ${bridgeBaseUrl}`);
  } else if (bridgeTokens.hasProjects) {
    try {
      ensureCcConnectBinary();
      ensureClaudeCodeCliIfNeeded(bridgeTokens.raw);
      shouldStartRuntime = true;
    } catch {
      // Claude Code CLI missing / auto-install failed. Don't kill the daemon:
      // the web workbench (UI, teams, sessions, usage) doesn't need it — only
      // the bridge's agent spawning does. Degrade like the no-runner case
      // (runtimeSetupMode) so the web server still starts; install claude and
      // restart to get the runtime back.
      runtimeSetupMode = true;
      console.warn(`${brandLogPrefix()} Claude Code CLI 未就绪，跳过 runtime，工作台仍会启动。`);
      console.warn(
        `${brandLogPrefix()} 请手动安装：npm install -g @anthropic-ai/claude-code@latest`
      );
      printLogTail('Runtime', runtimeLogPath);
    }
  } else {
    console.error(
      `${brandLogPrefix()} Runtime config has no projects. Please edit the config and try again.`
    );
    console.error(`${brandLogPrefix()} Runtime config: ${hermitBridgeConfigPath}`);
    process.exit(1);
  }

  if (shouldStartRuntime) {
    const hermitBridgeRunner = resolveHermitBridgeRunner();
    if (!hermitBridgeRunner) {
      runtimeSetupMode = true;
      console.warn(
        `${brandLogPrefix()} Bundled ${BRAND.runtimeBridgeName} runtime is not installed for this platform.`
      );
      console.warn(
        `${brandLogPrefix()} Starting ${BRAND.stylizedName} without auto-starting the runtime service.`
      );
      console.warn(
        `${brandLogPrefix()} Configure an external ${BRAND.runtimeBridgeName} service or use --no-hermit-bridge to skip this check.`
      );
    } else {
      console.log(`${brandLogPrefix()} Starting bundled runtime service...`);
      console.log(`${brandLogPrefix()} Runtime config: ${hermitBridgeConfigPath}`);
      // If the runner is run.js, spawn under node; otherwise it's the native
      // binary (preferred — avoids run.js popping a console window on Windows
      // that users might close, killing the runtime) and spawn it directly.
      const isJs = /\.(js|mjs)$/i.test(hermitBridgeRunner);
      const cmd = isJs ? process.execPath : hermitBridgeRunner;
      const cmdArgs = isJs
        ? [hermitBridgeRunner, '-config', hermitBridgeConfigPath]
        : ['-config', hermitBridgeConfigPath];
      hermitBridgeProcess = spawn(cmd, cmdArgs, {
        cwd: repoRoot,
        // See daemon.mjs: detached:true defeats windowsHide on Windows and
        // pops a console window the user may close (killing the runtime).
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: {
          ...process.env,
          HERMIT_BRIDGE_TOKEN: bridgeTokens.managementToken,
          HERMIT_BRIDGE_MANAGEMENT_TOKEN: bridgeTokens.managementToken,
          HERMIT_BRIDGE_WS_TOKEN: bridgeTokens.bridgeToken,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      hermitBridgeProcess.stdout?.on('data', (chunk) => {
        process.stdout.write(chunk);
        appendLog(runtimeLogPath, chunk);
      });
      hermitBridgeProcess.stderr?.on('data', (chunk) => {
        process.stderr.write(chunk);
        appendLog(runtimeLogPath, chunk);
      });

      try {
        await waitForRuntimeReady(
          bridgeBaseUrl,
          bridgeTokens.managementToken,
          hermitBridgeProcess,
          180_000
        );
      } catch (err) {
        console.error(
          `${brandLogPrefix()} Runtime service failed to start: ${err instanceof Error ? err.message : String(err)}`
        );
        printLogTail('Runtime', runtimeLogPath);
        signalDaemon(hermitBridgeProcess.pid, 'SIGTERM');
        setTimeout(() => signalDaemon(hermitBridgeProcess?.pid, 'SIGKILL'), 2_000).unref();
        process.exit(1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

console.log(`${brandLogPrefix()} Starting ${BRAND.stylizedName} server...`);
console.log(`${brandLogPrefix()} Version: ${currentVersion}`);
console.log(`${brandLogPrefix()} Port: ${port}`);
console.log(`${brandLogPrefix()} Root: ${repoRoot}`);
console.log('');

// Build dist-renderer in development checkouts only. Published installs ship the
// prebuilt renderer and usually do not include frontend build dependencies.
const distRenderererDir = path.resolve(repoRoot, 'dist-renderer');
const distRendererEntry = path.join(distRenderererDir, 'index.html');
const canBuildRendererFromSource =
  existsSync(path.join(repoRoot, 'vite.web.config.ts')) &&
  existsSync(path.join(repoRoot, 'pnpm-lock.yaml')) &&
  existsSync(path.join(repoRoot, 'node_modules'));

if (!existsSync(distRendererEntry)) {
  if (!canBuildRendererFromSource) {
    console.error(`${brandLogPrefix()} Missing prebuilt frontend: dist-renderer/index.html`);
    console.error(
      `${brandLogPrefix()} This install appears incomplete. Please reinstall ${BRAND.npmPackage} or report a packaging issue.`
    );
    process.exit(1);
  }

  console.log(`${brandLogPrefix()} Building frontend...`);
  const buildProcess = spawn('pnpm build:web', {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });

  await new Promise((resolve, reject) => {
    buildProcess.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Frontend build failed with exit code ${code}`));
      }
    });
    buildProcess.on('error', reject);
  });
  console.log(`${brandLogPrefix()} Frontend built successfully\n`);
}

// Start the server
console.log(`${brandLogPrefix()} Launching server...\n`);

function printServerLogTail() {
  printLogTail('Server', serverLogPath);
}

// Reap detached server.ts / hermit-bridge ORPHANS (PPID=1) left by a prior
// daemon that died before shutdown() could — before we spawn the fresh server.
// PPID=1-only guarantees we never touch a live daemon's own children.
const orphanedDaemonChildPids = collectOrphanedDaemonChildPids();
if (orphanedDaemonChildPids.length) {
  console.log(`${brandLogPrefix()} 清理 ${orphanedDaemonChildPids.length} 个遗留 daemon 子进程...`);
  await stopFallbackProcesses(orphanedDaemonChildPids);
}

// Prefer the precompiled bundle (dist/server.bundle.cjs) when present — boots
// with plain `node`, skipping the tsx + alias-loader runtime transpile that
// makes cold starts slow (see scripts/build-server.mjs). Falls back to tsx for
// dev or when the bundle hasn't been built.
const serverBundlePath = path.join(repoRoot, 'dist', 'server.bundle.mjs');
const useServerBundle = existsSync(serverBundlePath);
const serverArgs = useServerBundle
  ? [serverBundlePath]
  : [
      '--import',
      resolveAliasLoaderRegister(),
      '--import',
      resolveTsxLoader(),
      'src/main/server.ts',
    ];
const serverProcess = spawn(process.execPath, serverArgs, {
  cwd: repoRoot,
  // Windows: the DAEMON child is spawned detached (see daemon.mjs — that is
  // what survives terminal close); the server inherits that console-less
  // context with windowsHide, so it neither pops a window nor dies with the
  // launching terminal. Foreground (non-daemon) runs stay console-attached.
  detached: process.platform !== 'win32',
  windowsHide: true,
  env: {
    ...process.env,
    PORT: port,
    HOST: process.env.HOST || '127.0.0.1',
    NODE_ENV: 'production',
    HERMIT_HOME: hermitHome,
    HERMIT_RUNTIME_SETUP_MODE: runtimeSetupMode ? '1' : '0',
    HERMIT_BRIDGE_TOKEN: bridgeTokens.managementToken,
    HERMIT_BRIDGE_MANAGEMENT_TOKEN: bridgeTokens.managementToken,
    HERMIT_BRIDGE_WS_TOKEN: bridgeTokens.bridgeToken,
    HERMIT_BRIDGE_CONFIG: hermitBridgeConfigPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

serverProcess.stdout?.on('data', (chunk) => {
  process.stdout.write(chunk);
  appendLog(serverLogPath, chunk);
});

serverProcess.stderr?.on('data', (chunk) => {
  process.stderr.write(chunk);
  appendLog(serverLogPath, chunk);
});

serverProcess.on('exit', (code) => {
  if (shuttingDown) return;
  signalDaemon(hermitBridgeProcess?.pid, 'SIGTERM');
  if (code !== 0) {
    console.error(`${brandLogPrefix()} Server exited with code ${code}`);
    printServerLogTail();
    process.exit(code ?? 1);
  }
});

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${brandLogPrefix()} Shutting down...`);
  signalDaemon(serverProcess?.pid, 'SIGTERM');
  signalDaemon(hermitBridgeProcess?.pid, 'SIGTERM');
  setTimeout(() => {
    signalDaemon(serverProcess?.pid, 'SIGKILL');
    signalDaemon(hermitBridgeProcess?.pid, 'SIGKILL');
    process.exit(exitCode);
  }, 2_000).unref();
}

process.on('SIGINT', () => {
  shutdown(0);
});

process.on('SIGTERM', () => {
  shutdown(0);
});

console.log(
  `${brandLogPrefix()} Server starting on http://${process.env.HOST || '127.0.0.1'}:${port}`
);
console.log(`${brandLogPrefix()} Press Ctrl+C to stop\n`);
