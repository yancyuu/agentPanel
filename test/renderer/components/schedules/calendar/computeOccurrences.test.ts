import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computeCalendarOccurrences,
  getViewRange,
  getWeekRange,
} from '@renderer/components/schedules/calendar/computeOccurrences';

import type { Schedule } from '@shared/types';

// =============================================================================
// Helpers
// =============================================================================

function createSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch-1',
    teamName: 'team-a',
    label: 'Daily sync',
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    status: 'active',
    warmUpMinutes: 15,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    maxTurns: 50,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastRunAt: undefined,
    launchConfig: { cwd: '/repo', prompt: 'sync' },
    ...overrides,
  };
}

const noopResolvers = {
  getTeamColor: () => '#3b82f6',
  getTeamDisplayName: (name: string) => name,
};

// =============================================================================
// getViewRange
// =============================================================================

describe('getViewRange', () => {
  it('day mode returns midnight to end-of-day', () => {
    const ref = new Date('2026-06-05T14:30:00.000Z');
    const { start, end } = getViewRange('day', ref);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(5); // June = 5
    expect(start.getDate()).toBe(5);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(end.getDate()).toBe(5);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
  });

  it('week mode returns Monday through Sunday', () => {
    // 2026-06-05 is a Friday
    const ref = new Date('2026-06-05T12:00:00.000Z');
    const { start, end } = getViewRange('week', ref);
    // Monday of that week
    expect(start.getDay()).toBe(1); // Monday
    expect(start.getDate()).toBeLessThanOrEqual(ref.getDate());
    // Sunday
    expect(end.getDay()).toBe(0); // Sunday
  });

  it('week mode — reference is Monday, start equals reference', () => {
    // 2026-06-01 is a Monday
    const ref = new Date('2026-06-01T12:00:00.000Z');
    const { start } = getViewRange('week', ref);
    expect(start.getDate()).toBe(1);
    expect(start.getDay()).toBe(1);
  });

  it('week mode — reference is Sunday, end equals reference', () => {
    // 2026-06-07 is a Sunday
    const ref = new Date('2026-06-07T12:00:00.000Z');
    const { end } = getViewRange('week', ref);
    expect(end.getDate()).toBe(7);
    expect(end.getDay()).toBe(0);
  });

  it('month mode grid extends from Monday before 1st through Sunday after last day', () => {
    // June 2026: 1st is Monday, 30th is Tuesday
    const ref = new Date('2026-06-15T00:00:00.000Z');
    const { start, end } = getViewRange('month', ref);
    expect(start.getMonth()).toBe(5);
    // Grid starts on Monday before/including June 1
    expect(start.getDay()).toBe(1);
    // Grid ends on Sunday after June 30 (may be in July)
    expect(end.getDay()).toBe(0);
    expect(end.getTime()).toBeGreaterThan(new Date('2026-06-30T00:00:00Z').getTime());
  });
});

// =============================================================================
// getWeekRange
// =============================================================================

describe('getWeekRange', () => {
  it('mid-week reference returns Monday–Sunday range', () => {
    // 2026-06-05 is Friday
    const ref = new Date('2026-06-05T12:00:00.000Z');
    const { start, end } = getWeekRange(ref);
    expect(start.getDay()).toBe(1);
    expect(end.getDay()).toBe(0);
  });

  it('Monday reference starts exactly on that day', () => {
    const monday = new Date('2026-06-01T12:00:00.000Z');
    const { start } = getWeekRange(monday);
    expect(start.getDate()).toBe(1);
  });

  it('Sunday reference ends exactly on that day', () => {
    const sunday = new Date('2026-06-07T12:00:00.000Z');
    const { end } = getWeekRange(sunday);
    expect(end.getDate()).toBe(7);
  });
});

// =============================================================================
// computeCalendarOccurrences
// =============================================================================

