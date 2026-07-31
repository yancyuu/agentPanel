import type { MentionSuggestion } from '@renderer/types/mention';

export interface LoopCommandShortcut {
  id: string;
  name: string;
  command: `/${string}`;
  insertText: string;
  description: string;
  searchText: string;
  category: 'monitoring' | 'summary' | 'hygiene' | 'diagnostic' | 'workflow';
}

// NOTE: the native `/loop` shortcuts were removed from the command palette —
// in the team console `/loop` is not a native command (it falls through to a
// plain lead message and never replies), so offering it caused confusion. The
// real loop feature will be reintroduced later. Only the `/hermit:*` workflows
// below remain as quick commands.
const LOOP_COMMAND_SHORTCUTS: LoopCommandShortcut[] = [
  {
    id: 'ops-workflow:doctor',
    name: 'hermit:doctor',
    command: '/hermit:doctor',
    insertText: 'hermit:doctor 检查 AgentCLI 安装、运行时、hermit-bridge、MCP 和常见配置问题',
    description: '诊断 AgentCLI / runtime / hermit-bridge 健康状态',
    searchText: 'doctor hermit diagnose health runtime hermit-bridge mcp 诊断 健康 配置',
    category: 'diagnostic',
  },
  {
    id: 'ops-workflow:loop-scan',
    name: 'hermit:loop-scan',
    command: '/hermit:loop-scan',
    insertText: 'hermit:loop-scan 扫描 Loop 资产、推荐循环和可自动化的团队运维动作',
    description: '扫描 Loop assets 和推荐运维循环',
    searchText: 'loop scan hermit assets workflows recommended loops 扫描 推荐 循环',
    category: 'workflow',
  },
  {
    id: 'ops-workflow:summary',
    name: 'hermit:summary',
    command: '/hermit:summary',
    insertText: 'hermit:summary 总结当前团队进展、阻塞、风险和下一步建议',
    description: '生成团队/会话摘要和下一步建议',
    searchText: 'summary hermit status progress blockers risks next steps 摘要 进展 阻塞 风险',
    category: 'summary',
  },
  {
    id: 'ops-workflow:daily-folder-hygiene',
    name: 'hermit:daily-folder-hygiene',
    command: '/hermit:daily-folder-hygiene',
    insertText: 'hermit:daily-folder-hygiene 只读检查临时文件、陈旧报告、脏 worktree 和可清理产物',
    description: '只读检查工作区卫生和可清理项',
    searchText: 'daily folder hygiene hermit temp stale reports dirty worktree cleanup 工作区 清理',
    category: 'hygiene',
  },
  {
    id: 'ops-workflow:daily-memory-conflict-check',
    name: 'hermit:daily-memory-conflict-check',
    command: '/hermit:daily-memory-conflict-check',
    insertText:
      'hermit:daily-memory-conflict-check 检查 CLAUDE、AGENTS、memory、settings 的重复或冲突指令',
    description: '检查记忆/配置/指令冲突',
    searchText:
      'daily memory conflict hermit claude agents settings duplicate instructions 记忆 冲突',
    category: 'hygiene',
  },
  {
    id: 'ops-workflow:daily-workflow-extraction',
    name: 'hermit:daily-workflow-extraction',
    command: '/hermit:daily-workflow-extraction',
    insertText:
      'hermit:daily-workflow-extraction 从近期工作中提炼可复用 workflow、prompt 和自动化建议',
    description: '提炼可复用 workflow/prompt',
    searchText: 'daily workflow extraction hermit reusable prompt automation 提炼 复用 自动化',
    category: 'workflow',
  },
  {
    id: 'ops-workflow:worktree-scan',
    name: 'hermit:worktree-scan',
    command: '/hermit:worktree-scan',
    insertText: 'hermit:worktree-scan 只读检查脏 worktree、陈旧分支和需要用户确认的清理项',
    description: '只读检查 worktree/分支清理风险',
    searchText: 'worktree scan hermit dirty stale branch cleanup readonly worktree 分支 清理',
    category: 'diagnostic',
  },
];

export function getLoopCommandShortcuts(): LoopCommandShortcut[] {
  return LOOP_COMMAND_SHORTCUTS;
}

export function getLoopShortcutMentionSuggestions(): MentionSuggestion[] {
  return LOOP_COMMAND_SHORTCUTS.map((shortcut) => ({
    id: shortcut.id,
    name: shortcut.name,
    type: 'command',
    command: shortcut.command,
    insertText: shortcut.insertText,
    description: shortcut.description,
    subtitle: shortcut.description,
    searchText: `${shortcut.searchText} ${shortcut.category}`,
  }));
}

export function getLoopShortcutSuggestions(): MentionSuggestion[] {
  return getLoopShortcutMentionSuggestions();
}
