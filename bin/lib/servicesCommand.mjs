// servicesCommand.mjs — `services` top-level command + services menu.
// Extracted from hermit.mjs to keep it under 3000 lines.
import { args, commandArgs, jsonRequested, port, hermitHome, daemonLogPath } from './env.mjs';
import { printJson, printCliRows, isInteractiveCli } from './terminal.mjs';
import { collectDaemonStatus, startDaemon, stopDaemon } from './daemon.mjs';
import {
  readHermitSettings,
  writeHermitSettings,
  enableTeamCollaborationDefaults,
} from './settings.mjs';
import { readOpenHermitAuthStatus } from './auth.mjs';
import { BRAND, brandLogPrefix } from '../branding.mjs';
import { SERVICE_ACTIONS } from './menus.mjs';
import { askMenuAction, waitForContinue } from './navigation.mjs';
import {
  enableLocalUsageTelemetry,
  disableLocalUsageTelemetry,
  startTelemetryWorker,
  stopTelemetryWorker,
  enableUsageAutostart,
  disableUsageAutostart,
  getUsageAutostartStatus,
} from './usageCommand.mjs';

// --- Task-bus summarizer -------------------------------------------------------

function summarizeTaskBus(taskBus = {}) {
  const redis =
    taskBus.redis && typeof taskBus.redis === 'object'
      ? taskBus.redis
      : { host: '127.0.0.1', port: 6379 };
  return {
    enabled: Boolean(taskBus.enabled),
    collaboration: Boolean(taskBus.collaboration),
    redis: {
      host: typeof redis.host === 'string' && redis.host.trim() ? redis.host : '127.0.0.1',
      port: Number.isFinite(Number(redis.port)) ? Number(redis.port) : 6379,
      ...(redis.password ? { password: true } : {}),
      ...(redis.db !== undefined ? { db: redis.db } : {}),
    },
    telemetry: {
      enabled: Boolean(taskBus.telemetry?.enabled),
      platform: taskBus.telemetry?.platform || 'claudecode',
    },
  };
}

// --- Service collectors --------------------------------------------------------

export async function collectServicesStatus() {
  const { readUsageStatus } = await import('./usageCommand.mjs');
  const [daemon, usage] = await Promise.all([
    collectDaemonStatus(),
    readUsageStatus({ scan: false }),
  ]);
  const taskBus = summarizeTaskBus(readHermitSettings().taskBus || {});
  return {
    hermitHome,
    web: {
      running: Boolean(daemon.running),
      pid: daemon.pid || null,
      url: daemon.server?.url || daemon.url,
      logPath: daemonLogPath,
    },
    usage: {
      enabled: taskBus.telemetry.enabled,
      worker: usage.worker,
      autostart: usage.worker?.autostart || null,
      source: 'claude-jsonl',
    },
    collaboration: {
      enabled: Boolean(taskBus.enabled && taskBus.collaboration),
      redis: taskBus.redis,
    },
    auth: {
      authorized: readOpenHermitAuthStatus().authorized,
    },
  };
}

// --- Display helpers -----------------------------------------------------------

export function servicesStatusRows(status) {
  const usageRunning = Boolean(status.usage.worker?.running);
  const usageEnabled = Boolean(status.usage.enabled);
  const collaborationEnabled = Boolean(status.collaboration.enabled);
  return [
    [
      '本地服务',
      status.web.running ? `运行中 ${status.web.url}` : '未运行',
      status.web.running ? 'ok' : 'off',
    ],
    [
      '用量后台',
      usageRunning ? `运行中 (pid ${status.usage.worker.pid})` : '未运行',
      usageRunning ? 'ok' : 'off',
    ],
    [
      '用量统计',
      usageEnabled ? (usageRunning ? '本地扫描开启' : '已开启，后台未运行') : '关闭',
      usageEnabled && !usageRunning ? 'warn' : usageEnabled ? 'ok' : 'off',
    ],
    [
      'IM 协作',
      collaborationEnabled ? '配置已开启（非本地进程）' : '关闭',
      collaborationEnabled ? 'info' : 'off',
    ],
    ['用户', status.auth.authorized ? '已登录' : '未登录', status.auth.authorized ? 'ok' : 'off'],
  ];
}

function printServicesRows(title, status, hint = '') {
  printCliRows(title, servicesStatusRows(status), hint);
}

// --- Individual service start/stop --------------------------------------------

async function startUsageService({ autostartRequested = !args.includes('--no-autostart') } = {}) {
  enableLocalUsageTelemetry();
  const worker = await startTelemetryWorker({ quiet: true });
  const autostart = autostartRequested
    ? await enableUsageAutostart()
    : await getUsageAutostartStatus();
  return { enabled: true, worker, autostart, source: 'claude-jsonl' };
}