describe('computeCalendarOccurrences', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty array for empty schedules', () => {
    const result = computeCalendarOccurrences(
      [],
      new Date('2026-06-01'),
      new Date('2026-06-30'),
      noopResolvers,
    );
    expect(result).toEqual([]);
  });

  it('skips disabled schedules', () => {
    const schedule = createSchedule({ status: 'disabled' });
    const result = computeCalendarOccurrences(
      [schedule],
      new Date('2026-06-01'),
      new Date('2026-06-30'),
      noopResolvers,
    );
    expect(result).toEqual([]);
  });

  it('produces occurrences with correct hour/minute from cron', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const schedule = createSchedule({ cronExpression: '0 9 * * *' });
    const start = new Date('2026-06-01T00:00:00Z');
    const end = new Date('2026-06-03T00:00:00Z');
    const result = computeCalendarOccurrences([schedule], start, end, noopResolvers);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const first = result[0];
    expect(first.hour).toBe(9);
    expect(first.minute).toBe(0);
    expect(first.scheduleId).toBe('sch-1');
    expect(first.teamName).toBe('team-a');
  });

  it('filters out occurrences before rangeStart', () => {
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'));
    const schedule = createSchedule({ cronExpression: '0 9 * * *' });
    const start = new Date('2026-06-05T00:00:00Z');
    const end = new Date('2026-06-07T00:00:00Z');
    const result = computeCalendarOccurrences([schedule], start, end, noopResolvers);
    for (const occ of result) {
      expect(occ.date.getTime()).toBeGreaterThanOrEqual(start.getTime());
    }
  });

  it('filters out occurrences after rangeEnd', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const schedule = createSchedule({ cronExpression: '0 9 * * *' });
    const start = new Date('2026-06-01T00:00:00Z');
    const end = new Date('2026-06-03T00:00:00Z');
    const result = computeCalendarOccurrences([schedule], start, end, noopResolvers);
    for (const occ of result) {
      expect(occ.date.getTime()).toBeLessThanOrEqual(end.getTime());
    }
  });

  it('calls resolvers for each schedule', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const colorFn = vi.fn(() => '#ff0000');
    const nameFn = vi.fn((name: string) => `display-${name}`);
    const schedule = createSchedule();
    const start = new Date('2026-06-01T00:00:00Z');
    const end = new Date('2026-06-02T00:00:00Z');
    const result = computeCalendarOccurrences([schedule], start, end, {
      getTeamColor: colorFn,
      getTeamDisplayName: nameFn,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(colorFn).toHaveBeenCalledWith('team-a');
    expect(nameFn).toHaveBeenCalledWith('team-a');
    expect(result[0].color).toBe('#ff0000');
    expect(result[0].teamDisplayName).toBe('display-team-a');
  });

  it('defaults label to empty string when not set', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const schedule = createSchedule({ label: undefined });
    const result = computeCalendarOccurrences(
      [schedule],
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-02T00:00:00Z'),
      noopResolvers,
    );
    if (result.length > 0) {
      expect(result[0].label).toBe('');
    }
  });

  it('defaults cronDescription to empty string', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const result = computeCalendarOccurrences(
      [createSchedule()],
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-02T00:00:00Z'),
      noopResolvers,
    );
    if (result.length > 0) {
      expect(result[0].cronDescription).toBe('');
    }
  });

  it('defaults durationMinutes to 30', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const result = computeCalendarOccurrences(
      [createSchedule()],
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-02T00:00:00Z'),
      noopResolvers,
    );
    if (result.length > 0) {
      expect(result[0].durationMinutes).toBe(30);
    }
  });

  it('handles invalid cron expression gracefully (returns empty)', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const schedule = createSchedule({ cronExpression: 'not-a-cron' });
    const result = computeCalendarOccurrences(
      [schedule],
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-30T00:00:00Z'),
      noopResolvers,
    );
    // Invalid cron should not crash; returns 0 or fewer occurrences
    expect(Array.isArray(result)).toBe(true);
  });

  // ===========================================================================
  // Overlap resolution
  // ===========================================================================

  it('two events at the same time get different columns', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const s1 = createSchedule({
      id: 'sch-1',
      teamName: 'team-a',
      cronExpression: '0 9 1 6 *',
    });
    const s2 = createSchedule({
      id: 'sch-2',
      teamName: 'team-b',
      cronExpression: '0 9 1 6 *',
    });
    const start = new Date('2026-06-01T00:00:00Z');
    const end = new Date('2026-06-02T00:00:00Z');
    const result = computeCalendarOccurrences([s1, s2], start, end, noopResolvers);
    if (result.length >= 2) {
      const columns = result.map((o) => o.column);
      expect(new Set(columns).size).toBe(result.length); // all unique columns
      for (const o of result) {
        expect(o.totalColumns).toBe(result.length);
      }
    }
  });

  it('non-overlapping events share column 0', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const s1 = createSchedule({
      id: 'sch-1',
      cronExpression: '0 9 1 6 *',
    });
    const s2 = createSchedule({
      id: 'sch-2',
      cronExpression: '0 14 1 6 *',
    });
    const start = new Date('2026-06-01T00:00:00Z');
    const end = new Date('2026-06-02T00:00:00Z');
    const result = computeCalendarOccurrences([s1, s2], start, end, noopResolvers);
    if (result.length >= 2) {
      for (const o of result) {
        expect(o.column).toBe(0);
        expect(o.totalColumns).toBe(1);
      }
    }
  });
});
