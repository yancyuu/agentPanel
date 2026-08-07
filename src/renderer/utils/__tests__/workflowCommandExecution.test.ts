import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  readWorkflowPrompt: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    systemManager: {
      readWorkflowPrompt: hoisted.readWorkflowPrompt,
    },
  },
}));

import {
  appendArgsToPrompt,
  expandWorkflowCommand,
  resolveWorkflowCommandInput,
} from '../workflowCommandExecution';

import type { MentionSuggestion } from '@renderer/types/mention';

function workflowSuggestion(overrides: Partial<MentionSuggestion> = {}): MentionSuggestion {
  return {
    id: 'admin-workflow:prompt-loop-scan',
    name: 'loop-scan',
    type: 'command',
    command: '/loop-scan',
    insertText: 'loop-scan',
    workflowPromptId: 'prompt-loop-scan',
    workflowPromptFolder: '/workspace/.claude/commands',
    description: '运行 Loop Scan',
    ...overrides,
  };
}

describe('appendArgsToPrompt', () => {
  it('trims the prompt and returns it unchanged when there are no args', () => {
    expect(appendArgsToPrompt('  do the thing  ')).toBe('do the thing');
  });

  it('appends trimmed args under a User arguments section', () => {
    expect(appendArgsToPrompt('do the thing', '  --scope src  ')).toBe(
      'do the thing\n\nUser arguments:\n--scope src'
    );
  });

  it('ignores whitespace-only args', () => {
    expect(appendArgsToPrompt('do the thing', '   ')).toBe('do the thing');
  });
});

describe('resolveWorkflowCommandInput', () => {
  it('returns null for non-slash text', () => {
    expect(resolveWorkflowCommandInput([workflowSuggestion()], 'just a message')).toBeNull();
  });

  it('returns null when no suggestion matches the command', () => {
    expect(resolveWorkflowCommandInput([workflowSuggestion()], '/unknown-cmd')).toBeNull();
  });

  it('matches the typed command against a workflow suggestion and captures args', () => {
    const resolved = resolveWorkflowCommandInput([workflowSuggestion()], '/loop-scan --scope src');
    expect(resolved).toEqual({
      folder: '/workspace/.claude/commands',
      id: 'prompt-loop-scan',
      command: '/loop-scan',
      args: '--scope src',
    });
  });

  it('matches case-insensitively', () => {
    const resolved = resolveWorkflowCommandInput([workflowSuggestion()], '/Loop-Scan');
    expect(resolved?.command).toBe('/loop-scan');
  });

  it('ignores suggestions that lack workflowPromptId / workflowPromptFolder', () => {
    const plainSuggestion = workflowSuggestion({
      workflowPromptId: undefined,
      workflowPromptFolder: undefined,
    });
    expect(resolveWorkflowCommandInput([plainSuggestion], '/loop-scan')).toBeNull();
  });
});

describe('expandWorkflowCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads prompt content via readWorkflowPrompt and formats an injectable body with args', async () => {
    hoisted.readWorkflowPrompt.mockResolvedValue({
      prompt: {
        id: 'prompt-loop-scan',
        label: 'Loop Scan',
        filename: 'loop-scan.md',
        path: '/workspace/.claude/commands/loop-scan.md',
        folder: '/workspace/.claude/commands',
        sizeBytes: 1234,
        updatedAt: '2026-06-13T00:00:00.000Z',
        source: 'claude-command',
        commandName: '/loop-scan',
        description: 'Run loop scan',
        category: 'loop',
        safety: 'read-only',
        builtin: true,
        order: 5,
      },
      content: 'You are a loop scan agent. Inspect the repo.',
    });

    const expanded = await expandWorkflowCommand({
      folder: '/workspace/.claude/commands',
      id: 'prompt-loop-scan',
      command: '/loop-scan',
      args: '--scope src',
    });

    expect(hoisted.readWorkflowPrompt).toHaveBeenCalledWith(
      '/workspace/.claude/commands',
      'prompt-loop-scan'
    );
    // The raw command name must NOT be the body — the full prompt content is injected,
    // with args appended. This is the exact behavior that was missing before.
    expect(expanded.text).toBe(
      'You are a loop scan agent. Inspect the repo.\n\nUser arguments:\n--scope src'
    );
    expect(expanded.summary).toBe('Loop Scan');
    expect(expanded.slashCommand).toEqual({
      name: 'loop-scan',
      command: '/loop-scan',
      args: '--scope src',
      knownDescription: 'Run loop scan',
    });
  });

  it('falls back to the resolved command name when the prompt has no commandName', async () => {
    hoisted.readWorkflowPrompt.mockResolvedValue({
      prompt: {
        id: 'prompt-doctor',
        label: 'Doctor',
        filename: 'doctor.md',
        path: '/workspace/.claude/commands/doctor.md',
        folder: '/workspace/.claude/commands',
        sizeBytes: 10,
        updatedAt: '2026-06-13T00:00:00.000Z',
      },
      content: 'Run diagnostics.',
    });

    const expanded = await expandWorkflowCommand({
      folder: '/workspace/.claude/commands',
      id: 'prompt-doctor',
      command: '/doctor',
    });

    expect(expanded.slashCommand.command).toBe('/doctor');
    expect(expanded.slashCommand.name).toBe('doctor');
    expect(expanded.slashCommand.knownDescription).toBe('Doctor');
  });

  it('propagates read failures so the caller can surface them', async () => {
    hoisted.readWorkflowPrompt.mockRejectedValue(new Error('prompt not found'));

    await expect(
      expandWorkflowCommand({
        folder: '/workspace/.claude/commands',
        id: 'prompt-missing',
        command: '/missing',
      })
    ).rejects.toThrow('prompt not found');
  });
});