async function stopUsageService() {
  const taskBus = disableLocalUsageTelemetry();
  const worker = await stopTelemetryWorker();
  const autostart = await disableUsageAutostart();
  return {
    enabled: Boolean(taskBus.telemetry?.enabled),
    worker,
    autostart,
    source: 'claude-jsonl',
  };
}

function startCollaborationService() {
  return summarizeTaskBus(enableTeamCollaborationDefaults());
}

function startWebService() {
  if (process.env.OPENHERMIT_SERVICE_WEB_MODE === 'test') {
    return {
      running: true,
      started: true,
      pid: process.pid,
      url: `http://127.0.0.1:${port}`,
      logPath: daemonLogPath,
      mode: 'test',
    };
  }
  return { running: true, ...startDaemon({ exitOnDone: false, quiet: true }) };
}

// --- Service action router ----------------------------------------------------

export async function runServiceAction(actionId) {
  if (actionId === 'start-local') {
    const web = startWebService();
    const usage = await startUsageService();
    const collaboration = startCollaborationService();
    return {
      ok: true,
      command: 'services start local',
      hermitHome,
      web,
      usage,
      collaboration,
      auth: { authorized: readOpenHermitAuthStatus().authorized },
    };
  }
  if (actionId === 'start-web')
    return { ok: true, command: 'services start web', hermitHome, web: startWebService() };
  if (actionId === 'start-usage')
    return {
      ok: true,
      command: 'services start usage',
      hermitHome,
      usage: await startUsageService(),
    };
  if (actionId === 'start-collaboration')
    return {
      ok: true,
      command: 'services start collaboration',
      hermitHome,
      collaboration: startCollaborationService(),
      auth: { authorized: readOpenHermitAuthStatus().authorized },
    };
  if (actionId === 'stop-usage')
    return {
      ok: true,
      command: 'services stop usage',
      hermitHome,
      usage: await stopUsageService(),
    };
  if (actionId === 'stop-web')
    return {
      ok: true,
      command: 'services stop web',
      hermitHome,
      web: await stopDaemon({ exitOnDone: false, quiet: true }),
    };
  if (actionId === 'status') return printServicesStatus({ exitOnDone: false });
  throw new Error(`Unknown services action: ${actionId}`);
}

function serviceActionIdForCommand(verb, target) {
  if (!verb) return 'status';
  if (verb === 'status') return 'status';
  if (verb === 'start') {
    if (target === 'local') return 'start-local';
    if (target === 'web') return 'start-web';
    if (target === 'usage') return 'start-usage';
    if (target === 'collaboration') return 'start-collaboration';
  }
  if (verb === 'stop') {
    if (target === 'usage') return 'stop-usage';
    if (target === 'web') return 'stop-web';
  }
  return null;
}

// --- Menu loop ----------------------------------------------------------------

export async function runServicesMenu() {
  while (true) {
    const actionId = await askMenuAction({
      title: '服务菜单',
      subtitle: '选择要启动/停止的本地服务；本地基础服务无需登录',
      actions: SERVICE_ACTIONS,
      escapeAction: 'back',
    });
    if (actionId === 'back') return;
    try {
      await runServiceAction(actionId);
      const status = await collectServicesStatus();
      printServicesRows('服务已更新', status);
    } catch (err) {
      printCliRows(
        '服务操作失败',
        [['原因', err instanceof Error ? err.message : String(err)]],
        '上传/托管能力需要先在「用户」中登录。'
      );
    }
    await waitForContinue('按 Enter/← 返回服务菜单 | Esc/Ctrl+C 退出');
  }
}

// --- CLI entry point ----------------------------------------------------------

export async function printServicesStatus({ exitOnDone = true } = {}) {
  const status = await collectServicesStatus();
  const result = { ok: true, command: 'services status', ...status, actions: SERVICE_ACTIONS };
  if (jsonRequested) printJson(result);
  printServicesRows('服务状态', status, '启动本地基础服务：agentcli services start local');
  if (exitOnDone) process.exit(0);
  return result;
}

export async function printServicesCommand({ exitOnDone = true } = {}) {
  if (commandArgs.length === 1 && !jsonRequested && isInteractiveCli()) {
    await runServicesMenu();
    if (exitOnDone) process.exit(0);
    return { ok: true, command: 'services' };
  }
  const actionId = serviceActionIdForCommand(commandArgs[1], commandArgs[2]);
  if (!actionId) {
    const command = commandArgs.join(' ');
    const result = { ok: false, command, error: `Unknown services action: ${command}` };
    if (jsonRequested) printJson(result, 1);
    console.error(`${brandLogPrefix()} 未知 services 动作：${command}`);
    if (exitOnDone) process.exit(1);
    return result;
  }
  const result = await runServiceAction(actionId);
  if (jsonRequested) printJson(result);
  if (actionId === 'status') return result;
  const status = await collectServicesStatus();
  printServicesRows('服务已更新', status, '继续定制可运行：agentcli services');
  if (exitOnDone) process.exit(0);
  return result;
}
