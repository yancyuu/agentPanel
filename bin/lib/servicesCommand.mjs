// servicesCommand.mjs — local Workbench lifecycle only.
import { commandArgs, hermitHome, jsonRequested, port } from './env.mjs';
import { printCliRows, printJson } from './terminal.mjs';
import { collectDaemonStatus, startDaemon, stopDaemon } from './daemon.mjs';

export const SERVICE_ACTIONS = [
  { id: 'start-web', label: '启动本地工作台', description: '启动 AgentPanel 本地服务' },
  { id: 'status', label: '查看服务状态', description: '查看本地工作台进程与地址' },
  { id: 'stop-web', label: '停止本地工作台', description: '停止本地工作台服务' },
];

export async function collectServicesStatus() {
  const daemon = await collectDaemonStatus();
  return {
    hermitHome,
    web: {
      running: Boolean(daemon.running),
      pid: daemon.pid || null,
      url: daemon.server?.url || daemon.url || `http://127.0.0.1:${port}`,
    },
  };
}

export function servicesStatusRows(status) {
  return [
    [
      '本地工作台',
      status.web.running ? `运行中 ${status.web.url}` : '未运行',
      status.web.running ? 'ok' : 'off',
    ],
  ];
}

export async function runServiceAction(actionId) {
  if (actionId === 'status') return printServicesStatus({ exitOnDone: false });
  if (actionId === 'start-web') {
    return {
      ok: true,
      command: 'services start web',
      hermitHome,
      web: startDaemon({ exitOnDone: false, quiet: true }),
    };
  }
  if (actionId === 'stop-web') {
    return {
      ok: true,
      command: 'services stop web',
      hermitHome,
      web: await stopDaemon({ exitOnDone: false, quiet: true }),
    };
  }
  throw new Error(`未知 services 动作：${actionId}`);
}

function serviceActionIdForCommand(verb, target) {
  if (!verb || verb === 'status') return 'status';
  if (verb === 'start' && target === 'web') return 'start-web';
  if (verb === 'stop' && target === 'web') return 'stop-web';
  return null;
}

export async function printServicesStatus({ exitOnDone = true } = {}) {
  const status = await collectServicesStatus();
  const result = { ok: true, command: 'services status', ...status, actions: SERVICE_ACTIONS };
  if (jsonRequested) printJson(result);
  else
    printCliRows('本地服务状态', servicesStatusRows(status), '启动：agentpanel services start web');
  if (exitOnDone) process.exit(0);
  return result;
}

export async function printServicesCommand({ exitOnDone = true } = {}) {
  const actionId = serviceActionIdForCommand(commandArgs[1], commandArgs[2]);
  if (!actionId) {
    const command = commandArgs.join(' ');
    const result = { ok: false, command, error: '用法：services status|start web|stop web' };
    if (jsonRequested) printJson(result, 1);
    else console.error(result.error);
    if (exitOnDone) process.exit(1);
    return result;
  }
  const result = await runServiceAction(actionId);
  if (jsonRequested) printJson(result);
  if (actionId === 'status') return result;
  const status = await collectServicesStatus();
  if (!jsonRequested) printCliRows('本地服务已更新', servicesStatusRows(status));
  if (exitOnDone) process.exit(0);
  return result;
}
