/**
 * Load a team project's `.claude/commands/*.md` workflow prompts and expose them
 * as command suggestions for the Loop console.
 *
 * The team Loop console previously only showed global shortcuts + capability
 * packs, so a project's own commands never appeared. This mirrors the admin
 * console's workflow loading, scoped to the team's project path.
 */
import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { buildWorkflowCommandSuggestion } from '@renderer/utils/workflowCommandSuggestions';

import type { MentionSuggestion } from '@renderer/types/mention';

const EMPTY: MentionSuggestion[] = [];

function workspaceWorkflowFolders(workspacePath: string): string[] {
  const root = workspacePath.replace(/[\\/]+$/, '');
  return [`${root}/.claude/commands`];
}

function useWorkflowCommandFolders(
  folders: readonly string[] | null | undefined,
  idPrefix: string
): MentionSuggestion[] {
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>(EMPTY);
  const folderKey =
    folders
      ?.map((folder) => folder.trim())
      .filter(Boolean)
      .join('\n') ?? '';

  useEffect(() => {
    const trimmedFolders = folderKey.split('\n').filter(Boolean);
    if (!trimmedFolders.length) {
      setSuggestions(EMPTY);
      return;
    }
    let cancelled = false;
    void (async () => {
      const seen = new Set<string>();
      const next: MentionSuggestion[] = [];
      for (const folder of trimmedFolders) {
        try {
          const result = await api.systemManager.listWorkflowPrompts(folder);
          if (cancelled) return;
          for (const prompt of result.prompts) {
            const suggestion = buildWorkflowCommandSuggestion(prompt, idPrefix);
            const key = suggestion.command ?? suggestion.id;
            if (seen.has(key)) continue;
            seen.add(key);
            next.push(suggestion);
          }
        } catch {
          // Missing command/workflow folders are normal — the workspace simply has no commands there.
        }
      }
      if (!cancelled) setSuggestions(next.length ? next : EMPTY);
    })();
    return () => {
      cancelled = true;
    };
  }, [folderKey, idPrefix]);

  return suggestions;
}

export function useProjectWorkflowCommands(projectPath?: string | null): MentionSuggestion[] {
  const trimmed = projectPath?.trim();
  return useWorkflowCommandFolders(
    trimmed ? workspaceWorkflowFolders(trimmed) : null,
    'team-workflow'
  );
}
