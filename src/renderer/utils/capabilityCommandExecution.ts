import { api } from '@renderer/api';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';

import { resolveSlashCommand } from './slashCommandRegistry';

import type { CapabilityScope, RegisteredSlashCommand } from '@shared/types/extensions';
import type { SlashCommandMeta } from '@shared/types/team';

export interface SelectedCapabilityCommandRef {
  commandRef: string;
  command: `/${string}`;
}

export interface ResolvedCapabilityCommandInput {
  command: RegisteredSlashCommand;
  raw: string;
  args?: string;
}

export interface ExpandedCapabilityCommand {
  text: string;
  summary: string;
  slashCommand: SlashCommandMeta;
  registered: RegisteredSlashCommand;
}

export interface ResolveCapabilityCommandInputOptions {
  shadowedAliases?: ReadonlySet<string>;
}

export interface ResolveCapabilityCommandInputResult {
  status: 'not-found' | 'resolved' | 'conflict';
  resolved?: ResolvedCapabilityCommandInput;
  conflictLabel?: string;
}

function selectedCommandStillMatches(
  parsedCommand: `/${string}`,
  selected?: SelectedCapabilityCommandRef | null
): boolean {
  return Boolean(
    selected?.commandRef && selected.command.toLowerCase() === parsedCommand.toLowerCase()
  );
}

function appendArgsToPrompt(prompt: string, args?: string): string {
  const trimmedPrompt = prompt.trim();
  const trimmedArgs = args?.trim();
  if (!trimmedArgs) return trimmedPrompt;
  return `${trimmedPrompt}\n\nUser arguments:\n${trimmedArgs}`;
}

export function resolveCapabilityCommandInput(
  registry: readonly RegisteredSlashCommand[],
  text: string,
  selected?: SelectedCapabilityCommandRef | null,
  options: ResolveCapabilityCommandInputOptions = {}
): ResolveCapabilityCommandInputResult {
  const parsed = parseStandaloneSlashCommand(text);
  if (!parsed) return { status: 'not-found' };

  const selectedRef = selectedCommandStillMatches(parsed.command, selected)
    ? selected?.commandRef
    : undefined;
  if (!selectedRef && options.shadowedAliases?.has(parsed.name)) {
    return { status: 'not-found' };
  }
  const result = resolveSlashCommand(registry, parsed.command, selectedRef);
  if (result.status === 'resolved' && result.command) {
    return {
      status: 'resolved',
      resolved: {
        command: result.command,
        raw: parsed.raw,
        args: parsed.args,
      },
    };
  }
  if (result.status === 'conflict') {
    return {
      status: 'conflict',
      conflictLabel: '能力包命令存在冲突，请从菜单选择带 namespace 的命令。',
    };
  }
  return { status: 'not-found' };
}

export async function expandCapabilityCommand(
  resolved: ResolvedCapabilityCommandInput,
  scope: CapabilityScope
): Promise<ExpandedCapabilityCommand> {
  if (!api.capabilityPacks) {
    throw new Error('Capability packs API is unavailable');
  }

  const result = await api.capabilityPacks.getCommandPrompt({
    canonicalId: resolved.command.canonicalId,
    scope,
  });
  const command = result.command;
  const slashCommand: SlashCommandMeta = {
    name: command.alias,
    command: command.namespacedSlash,
    args: resolved.args,
    knownDescription: command.command.description ?? command.command.title,
  };
  return {
    text: appendArgsToPrompt(result.prompt, resolved.args),
    summary: command.command.title,
    slashCommand,
    registered: command,
  };
}
