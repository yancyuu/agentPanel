import type { SlashCommandMeta } from '@shared/types/team';

export interface KnownSlashCommandDefinition {
  name: string;
  command: `/${string}`;
  description: string;
}

export interface ParsedStandaloneSlashCommand {
  name: string;
  command: `/${string}`;
  args?: string;
  raw: string;
  startIndex: number;
  endIndex: number;
}

const SLASH_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9:-]{0,63}$/i;
const STANDALONE_SLASH_COMMAND_PATTERN = /^\/([a-z][a-z0-9:-]{0,63})(?:\s+([\s\S]*\S))?$/i;

export const KNOWN_SLASH_COMMANDS: readonly KnownSlashCommandDefinition[] = [
  {
    name: 'compact',
    command: '/compact',
    description: '压缩当前对话，并可附加需要保留的重点说明。',
  },
  {
    name: 'clear',
    command: '/clear',
    description: '清空当前对话历史，释放上下文。',
  },
  {
    name: 'reset',
    command: '/reset',
    description: '/clear 的别名：清空当前对话历史。',
  },
  {
    name: 'new',
    command: '/new',
    description: '/clear 的别名：开始一轮新的对话。',
  },
  {
    name: 'plan',
    command: '/plan',
    description: '进入计划模式，可附加要规划的任务描述。',
  },
  {
    name: 'model',
    command: '/model',
    description: '选择或切换当前会话使用的 Claude 模型。',
  },
  {
    name: 'effort',
    command: '/effort',
    description: '设置当前会话的推理强度。',
  },
  {
    name: 'fast',
    command: '/fast',
    description: '开启或关闭快速模式。',
  },
  {
    name: 'cost',
    command: '/cost',
    description: '查看本次会话的 token 与费用统计。',
  },
  {
    name: 'usage',
    command: '/usage',
    description: '查看套餐用量、额度和限流状态。',
  },
  {
    name: 'workers',
    command: '/workers',
    description: '列出当前可发现的数字员工。',
  },
] as const;

const KNOWN_SLASH_COMMANDS_BY_NAME = new Map(
  KNOWN_SLASH_COMMANDS.map((command) => [command.name.toLowerCase(), command] as const)
);

export function getKnownSlashCommand(name: string): KnownSlashCommandDefinition | null {
  return KNOWN_SLASH_COMMANDS_BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

export function isSupportedSlashCommandName(name: string): boolean {
  return SLASH_COMMAND_NAME_PATTERN.test(name.trim());
}

export function buildSlashCommandMeta(
  name: string,
  args?: string,
  command?: `/${string}`
): SlashCommandMeta {
  const normalizedName = name.trim().toLowerCase();
  const normalizedCommand = command ?? `/${normalizedName}`;
  const known = getKnownSlashCommand(normalizedName);
  return {
    name: normalizedName,
    command: normalizedCommand,
    ...(args ? { args } : {}),
    ...(known ? { knownDescription: known.description } : {}),
  };
}

export function buildStandaloneSlashCommandMeta(text: string): SlashCommandMeta | null {
  const parsed = parseStandaloneSlashCommand(text);
  if (!parsed) return null;
  return buildSlashCommandMeta(parsed.name, parsed.args, parsed.command);
}

export function parseStandaloneSlashCommand(text: string): ParsedStandaloneSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const match = STANDALONE_SLASH_COMMAND_PATTERN.exec(trimmed);
  if (!match) return null;

  const name = match[1].toLowerCase();
  const args = match[2]?.trim();
  const startIndex = text.indexOf(trimmed);
  const endIndex = startIndex + trimmed.length;

  return {
    name,
    command: `/${name}`,
    args: args || undefined,
    raw: trimmed,
    startIndex,
    endIndex,
  };
}
