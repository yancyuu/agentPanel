import { describe, expect, it } from 'vitest';

import { buildWorkflowCommandSuggestion } from '../workflowCommandSuggestions';

import type { WorkflowPromptSummary } from '@shared/types/systemManager';

function prompt(overrides: Partial<WorkflowPromptSummary> = {}): WorkflowPromptSummary {
  return {
    id: 'prompt-loop-scan',
    label: 'Loop Scan',
    filename: 'loop-scan.md',
    path: '/workspace/.claude/commands/loop-scan.md',
    folder: '/workspace/.claude/commands',
    sizeBytes: 100,
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildWorkflowCommandSuggestion', () => {
  it('derives the command from commandName when present', () => {
    const suggestion = buildWorkflowCommandSuggestion(prompt({ commandName: '/loop-scan' }));
    expect(suggestion.command).toBe('/loop-scan');
    expect(suggestion.name).toBe('loop-scan');
    expect(suggestion.insertText).toBe('loop-scan');
  });

  it('falls back to the filename when there is no commandName', () => {
    const suggestion = buildWorkflowCommandSuggestion(prompt({ commandName: undefined }));
    expect(suggestion.command).toBe('/loop-scan');
  });

  it('carries workflowPromptId / workflowPromptFolder for submit-time expansion', () => {
    const suggestion = buildWorkflowCommandSuggestion(prompt());
    expect(suggestion.workflowPromptId).toBe('prompt-loop-scan');
    expect(suggestion.workflowPromptFolder).toBe('/workspace/.claude/commands');
  });

  it('uses a configurable id prefix', () => {
    expect(buildWorkflowCommandSuggestion(prompt()).id).toBe('workflow:prompt-loop-scan');
    expect(buildWorkflowCommandSuggestion(prompt(), 'team-workflow').id).toBe(
      'team-workflow:prompt-loop-scan'
    );
  });

  it('builds a searchable searchText from label/description/category/safety', () => {
    const suggestion = buildWorkflowCommandSuggestion(
      prompt({ description: 'Run loop scan', category: 'loop', safety: 'read-only' })
    );
    expect(suggestion.searchText).toContain('Loop Scan');
    expect(suggestion.searchText).toContain('read-only');
    expect(suggestion.searchText).toContain('/loop-scan');
  });

  it('falls back to a useful Chinese description for known AgentCLI workflows', () => {
    const suggestion = buildWorkflowCommandSuggestion(
      prompt({ label: 'loop scan', description: undefined, safety: 'unknown' })
    );
    expect(suggestion.description).toBe('扫描自动化、工作树、技能、连接器、子 Agent 和状态资产。');
    expect(suggestion.subtitle).toBe('loop scan');
    expect(suggestion.subtitle).not.toContain('unknown');
    expect(suggestion.searchText).not.toContain('unknown');
  });

  it('normalizes legacy workflow suffixes when resolving fallback descriptions', () => {
    const suggestion = buildWorkflowCommandSuggestion(
      prompt({
        commandName: '/doctor.legacy-workflow',
        filename: 'doctor.legacy-workflow.md',
        label: 'doctor legacy workflow',
        description: undefined,
        safety: 'unknown',
      })
    );
    expect(suggestion.description).toBe(
      '诊断 AgentCLI、Claude Code、hermit-bridge 和 Loop runtime 健康。'
    );
  });
});
