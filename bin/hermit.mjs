#!/usr/bin/env node
/**
 * AgentPanel terminal entry point.
 *
 * The desktop/browser Workbench is the source of truth for teams, tasks,
 * external channels, and delivery. This CLI is deliberately a thin local
 * control surface rather than a second cloud, AgentBus, or credential product.
 */
process.noDeprecation = true;

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { BRAND, brandLogPrefix } from './branding.mjs';
import { installProcessExitGuard } from './lib/exitGuard.mjs';
import {
  args,
  commandArgs,
  currentVersion,
  daemonChild,
  daemonRequested,
  hermitHome,
  jsonRequested,
  port,
  repoRoot,
} from './lib/env.mjs';
import { printCliRows, printJson } from './lib/terminal.mjs';
import {
  assertWebPortAvailable,
  appendLog,
  printLogTail,
  resolveAliasLoaderRegister,
  resolveTsxLoader,
} from './lib/runtime.mjs';
import {
  collectOrphanedDaemonChildPids,
  printDaemonStatus,
  signalDaemon,
  startDaemon,
  stopDaemon,
  stopFallbackProcesses,
  waitForOpenHermitServerReady,
} from './lib/daemon.mjs';
import { runUpdate } from './lib/update.mjs';
import { runRestart } from './lib/restart.mjs';
import { printServicesCommand } from './lib/servicesCommand.mjs';
import { printTasksCommand } from './lib/tasks.mjs';
import { printTeamsCommand } from './lib/teamsCommand.mjs';
import { printExternalChannelsCommand } from './lib/externalChannelsCommand.mjs';
import { printDeliveriesCommand } from './lib/deliveriesCommand.mjs';
import { printDoctor } from './lib/doctorCommand.mjs';

installProcessExitGuard();

function printHelp() {
  console.log(`
${BRAND.stylizedName} - 本地 AI Agent 工作台

用法:
  ${BRAND.cliCommand} [options]

选项:
  --port <number>    本地工作台端口（默认：5680）
  --daemon           在后台启动本地工作台
  --json             以 JSON 输出命令结果
  --version          显示当前版本
  --help             显示帮助

命令:
  ${BRAND.cliCommand}         启动并打开本地 AgentPanel 工作台
  web [--json]       启动并打开本地 AgentPanel 工作台
  status [--json]    查看本地服务状态
  doctor [--json]    运行只读本地诊断
  services status|start web|stop web [--json]
                     管理本地工作台服务
  teams list [--json]
                     查看本地团队
  teams create --name <name> --bind-project <slug> --work-dir <path> [--harness <runtime>] [--json]
                     通过本地 AgentPanel 创建团队
  tasks list --team <team> [--json]
                     查看任务
  tasks create --team <team> --title <text> [--description <text>] [--assignee <team>] [--json]
                     创建任务
  tasks claim --team <team> --id <task-id> [--json]
                     认领任务
  tasks clarify --team <team> --id <task-id> --target lead|user|none [--json]
                     更新任务澄清状态
  tasks complete --team <team> --id <task-id> --result <text> [--json]
                     提交任务结果
  external-channels cc-connect status|enable|disable [--json]
                     管理可选 cc-connect 外部渠道插件；本地 Direct CLI 无需启用
  deliveries archive --team <team> --task <task-id> [--json]
                     查看已批准的本地成果版本
  deliveries zip --team <team> --task <task-id> --output <path.zip> [--json]
                     导出已批准的本地成果 ZIP
  deliveries github bindings|bind|unbind|publish [--agent <name>] [--json]
                     管理可选 GitHub 成果交付；publish 需要 --yes 确认
  restart            重启本地工作台以应用插件设置
  stop               停止本地工作台服务
  update             检查并安装更新

示例:
  ${BRAND.cliCommand} web
  ${BRAND.cliCommand} external-channels cc-connect enable
  ${BRAND.cliCommand} deliveries archive --team <team> --task <task-id>
  ${BRAND.cliCommand} restart
  ${BRAND.cliCommand} tasks list --team <team>
`);
}

