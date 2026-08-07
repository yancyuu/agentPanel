import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_TEAM_EFFORT_LEVELS,
  CODEX_TEAM_EFFORT_LEVELS,
  formatEffortLevelList,
  formatEffortLevelListForProvider,
  isTeamEffortLevel,
  isTeamEffortLevelForProvider,
  TEAM_EFFORT_LEVELS,
} from '../effortLevels';

describe('TEAM_EFFORT_LEVELS', () => {
  it('contains the full ordered set of effort levels', () => {
    expect(TEAM_EFFORT_LEVELS).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });
});

describe('isTeamEffortLevel', () => {
  it.each(TEAM_EFFORT_LEVELS)('accepts %s', (level) => {
    expect(isTeamEffortLevel(level)).toBe(true);
  });

  it.each(['', 'turbo', 'extra', undefined, null, 5])('rejects %s', (level) => {
    expect(isTeamEffortLevel(level)).toBe(false);
  });
});

describe('isTeamEffortLevelForProvider', () => {
  it('accepts Codex effort levels for Codex', () => {
    for (const level of CODEX_TEAM_EFFORT_LEVELS) {
      expect(isTeamEffortLevelForProvider(level, 'codex')).toBe(true);
    }
  });

  it('rejects max effort for Codex (not in its set)', () => {
    expect(isTeamEffortLevelForProvider('max', 'codex')).toBe(false);
  });

  it('accepts Anthropic effort levels for Anthropic', () => {
    for (const level of ANTHROPIC_TEAM_EFFORT_LEVELS) {
      expect(isTeamEffortLevelForProvider(level, 'anthropic')).toBe(true);
    }
  });

  it('rejects minimal effort for Anthropic', () => {
    expect(isTeamEffortLevelForProvider('minimal', 'anthropic')).toBe(false);
  });

  it('falls back to the legacy set for gemini/opencode (low/medium/high only)', () => {
    expect(isTeamEffortLevelForProvider('low', 'gemini')).toBe(true);
    expect(isTeamEffortLevelForProvider('medium', 'opencode')).toBe(true);
    expect(isTeamEffortLevelForProvider('high', 'gemini')).toBe(true);
    expect(isTeamEffortLevelForProvider('minimal', 'gemini')).toBe(false);
    expect(isTeamEffortLevelForProvider('max', 'opencode')).toBe(false);
  });
});

describe('formatEffortLevelList', () => {
  it('returns the full comma-separated list', () => {
    expect(formatEffortLevelList()).toBe(TEAM_EFFORT_LEVELS.join(', '));
  });
});

describe('formatEffortLevelListForProvider', () => {
  it('returns the Codex-specific list', () => {
    expect(formatEffortLevelListForProvider('codex')).toBe(CODEX_TEAM_EFFORT_LEVELS.join(', '));
  });

  it('returns the Anthropic-specific list', () => {
    expect(formatEffortLevelListForProvider('anthropic')).toBe(
      ANTHROPIC_TEAM_EFFORT_LEVELS.join(', ')
    );
  });

  it('returns the legacy list for other providers', () => {
    expect(formatEffortLevelListForProvider('gemini')).toBe('low, medium, high');
    expect(formatEffortLevelListForProvider()).toBe('low, medium, high');
  });
});
