/**
 * Build command-list suggestions from workflow prompts (`.claude/commands/*.md`).
 *
 * Extracted from SystemManagerView so both the admin Loop console and each
 * team's Loop console can surface workflow commands — the team console loads
 * its own project's commands, so a digital worker's project-specific commands
 * appear alongside the global ones.
 */

import type { MentionSuggestion } from '@renderer/types/mention';
import type { WorkflowPromptSummary } from '@shared/types/systemManager';

function formatWorkflowCommand(prompt: WorkflowPromptSummary): string {
  return prompt.commandName ?? `/${prompt.filename.replace(/\.[^.]+$/, '')}`;
}

const KNOWN_HERMIT_WORKFLOW_DESCRIPTIONS: Record<string, string> = {
  'compliance-audit': '审计循环、连接器、hooks、worktrees 中的安全风险。',
  'connector-scan': '扫描 MCP、插件、连接器和外部工具配置。',
  'create-team': '通过 AgentPanel HTTP API 快速创建团队，不自动启动 Agent。',
  'daily-folder-hygiene': '只读检查工作区临时文件、陈旧报告、脏 worktree 和可清理产物。',
  'daily-loop': '执行每日 Loop 巡检，把诊断、摘要和改进建议串成闭环。',
  'daily-memory-conflict-check': '检查 CLAUDE、AGENTS、记忆和设置里的重复、过期、冲突指令。',
  'daily-verifier': '验证近期任务、报告和循环输出是否真实完成且可复现。',
  'daily-workflow-extraction': '从近期会话中提炼可复用的 prompt、workflow 和操作流程。',
  doctor: '诊断 AgentPanel、Claude Code、hermit-bridge 和 Loop runtime 健康。',
  'loop-design': '根据现有资产设计一个可运行、可验证、可恢复的 Agent 循环。',
  'loop-scan': '扫描自动化、工作树、技能、连接器、子 Agent 和状态资产。',
  'memory-config-health': '检查 loop 相关 memory、配置、commands、skills 和状态分层。',
  'self-improve': '从对话、任务和配置中发现可循环化的系统性改进机会。',
  'state-scan': '扫描 .omc/state、sessions、reports 和 loop 可恢复状态。',
  summary: '生成当前工作区的 Loop Ops 摘要和下一步建议。',
  'usage-report': '汇总会话、子 Agent、工作树和循环吞吐线索。',
  'worktree-scan': '扫描 agent worktrees、并行工作区、脏状态和清理候选。',
};

function normalizeWorkflowKey(value: string): string {
  return value
    .trim()
    .replace(/^\//, '')
    .replace(/^[^:]+:/, '')
    .replace(/\.legacy-workflow(?:-\d+)?$/u, '')
    .toLowerCase();
}

function resolveWorkflowDescription(prompt: WorkflowPromptSummary, command: string): string {
  const description = prompt.description?.trim();
  if (description) return description;

  const commandDescription = KNOWN_HERMIT_WORKFLOW_DESCRIPTIONS[normalizeWorkflowKey(command)];
  if (commandDescription) return commandDescription;

  const filenameDescription =
    KNOWN_HERMIT_WORKFLOW_DESCRIPTIONS[
      normalizeWorkflowKey(prompt.filename.replace(/\.[^.]+$/, ''))
    ];
  if (filenameDescription) return filenameDescription;

  return '执行当前项目中的 Claude Code 指令文件。';
}

function formatWorkflowSubtitle(prompt: WorkflowPromptSummary): string | undefined {
  const label = prompt.label?.trim();
  const safety = prompt.safety?.trim();
  if (!safety || safety === 'unknown') return label || undefined;
  return label ? `${label} · ${safety}` : safety;
}

/**
 * Convert a workflow prompt into a command suggestion carrying the
 * `workflowPromptId` / `workflowPromptFolder` metadata that the submit path
 * uses to inject the prompt's full body (instead of sending the raw `/name`).
 */
export function buildWorkflowCommandSuggestion(
  prompt: WorkflowPromptSummary,
  idPrefix = 'workflow'
): MentionSuggestion {
  const command = formatWorkflowCommand(prompt) as `/${string}`;
  const commandName = command.slice(1);
  const description = resolveWorkflowDescription(prompt, command);
  const subtitle = formatWorkflowSubtitle(prompt);
  return {
    id: `${idPrefix}:${prompt.id}`,
    name: commandName,
    type: 'command',
    command,
    insertText: commandName,
    workflowPromptId: prompt.id,
    workflowPromptFolder: prompt.folder,
    description,
    subtitle,
    searchText: [
      prompt.label,
      description,
      prompt.category,
      prompt.safety && prompt.safety !== 'unknown' ? prompt.safety : undefined,
      prompt.filename,
      command,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** Reserved runtime namespaces that must never appear as user-runnable console commands. */
const RESERVED_ADMIN_COMMAND_SUFFIXES = [':loop', ':system'] as const;

function isAdminCommandReserved(name: string): boolean {
  const raw = name.trim().toLowerCase().replace(/^\//, '');
  return (
    raw === 'loop' ||
    raw === 'system' ||
    RESERVED_ADMIN_COMMAND_SUFFIXES.some((suffix) => raw.endsWith(suffix))
  );
}

/**
 * Merge local-project workflow suggestions with capability-pack ("Claude common")
 * suggestions for the 诊断 console. Local-project commands always take
 * priority — an operator's own `.claude/commands` surface ahead of the builtin
 * pack commands — and the reserved `loop` / `system` runtime namespaces are
 * dropped so they cannot be dispatched from the console.
 */
export function mergeAdminCommandSuggestions(
  localSuggestions: MentionSuggestion[],
  packSuggestions: MentionSuggestion[]
): MentionSuggestion[] {
  return [...localSuggestions, ...packSuggestions].filter(
    (suggestion) => !isAdminCommandReserved(suggestion.command ?? suggestion.name)
  );
}