function launchBrowser(url) {
  let command = 'xdg-open';
  if (process.platform === 'darwin') command = 'open';
  else if (process.platform === 'win32') command = 'cmd';
  const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function runWebCommand() {
  const url = `http://127.0.0.1:${port}`;
  const daemon = startDaemon({ exitOnDone: false, quiet: true, childArgs: [] });
  const ready = await waitForOpenHermitServerReady(daemon.pid, 60_000);
  if (!ready.ready) {
    const result = { ok: false, command: 'web', url, reason: ready.reason };
    if (jsonRequested) printJson(result, 1);
    else {
      printCliRows(
        '本地工作台启动失败',
        [['原因', ready.reason || '服务未在预期时间内就绪']],
        '请运行 agentpanel doctor 查看本地诊断。'
      );
    }
    process.exit(1);
  }
  launchBrowser(url);
  const result = { ok: true, command: 'web', url };
  if (jsonRequested) printJson(result);
  else printCliRows('本地工作台已就绪', [['地址', url, 'ok']], '已尝试在默认浏览器打开。');
  process.exit(0);
}

async function runStopCommand() {
  const web = await stopDaemon({ exitOnDone: false, quiet: true });
  const result = { ok: true, command: 'stop', web };
  if (jsonRequested) printJson(result);
  else
    printCliRows(
      '本地工作台',
      [['状态', web.running ? '正在停止' : '未运行']],
      '外部渠道插件设置不会被删除。'
    );
  process.exit(0);
}

function unknownCommand() {
  const command = commandArgs.join(' ');
  const result = { ok: false, command, error: `未知命令：${command}` };
  if (jsonRequested) printJson(result, 1);
  else {
    console.error(`${brandLogPrefix()} ${result.error}`);
    console.error(`${brandLogPrefix()} 运行 agentpanel --help 查看本地命令。`);
  }
  process.exit(1);
}

if (args.includes('--version')) {
  console.log(currentVersion);
  process.exit(0);
}
if (args.includes('--help')) {
  printHelp();
  process.exit(0);
}

if (!daemonChild) {
  if (commandArgs.length === 0 && !daemonRequested) await runWebCommand();
  if (commandArgs[0] === 'web') await runWebCommand();
  if (commandArgs[0] === 'status') await printDaemonStatus();
  if (commandArgs[0] === 'doctor') await printDoctor();
  if (commandArgs[0] === 'services') await printServicesCommand();
  if (commandArgs[0] === 'teams') await printTeamsCommand();
  if (commandArgs[0] === 'tasks') await printTasksCommand();
  if (commandArgs[0] === 'external-channels') await printExternalChannelsCommand();
  if (commandArgs[0] === 'deliveries') await printDeliveriesCommand();
  if (commandArgs[0] === 'update') {
    await runUpdate();
    process.exit(0);
  }
  if (commandArgs[0] === 'restart') {
    const result = await runRestart({ quiet: jsonRequested });
    if (jsonRequested) printJson(result);
    process.exit(0);
  }
  if (commandArgs[0] === 'stop') await runStopCommand();
  if (daemonRequested) startDaemon();
  if (commandArgs.length > 0) unknownCommand();
}

await assertWebPortAvailable();

const orphanedDaemonChildPids = collectOrphanedDaemonChildPids();
if (orphanedDaemonChildPids.length > 0) {
  console.log(`${brandLogPrefix()} 清理 ${orphanedDaemonChildPids.length} 个遗留工作台子进程...`);
  await stopFallbackProcesses(orphanedDaemonChildPids);
}

const serverBundlePath = path.join(repoRoot, 'dist', 'server.bundle.mjs');
const serverArgs = existsSync(serverBundlePath)
  ? [serverBundlePath]
  : [
      '--import',
      resolveAliasLoaderRegister(),
      '--import',
      resolveTsxLoader(),
      'src/main/server.ts',
    ];

console.log(`${brandLogPrefix()} 启动本地工作台...`);
const serverProcess = spawn(process.execPath, serverArgs, {
  cwd: repoRoot,
  detached: process.platform !== 'win32',
  windowsHide: true,
  env: {
    ...process.env,
    PORT: port,
    HOST: process.env.HOST || '127.0.0.1',
    NODE_ENV: 'production',
    HERMIT_HOME: hermitHome,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

serverProcess.stdout?.on('data', (chunk) => {
  process.stdout.write(chunk);
  appendLog(path.join(hermitHome, 'logs', 'openhermit-server.log'), chunk);
});
serverProcess.stderr?.on('data', (chunk) => {
  process.stderr.write(chunk);
  appendLog(path.join(hermitHome, 'logs', 'openhermit-server.log'), chunk);
});

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  signalDaemon(serverProcess.pid, 'SIGTERM');
  setTimeout(() => {
    signalDaemon(serverProcess.pid, 'SIGKILL');
    process.exit(exitCode);
  }, 2_000).unref();
}

serverProcess.on('exit', (code) => {
  if (shuttingDown) return;
  if (code !== 0) {
    console.error(`${brandLogPrefix()} 本地工作台退出，代码：${code}`);
    printLogTail('Server', path.join(hermitHome, 'logs', 'openhermit-server.log'));
  }
  process.exit(code ?? 1);
});
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
