import { describe, expect, it } from 'vitest';

import { localUserRowsFromSessions } from '../UsageTelemetryService';

import type { SessionEntry } from '../SessionUsageParser';

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    provider: 'claudecode',
    relPath: 'proj/abc.jsonl',
    projectPath: '/Users/x/proj',
    title: '',
    messageCount: 0,
    toolCalls: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
    startTime: '',
    endTime: '',
    fileSize: 0,
    mtime: 0,
    isWorktree: false,
    ...overrides,
  };
}

describe('localUserRowsFromSessions', () => {
  it('aggregates sessions sharing provider + projectPath into a single row', () => {
    const rows = localUserRowsFromSessions([
      makeSession({
        relPath: 'proj/a.jsonl',
        messageCount: 5,
        tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0, total: 30 },
        startTime: '2026-01-01T00:00:00Z',
        endTime: '2026-01-01T01:00:00Z',
      }),
      makeSession({
        relPath: 'proj/b.jsonl',
        messageCount: 7,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, total: 10 },
        startTime: '2026-01-02T00:00:00Z',
        endTime: '2026-01-02T02:00:00Z',
      }),
    ]);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sessions).toBe(2);
    expect(row.messages).toBe(12);
    expect(row.tokensIn).toBe(11);
    expect(row.tokensOut).toBe(22);
    expect(row.cacheRead).toBe(3);
    expect(row.cacheCreation).toBe(4);
    expect(row.tokensTotal).toBe(40);
    expect(row.lastActiveAt).toBe('2026-01-02T02:00:00Z');
    // Stable group key — must NOT embed the per-session uuid filename.
    expect(row.key).toBe('local:claudecode:/Users/x/proj');
    expect(row.workDir).toBe('/Users/x/proj');
    expect(row.projectName).toBe('proj');
    expect(row.identity.displayName).toBe('proj');
    expect(row.identity.confidence).toBe('claudecode-jsonl');
  });

  it('keeps separate rows for distinct projectPath', () => {
    const rows = localUserRowsFromSessions([
      makeSession({
        projectPath: '/Users/x/a',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5 },
      }),
      makeSession({
        projectPath: '/Users/x/b',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 7 },
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tokensTotal).sort((a, b) => a - b)).toEqual([5, 7]);
  });

  it('keeps separate rows for distinct provider on the same projectPath', () => {
    const rows = localUserRowsFromSessions([
      makeSession({
        provider: 'claudecode',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5 },
      }),
      makeSession({
        provider: 'codex',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 7 },
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.provider))).toEqual(new Set(['claudecode', 'codex']));
  });

  it('keeps Pi separate from other providers on the same projectPath', () => {
    const rows = localUserRowsFromSessions([
      makeSession({
        provider: 'claudecode',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5 },
      }),
      makeSession({
        provider: 'codex',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 7 },
      }),
      makeSession({
        provider: 'pi',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 11 },
      }),
    ]);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.provider))).toEqual(
      new Set(['claudecode', 'codex', 'pi'])
    );
  });

  it('drops sessions with no tokens and no messages', () => {
    const rows = localUserRowsFromSessions([
      makeSession({
        messageCount: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      }),
      makeSession({
        messageCount: 3,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].messages).toBe(3);
  });

  it.each([
    ['codex', 'Local Codex'],
    ['pi', 'Local Pi'],
  ] as const)('falls back to a provider-specific displayName for %s', (provider, displayName) => {
    const rows = localUserRowsFromSessions([
      makeSession({
        provider,
        projectPath: '',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5 },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].identity.displayName).toBe(displayName);
  });
});
