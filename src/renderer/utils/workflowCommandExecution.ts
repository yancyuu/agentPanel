import { api } from '@renderer/api';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { WorkflowPromptSummary } from '@shared/types/systemManager';
import type { SlashCommandMeta } from '@shared/types/team';

export interface ResolvedWorkflowCommand {
  folder: string;
  id: string;
  command: `/${string}`;
  args?: string;
}

export interface ExpandedWorkflowCommand {
  text: string;
  summary: string;
  slashCommand: SlashCommandMeta;
  prompt: WorkflowPromptSummary;
}

/**
 * Append trailing user arguments to a prompt body. Mirrors the capability-pack
 * expansion convention so workflow prompts and capability commands format args
 * identically downstream.
 */
export function appendArgsToPrompt(prompt: string, args?: string): string {
  const trimmedPrompt = prompt.trim();
  const trimmedArgs = args?.trim();
  if (!trimmedArgs) return trimmedPrompt;
  return `${trimmedPrompt}\n\nUser arguments:\n${trimmedArgs}`;
}

/**
 * Resolve a typed slash command against workflow-prompt suggestions.
 *
 * Workflow suggestions (built from `.claude/commands/*.md` via WorkflowPromptService)
 * carry `workflowPromptId` + `workflowPromptFolder` but no `commandRef`, so they are
 * invisible to the capability-pack resolver. This resolver finds the matching prompt
 * so its full content can be loaded and injected — otherwise only the raw `/name`
 * text is sent and the workflow never actually runs.
 */
export function resolveWorkflowCommandInput(
  suggestions: readonly MentionSuggestion[],
  text: string
): ResolvedWorkflowCommand | null {
  const parsed = parseStandaloneSlashCommand(text);
  if (!parsed) return null;

  const match = suggestions.find(
    (suggestion) =>
      suggestion.workflowPromptId &&
      suggestion.workflowPromptFolder &&
      typeof suggestion.command === 'string' &&
      suggestion.command.toLowerCase() === parsed.command.toLowerCase()
  );
  if (!match?.workflowPromptFolder || !match.workflowPromptId) return null;

  return {
    folder: match.workflowPromptFolder,
    id: match.workflowPromptId,
    command: parsed.command,
    args: parsed.args,
  };
}

/**
 * Load the full prompt content for a resolved workflow command and format it as
 * an injectable message body. Parallel to `expandCapabilityCommand`.
 */
export async function expandWorkflowCommand(
  resolved: ResolvedWorkflowCommand
): Promise<ExpandedWorkflowCommand> {
  if (!api.systemManager) {
    throw new Error('System manager API is unavailable');
  }

  const { prompt, content } = await api.systemManager.readWorkflowPrompt(
    resolved.folder,
    resolved.id
  );
  const commandName = prompt.commandName ?? resolved.command;
  const slashCommand: SlashCommandMeta = {
    name: commandName.replace(/^\/+/, ''),
    command: commandName.startsWith('/') ? (commandName as `/${string}`) : `/${commandName}`,
    args: resolved.args,
    knownDescription: prompt.description ?? prompt.label,
  };

  return {
    text: appendArgsToPrompt(content, resolved.args),
    summary: prompt.label,
    slashCommand,
    prompt,
  };
}
