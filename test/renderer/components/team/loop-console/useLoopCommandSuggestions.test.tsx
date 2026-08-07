import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLoopCommandSuggestions } from '@renderer/components/team/loop-console/useLoopCommandSuggestions';
import { api } from '@renderer/api';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { SkillCatalogItem } from '@shared/types/extensions';

vi.mock('@renderer/api', () => ({
  api: {
    systemManager: {
      listWorkflowPrompts: vi.fn(),
    },
    skills: {
      list: vi.fn(),
    },
  },
}));

vi.mock('@renderer/hooks/useTeamSuggestions', () => ({
  useTeamSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));

const listWorkflowPromptsMock = vi.mocked(api.systemManager.listWorkflowPrompts);
const listSkillsMock = vi.mocked(api.skills!.list);

function projectSkill(name: string, folderName = name): SkillCatalogItem {
  return {
    id: `/project/.claude/skills/${folderName}`,
    name,
    folderName,
    description: `Project skill ${name}`,
    scope: 'project',
    rootKind: 'claude',
    sourceType: 'filesystem',
    projectRoot: '/Users/yancyyu/.hermit',
    discoveryRoot: '/Users/yancyyu/.hermit/.claude/skills',
    skillDir: `/Users/yancyyu/.hermit/.claude/skills/${folderName}`,
    skillFile: `/Users/yancyyu/.hermit/.claude/skills/${folderName}/SKILL.md`,
    metadata: {},
    invocationMode: 'manual-only',
    flags: { hasScripts: false, hasReferences: false, hasAssets: false },
    isValid: true,
    issues: [],
    modifiedAt: 1_718_900_000,
  };
}

function scopedSuggestion(name: string): MentionSuggestion {
  return {
    id: `scoped:${name}`,
    name,
    type: 'command',
    command: `/${name}` as `/${string}`,
    insertText: name,
    description: `Run ${name}`,
    subtitle: 'scoped',
    searchText: name,
  };
}

function Probe({ onCommands }: { onCommands: (commands: string[]) => void }): React.JSX.Element {
  const { commandSuggestions } = useLoopCommandSuggestions({
    teamName: 'system-manager',
    members: [],
    projectPath: '/Users/yancyyu/.hermit',
    commandSuggestions: [scopedSuggestion('doctor')],
  });

  React.useEffect(() => {
    onCommands(commandSuggestions.map((suggestion) => suggestion.command ?? suggestion.name));
  }, [commandSuggestions, onCommands]);

  return React.createElement('div');
}

describe('useLoopCommandSuggestions', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    document.body.innerHTML = '';
    listWorkflowPromptsMock.mockReset();
    listSkillsMock.mockReset();
    listSkillsMock.mockResolvedValue([]);
  });

  it('prioritizes current project workflows and skills before scoped and base commands', async () => {
    listSkillsMock.mockResolvedValue([
      projectSkill('Code Review', 'code-review'),
      projectSkill('Crawler CLI', 'crawler-cli'),
      projectSkill('Doctor Override', 'doctor'),
    ]);
    listWorkflowPromptsMock.mockResolvedValue({
      folder: '/Users/yancyyu/.hermit/.claude/commands',
      warnings: [],
      prompts: [
        {
          id: 'loop-scan',
          label: 'Loop Scan',
          filename: 'loop-scan.md',
          path: '/Users/yancyyu/.hermit/.claude/commands/loop-scan.md',
          folder: '/Users/yancyyu/.hermit/.claude/commands',
          sizeBytes: 120,
          updatedAt: '2026-06-21T00:00:00.000Z',
          commandName: '/loop-scan',
          description: 'Scan Loop assets',
        },
      ],
    });

    const seen: string[][] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<Probe onCommands={(commands) => seen.push(commands)} />);
    });

    await vi.waitFor(() => {
      expect(listWorkflowPromptsMock).toHaveBeenCalledWith('/Users/yancyyu/.hermit/.claude/commands');
      expect(listSkillsMock).toHaveBeenCalledWith('/Users/yancyyu/.hermit');
      expect(seen.at(-1)).toContain('/crawler-cli');
    });

    const resolvedCommands = seen.find((commands) => commands.includes('/crawler-cli'));
    expect(resolvedCommands?.slice(0, 4)).toEqual([
      '/loop-scan',
      '/code-review',
      '/crawler-cli',
      '/doctor',
    ]);
    // The project skill /doctor beats the scoped /doctor because project assets have higher priority.
    expect(resolvedCommands?.filter((command) => command === '/doctor')).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });
});
