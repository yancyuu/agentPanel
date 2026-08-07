// deliveriesCommand.mjs — approved local output inspection and optional GitHub delivery.
import { writeFile } from 'node:fs/promises';

import { commandArgs, findOptionValue, jsonRequested } from './env.mjs';
import { createPanelApiClient } from './panelApi.mjs';
import { printCliRows, printJson } from './terminal.mjs';

function requireOption(name, message) {
  const value = String(findOptionValue(name) || '').trim();
  if (!value) throw new Error(message);
  return value;
}

function commandError(command, message) {
  return { ok: false, command, error: message };
}

function archivePath(team, task) {
  return `/api/github-delivery/archive/${encodeURIComponent(team)}/${encodeURIComponent(task)}`;
}

export async function runDeliveriesCommand(
  rawArgs = commandArgs,
  { client = createPanelApiClient() } = {}
) {
  const action = rawArgs[1] || 'archive';
  if (action === 'archive' || action === 'zip') {
    const team = requireOption('--team', '缺少团队：--team <team>');
    const task = requireOption('--task', '缺少任务：--task <task-id>');
    if (action === 'archive') {
      const archive = await client.request(archivePath(team, task));
      return { ok: true, command: 'deliveries archive', team, task, archive };
    }
    const output = requireOption('--output', '下载 ZIP 需要目标文件：--output <path.zip>');
    const zip = await client.requestBinary(`${archivePath(team, task)}.zip`);
    await writeFile(output, zip, { flag: 'w' });
    return { ok: true, command: 'deliveries zip', team, task, output, bytes: zip.byteLength };
  }

  if (action !== 'github')
    return commandError(`deliveries ${action}`, '用法：deliveries archive|zip|github');
  const githubAction = rawArgs[2] || 'bindings';
  if (githubAction === 'bindings') {
    const bindings = await client.request('/api/github-delivery/bindings');
    return {
      ok: true,
      command: 'deliveries github bindings',
      bindings: Array.isArray(bindings) ? bindings : [],
    };
  }
  const agent = requireOption('--agent', '缺少智能体：--agent <name>');
  if (githubAction === 'bind') {
    const repository = requireOption('--repository', '缺少仓库：--repository <owner/repo>');
    const branch = findOptionValue('--branch') || undefined;
    const transport = findOptionValue('--transport') || undefined;
    if (transport && !['https', 'ssh'].includes(transport)) {
      return commandError('deliveries github bind', '--transport 必须是 https 或 ssh');
    }
    const binding = await client.request(
      `/api/github-delivery/bindings/${encodeURIComponent(agent)}`,
      {
        method: 'PUT',
        body: { repository, branch, transport },
      }
    );
    return { ok: true, command: 'deliveries github bind', binding };
  }
  if (githubAction === 'unbind') {
    await client.request(`/api/github-delivery/bindings/${encodeURIComponent(agent)}`, {
      method: 'DELETE',
    });
    return { ok: true, command: 'deliveries github unbind', agent };
  }
  if (githubAction === 'publish') {
    if (!rawArgs.includes('--yes')) {
      return commandError(
        'deliveries github publish',
        '发布会推送到远程 GitHub；请显式传入 --yes 确认。'
      );
    }
    const teamName = requireOption('--team', '缺少团队：--team <team>');
    const taskId = requireOption('--task', '缺少任务：--task <task-id>');
    const receipt = await client.request('/api/github-delivery/publish', {
      method: 'POST',
      body: { teamName, taskId, agentName: agent },
    });
    return { ok: true, command: 'deliveries github publish', receipt };
  }
  return commandError('deliveries github', '用法：deliveries github bindings|bind|unbind|publish');
}

export async function printDeliveriesCommand() {
  let result;
  try {
    result = await runDeliveriesCommand();
  } catch (cause) {
    result = commandError('deliveries', cause instanceof Error ? cause.message : String(cause));
  }
  if (jsonRequested) printJson(result, result.ok ? 0 : 1);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.command === 'deliveries archive') {
    printCliRows(
      '已批准的本地成果',
      [
        ['任务', result.task],
        ['标题', result.archive.title],
        ['版本', result.archive.versionId],
        ['目录', result.archive.versionDir],
      ],
      '本地成果是源成果；可用 deliveries zip 导出 ZIP。'
    );
  } else if (result.command === 'deliveries zip') {
    printCliRows(
      '成果 ZIP 已导出',
      [
        ['文件', result.output],
        ['字节', String(result.bytes)],
      ],
      '未向任何远程服务上传成果。'
    );
  } else if (result.command === 'deliveries github bindings') {
    const rows = result.bindings.map((binding) => [
      binding.agentName,
      binding.repository,
      binding.branch,
    ]);
    printCliRows(
      'GitHub 成果交付绑定',
      rows.length > 0 ? rows : [['状态', '暂无绑定']],
      '凭证仅使用本机 Git Credential Manager 或 SSH Key。'
    );
  } else if (result.command === 'deliveries github bind') {
    printCliRows(
      'GitHub 成果交付已绑定',
      [
        ['智能体', result.binding.agentName],
        ['仓库', result.binding.repository],
        ['分支', result.binding.branch],
      ],
      '未保存 Token 或私钥。'
    );
  } else if (result.command === 'deliveries github unbind') {
    printCliRows('GitHub 成果交付已解除绑定', [['智能体', result.agent]]);
  } else {
    printCliRows('GitHub 成果已发布', [
      ['仓库', result.receipt.repository],
      ['提交', result.receipt.commit],
      ['地址', result.receipt.url || '无公开链接'],
    ]);
  }
  process.exit(0);
}
