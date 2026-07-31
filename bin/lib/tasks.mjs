// tasks.mjs — AgentCLI task-bus commands for digital employees.
// All mutations go through the running Workbench API so the task board remains
// the single source of truth. Skills and MCP are intentionally not involved.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { args, commandArgs, findOptionValue, jsonRequested, port } from './env.mjs';
import { printJson } from './terminal.mjs';
import { collectTasks } from './teams.mjs';

function option(name) {
  return findOptionValue(name);
}

function teamOption() {
  return String(option('--team') || process.env.HERMIT_TEAM_SLUG || '').trim();
}

function unwrapApiResponse(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload) return payload.data;
  return payload;
}

function desktopRuntimeMetadata() {
  try {
    const hermitHome = process.env.HERMIT_HOME || path.join(homedir(), '.hermit');
    const parsed = JSON.parse(
      readFileSync(path.join(hermitHome, 'desktop-runtime.json'), 'utf8')
    );
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function taskBusBaseUrl() {
  if (args.includes('--port')) return `http://127.0.0.1:${port}`;
  if (process.env.HERMIT_WORKBENCH_URL) {
    return String(process.env.HERMIT_WORKBENCH_URL).replace(/\/$/u, '');
  }
  const desktopOrigin = desktopRuntimeMetadata()?.origin;
  return String(desktopOrigin || `http://127.0.0.1:${port}`).replace(/\/$/u, '');
}

function taskBusHeaders(body) {
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  const sessionToken =
    process.env.AGENTCLI_DESKTOP_SESSION_TOKEN || desktopRuntimeMetadata()?.sessionToken;
  if (sessionToken) headers['x-agentcli-desktop-token'] = String(sessionToken);
  return Object.keys(headers).length > 0 ? headers : undefined;
}

async function requestTaskBus(pathname, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${taskBusBaseUrl()}${pathname}`, {
      method,
      headers: taskBusHeaders(body),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `AgentCLI 工作台未启动或不可达（${taskBusBaseUrl()}）：${error instanceof Error ? error.message : String(error)}`
    );
  }

  const text = await response.text();
  let payload = {};
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`AgentCLI 工作台返回了无效响应（HTTP ${response.status}）`);
    }
  }
  const unwrapped = unwrapApiResponse(payload);
  if (!response.ok || unwrapped?.ok === false) {
    throw new Error(unwrapped?.error || payload?.error || `HTTP ${response.status}`);
  }
  return unwrapped;
}

function requireValue(value, message) {
  if (!String(value || '').trim()) throw new Error(message);
  return String(value).trim();
}

function taskLine(task) {
  const owner = task.owner ? ` → ${task.owner}` : '';
  return `${task.displayId || String(task.id || '').slice(0, 8)}  ${task.status || 'pending'}${owner}  ${task.subject || ''}`;
}

function printSuccessfulTaskResult(result) {
  if (result.command === 'tasks list') {
    if (result.tasks.length === 0) {
      console.log(`团队 ${result.team} 暂无可见任务`);
      return;
    }
    console.log(`团队 ${result.team} 的任务：`);
    for (const task of result.tasks) console.log(`  ${taskLine(task)}`);
    return;
  }
  if (result.command === 'tasks create') console.log(`任务已创建：${taskLine(result.task)}`);
  if (result.command === 'tasks claim') console.log(`任务已认领：${taskLine(result.task)}`);
  if (result.command === 'tasks comment') console.log(`任务评论已提交：${result.taskId}`);
  if (result.command === 'tasks clarify') {
    console.log(`任务澄清状态已更新：${result.taskId} → ${result.target}`);
  }
  if (result.command === 'tasks complete') {
    console.log(`任务已提交完成：${taskLine(result.task)}`);
  }
}

function printTaskResult(result) {
  if (jsonRequested) printJson(result, result.ok ? 0 : 1);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  printSuccessfulTaskResult(result);
  process.exit(0);
}

async function runTaskListCommand(rawTeam) {
  if (!rawTeam && commandArgs.includes('--team')) {
    const invalid = collectTasks('');
    return {
      ok: true,
      command: 'tasks list',
      team: '',
      source: 'local-fallback',
      resolvedTeam: invalid.resolvedTeam,
      boardPath: invalid.boardPath,
      tasks: invalid.tasks,
      warnings: invalid.warnings,
    };
  }
  const team = requireValue(
    rawTeam,
    'Missing required --team <team>：请传入团队 slug，或设置 HERMIT_TEAM_SLUG。'
  );
  const offline = collectTasks(team);
  try {
    const response = await requestTaskBus(`/api/task-bus/tasks?team=${encodeURIComponent(team)}`);
    const tasks = Array.isArray(response) ? response : [];
    if (tasks.length > 0 || offline.tasks.length === 0) {
      return { ok: true, command: 'tasks list', team, source: 'task-bus', tasks };
    }
  } catch {
    // Fall back to the same local board used by the Workbench task service.
  }
  return {
    ok: true,
    command: 'tasks list',
    team,
    source: 'local-fallback',
    resolvedTeam: offline.resolvedTeam,
    boardPath: offline.boardPath,
    tasks: offline.tasks,
    warnings: offline.warnings,
  };
}

export async function runTasksCommand() {
  const action = commandArgs[1];
  const rawTeam = teamOption();
  if (action === 'list') return runTaskListCommand(rawTeam);
  const team = requireValue(
    rawTeam,
    'Missing required --team <team>：请传入团队 slug，或设置 HERMIT_TEAM_SLUG。'
  );

  if (action === 'create') {
    const title = requireValue(
      option('--title') || option('--subject'),
      '缺少任务标题：--title <text>'
    );
    const description = option('--description');
    const assignee = option('--assignee');
    const task = await requestTaskBus(`/api/teams/${encodeURIComponent(team)}/tasks`, {
      method: 'POST',
      body: {
        subject: title,
        description: description || undefined,
        owner: assignee || undefined,
      },
    });
    return { ok: true, command: 'tasks create', team, task };
  }

  const taskId = requireValue(option('--id') || option('--task'), '缺少任务 ID：--id <task-id>');
  const taskPath = `/api/task-bus/tasks/${encodeURIComponent(taskId)}`;

  if (action === 'claim') {
    const response = await requestTaskBus(`${taskPath}/claim`, {
      method: 'POST',
      body: { team },
    });
    return { ok: true, command: 'tasks claim', team, task: response.task };
  }

  if (action === 'comment') {
    const text = requireValue(
      option('--text') || option('--message'),
      '缺少评论内容：--text <text>'
    );
    await requestTaskBus(`${taskPath}/comments`, {
      method: 'POST',
      body: { team, text },
    });
    return { ok: true, command: 'tasks comment', team, taskId, text };
  }

  if (action === 'clarify') {
    const target = requireValue(option('--target'), '缺少澄清目标：--target lead|user|none');
    if (!['lead', 'user', 'none'].includes(target)) {
      throw new Error('澄清目标必须是 lead、user 或 none。');
    }
    await requestTaskBus(`${taskPath}/clarification`, {
      method: 'POST',
      body: { team, target },
    });
    return { ok: true, command: 'tasks clarify', team, taskId, target };
  }

  if (action === 'complete') {
    const result = requireValue(option('--result'), '缺少交付结果：--result <text>');
    const response = await requestTaskBus(`${taskPath}/complete`, {
      method: 'POST',
      body: { team, result },
    });
    return { ok: true, command: 'tasks complete', team, task: response.task };
  }

  throw new Error(`未知 tasks 命令：${action || '(empty)'}`);
}

export async function printTasksCommand() {
  try {
    printTaskResult(await runTasksCommand());
  } catch (error) {
    printTaskResult({
      ok: false,
      command: `tasks ${commandArgs[1] || ''}`.trim(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
