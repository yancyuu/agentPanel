// doctorCommand.mjs — read-only diagnostics for the local Workbench lifecycle.
import { hermitHome, jsonRequested, port } from './env.mjs';
import { collectDaemonStatus } from './daemon.mjs';
import { printCliRows, printJson } from './terminal.mjs';

export async function printDoctor() {
  const daemon = await collectDaemonStatus();
  const result = {
    ok: true,
    command: 'doctor',
    home: hermitHome,
    workbench: {
      running: Boolean(daemon.running),
      pid: daemon.pid || null,
      url: daemon.server?.url || daemon.url || `http://127.0.0.1:${port}`,
    },
  };
  if (jsonRequested) printJson(result);
  else {
    printCliRows(
      '本地诊断',
      [
        [
          '工作台',
          result.workbench.running ? '运行中' : '未运行',
          result.workbench.running ? 'ok' : 'off',
        ],
        ['地址', result.workbench.url],
        ['数据目录', result.home],
      ],
      '此诊断不会读取或上传个人凭证。'
    );
  }
  process.exit(0);
}
