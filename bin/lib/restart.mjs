// restart.mjs — restart the local Workbench so saved plugin settings take effect.
import { startDaemon, stopDaemon } from './daemon.mjs';
import { port } from './env.mjs';
import { printCliRows } from './terminal.mjs';
import { BRAND, brandCommand } from '../branding.mjs';

export async function runRestart({ quiet = false } = {}) {
  const url = `http://127.0.0.1:${port}`;
  await stopDaemon({ exitOnDone: false, quiet: true });
  const daemon = startDaemon({ exitOnDone: false, quiet: true, childArgs: [] });
  const result = { ok: true, command: 'restart', url, daemon };

  if (!quiet) {
    printCliRows(
      `${BRAND.stylizedName} 已重启`,
      [
        [
          '本地工作台',
          daemon.started ? `已重启 (pid ${daemon.pid})` : `已在运行 (pid ${daemon.pid})`,
          'ok',
        ],
        ['地址', url, 'info'],
      ],
      `插件设置已重新加载。管理服务：${brandCommand('services')}。`
    );
  }
  return result;
}
