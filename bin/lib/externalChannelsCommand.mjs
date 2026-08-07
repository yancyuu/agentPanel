// externalChannelsCommand.mjs — CLI controls for optional Panel-managed channels.
import { commandArgs, jsonRequested } from './env.mjs';
import { createPanelApiClient } from './panelApi.mjs';
import { printCliRows, printJson } from './terminal.mjs';

function commandError(message) {
  return { ok: false, command: 'external-channels cc-connect', error: message };
}

function stateLabel(channel) {
  const labels = {
    disabled: '未启用（默认）',
    'restart-required': '设置已保存，重启后生效',
    starting: '启动中',
    running: '运行中',
    offline: '已启用，但当前离线',
  };
  return labels[channel.state] || channel.state;
}

export async function runExternalChannelsCommand(
  rawArgs = commandArgs,
  { client = createPanelApiClient() } = {}
) {
  const channel = rawArgs[1];
  const action = rawArgs[2] || 'status';
  if (channel !== 'cc-connect') {
    return commandError('仅支持外部渠道插件 cc-connect。');
  }
  if (!['status', 'enable', 'disable'].includes(action)) {
    return commandError('用法：external-channels cc-connect status|enable|disable');
  }

  const status =
    action === 'status'
      ? await client.request('/api/external-channels')
      : await client.request('/api/external-channels/cc-connect', {
          method: 'PUT',
          body: { enabled: action === 'enable' },
        });
  return {
    ok: true,
    command: `external-channels cc-connect ${action}`,
    ccConnect: status.ccConnect,
  };
}

export async function printExternalChannelsCommand() {
  let result;
  try {
    result = await runExternalChannelsCommand();
  } catch (error) {
    result = commandError(error instanceof Error ? error.message : String(error));
  }
  if (jsonRequested) printJson(result, result.ok ? 0 : 1);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  const channel = result.ccConnect;
  let rowState = 'off';
  if (channel.active) rowState = 'ok';
  else if (channel.enabled) rowState = 'warn';
  printCliRows(
    '外部渠道插件 · cc-connect',
    [
      ['状态', stateLabel(channel), rowState],
      ['开关', channel.enabled ? '已启用' : '默认关闭'],
      ['运行时', channel.active ? '运行中' : '不影响本地 Direct CLI'],
    ],
    channel.restartRequired
      ? '设置已保存。请重启 AgentPanel 后再配置或使用外部渠道。'
      : 'cc-connect 是可选外部渠道插件；本地 Direct CLI 无需启用它。'
  );
  process.exit(0);
}
