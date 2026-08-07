import { describe, expect, it } from 'vitest';

import { mergeAdminCommandSuggestions } from './workflowCommandSuggestions';

import type { MentionSuggestion } from '@renderer/types/mention';

function suggestion(name: string, command?: string): MentionSuggestion {
  return {
    id: name,
    name,
    type: 'command',
    command: (command ?? `/${name}`) as `/${string}`,
    insertText: name,
    description: '',
    subtitle: '',
    searchText: name,
  };
}

describe('mergeAdminCommandSuggestions', () => {
  it('places local-project suggestions before capability-pack suggestions', () => {
    const local = [suggestion('local-a'), suggestion('local-b')];
    const pack = [suggestion('loop-scan'), suggestion('doctor')];

    const merged = mergeAdminCommandSuggestions(local, pack);

    expect(merged.map((s) => s.name)).toEqual(['local-a', 'local-b', 'loop-scan', 'doctor']);
  });

  it('keeps local-project commands first regardless of how many pack commands exist', () => {
    const local = [suggestion('mine')];
    const pack = [suggestion('p1'), suggestion('p2'), suggestion('p3')];

    const merged = mergeAdminCommandSuggestions(local, pack);

    expect(merged[0].name).toBe('mine');
    expect(merged).toHaveLength(4);
  });

  it('filters the reserved loop / system runtime namespaces (bare and namespaced)', () => {
    const local = [suggestion('loop'), suggestion('system')];
    const pack = [suggestion('hermit:loop'), suggestion('foo:system'), suggestion('doctor')];

    const merged = mergeAdminCommandSuggestions(local, pack);

    expect(merged.map((s) => s.name)).toEqual(['doctor']);
  });

  it('keeps commands whose name merely contains loop/system but is not the reserved namespace', () => {
    const local = [suggestion('daily-loop'), suggestion('loop-scan')];
    const pack = [suggestion('hermit:summary'), suggestion('system-check')];

    const merged = mergeAdminCommandSuggestions(local, pack);

    expect(merged.map((s) => s.name)).toEqual([
      'daily-loop',
      'loop-scan',
      'hermit:summary',
      'system-check',
    ]);
  });

  it('strips a single leading slash when filtering reserved namespaces', () => {
    const local: MentionSuggestion[] = [{ ...suggestion('loop'), command: '/loop' }];

    const merged = mergeAdminCommandSuggestions(local, [suggestion('doctor')]);

    expect(merged.map((s) => s.name)).toEqual(['doctor']);
  });
});
