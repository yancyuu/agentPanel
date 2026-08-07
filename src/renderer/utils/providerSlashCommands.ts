import { KNOWN_SLASH_COMMANDS } from '@shared/utils/slashCommands';

import type { TeamProviderId } from '@shared/types';
import type { KnownSlashCommandDefinition } from '@shared/utils/slashCommands';

const CODEX_SLASH_COMMAND_SUGGESTIONS: readonly KnownSlashCommandDefinition[] = [
  {
    name: 'model',
    command: '/model',
    description: '选择当前会话使用的模型。',
  },
  {
    name: 'fast',
    command: '/fast',
    description: '开启或关闭快速模式。',
  },
  {
    name: 'permissions',
    command: '/permissions',
    description: '调整工具和命令的审批要求。',
  },
  {
    name: 'plan',
    command: '/plan',
    description: '进入计划模式，可附加要规划的任务。',
  },
  {
    name: 'review',
    command: '/review',
    description: '让 Codex 审查当前工作区改动。',
  },
  {
    name: 'diff',
    command: '/diff',
    description: '查看当前 Git diff，包括未跟踪文件。',
  },
  {
    name: 'status',
    command: '/status',
    description: '查看会话配置和 token 使用情况。',
  },
  {
    name: 'mention',
    command: '/mention',
    description: '把文件或文件夹附加到对话。',
  },
  {
    name: 'apps',
    command: '/apps',
    description: '浏览可用应用和连接器。',
  },
  {
    name: 'plugins',
    command: '/plugins',
    description: '浏览和管理已安装插件。',
  },
  {
    name: 'agent',
    command: '/agent',
    description: '切换到另一个 agent 线程。',
  },
  {
    name: 'personality',
    command: '/personality',
    description: '调整当前线程的 Codex 回复风格。',
  },
  {
    name: 'compact',
    command: '/compact',
    description: '压缩对话以释放 token。',
  },
  {
    name: 'clear',
    command: '/clear',
    description: '清空终端并开始新的聊天。',
  },
  {
    name: 'new',
    command: '/new',
    description: '在当前会话中开始新对话。',
  },
  {
    name: 'copy',
    command: '/copy',
    description: '复制最近一次完成的 Codex 输出。',
  },
  {
    name: 'fork',
    command: '/fork',
    description: '把当前对话 fork 到新线程。',
  },
  {
    name: 'resume',
    command: '/resume',
    description: '恢复之前的对话。',
  },
  {
    name: 'quit',
    command: '/quit',
    description: '退出 CLI。',
  },
  {
    name: 'exit',
    command: '/exit',
    description: '退出 CLI。',
  },
] as const;

export function getSuggestedSlashCommandsForProvider(
  providerId?: TeamProviderId
): readonly KnownSlashCommandDefinition[] {
  if (providerId === 'codex') {
    return CODEX_SLASH_COMMAND_SUGGESTIONS;
  }

  return KNOWN_SLASH_COMMANDS;
}
