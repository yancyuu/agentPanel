import { describe, expect, it } from 'vitest';

import {
  getLoopCommandShortcuts,
  getLoopShortcutMentionSuggestions,
  getLoopShortcutSuggestions,
} from '@renderer/utils/loopShortcutSuggestions';

describe('loopShortcutSuggestions', () => {
  it('keeps legacy mention suggestions backed by structured shortcuts', () => {
    const shortcuts = getLoopCommandShortcuts();
    const suggestions = getLoopShortcutSuggestions();

    expect(shortcuts.length).toBeGreaterThan(5);
    expect(suggestions).toHaveLength(shortcuts.length);
    expect(suggestions[0]).toMatchObject({
      type: 'command',
      command: shortcuts[0].command,
      insertText: shortcuts[0].insertText,
    });
  });

  it('prioritizes ops workflows for Loop console discovery', () => {
    const suggestions = getLoopShortcutMentionSuggestions();
    const commands = suggestions.map((suggestion) => suggestion.command);

    expect(commands).toContain('/hermit:doctor');
    expect(commands).toContain('/hermit:loop-scan');
    expect(commands).toContain('/hermit:summary');
    expect(commands).toContain('/hermit:daily-folder-hygiene');
    expect(commands).toContain('/hermit:daily-memory-conflict-check');
    expect(commands).toContain('/hermit:daily-workflow-extraction');
    expect(commands).toContain('/hermit:worktree-scan');
  });
});
