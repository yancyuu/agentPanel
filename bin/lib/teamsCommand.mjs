// teamsCommand.mjs — Panel-backed terminal team discovery and provisioning.
import { commandArgs, findOptionValue, jsonRequested } from './env.mjs';
import { createPanelApiClient } from './panelApi.mjs';
import { printCliRows, printJson } from './terminal.mjs';

function error(command, message) {
  return { ok: false, command, error: message };
}

function requireOption(name, message) {
  const value = String(findOptionValue(name) || '').trim();
  if (!value) throw new Error(message);
  return value;
}

export async function runTeamsCommand(
  rawArgs = commandArgs,
  { client = createPanelApiClient() } = {}
) {
  const action = rawArgs[1] || 'list';
  if (action === 'list') {
    const teams = await client.request('/api/teams');
    return { ok: true, command: 'teams list', teams: Array.isArray(teams) ? teams : [] };
  }
  if (action === 'create') {
    const displayName = requireOption('--name', '缺少团队名称：--name <name>');
    const bindProject = requireOption('--bind-project', '缺少项目标识：--bind-project <slug>');
    const workDir = requireOption('--work-dir', '缺少工作目录：--work-dir <path>');
    const response = await client.request('/api/teams/create', {
      method: 'POST',
      body: {
        displayName,
        bindProject,
        workDir,
        harness: String(findOptionValue('--harness') || 'claudecode'),
        description: findOptionValue('--description') || undefined,
      },
    });
    return {
      ok: true,
      command: 'teams create',
      team: { displayName, bindProject, workDir },
      response,
    };
  }
  return error(
    `teams ${action}`,
    '用法：teams list | teams create --name <name> --bind-project <slug> --work-dir <path>'
  );
}

export async function printTeamsCommand() {
  let result;
  try {
    result = await runTeamsCommand();
  } catch (cause) {
    result = error(
      `teams ${commandArgs[1] || ''}`.trim(),
      cause instanceof Error ? cause.message : String(cause)
    );
  }
  if (jsonRequested) printJson(result, result.ok ? 0 : 1);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.command === 'teams list') {
    const rows = result.teams.map((team) => [
      team.displayName || team.teamName,
      team.isOnline ? '在线' : '离线',
      team.bindProject || team.teamName,
    ]);
    printCliRows(
      '本地团队',
      rows.length > 0 ? rows : [['状态', '暂无团队']],
      '在 AgentPanel 中管理运行时与智能体。'
    );
  } else {
    printCliRows(
      '团队已创建',
      [
        ['名称', result.team.displayName],
        ['项目', result.team.bindProject],
        ['目录', result.team.workDir],
      ],
      '团队已写入 AgentPanel；可在工作台配置本地 Direct CLI 运行时。'
    );
  }
  process.exit(0);
}
