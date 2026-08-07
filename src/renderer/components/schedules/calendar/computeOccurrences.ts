import { Cron } from 'croner';
import { addDays, endOfDay, endOfWeek, isBefore, startOfDay, startOfWeek } from 'date-fns';

import type { CalendarOccurrence, CalendarViewMode, WeekRange } from './types';
import type { Schedule } from '@shared/types';

// =============================================================================
// Config
// =============================================================================

/** Max cron hits to enumerate per schedule per range */
const MAX_OCCURRENCES_PER_SCHEDULE = 200;

/** Default visual duration for each event block (minutes) */
const DEFAULT_DURATION_MINUTES = 30;

/** Week starts on Monday */
const WEEK_STARTS_ON = 1 as const;

// =============================================================================
// Date range computation
// =============================================================================

export function getViewRange(
  mode: CalendarViewMode,
  referenceDate: Date
): { start: Date; end: Date } {
  const base = startOfDay(referenceDate);
  switch (mode) {
    case 'day':
      return { start: base, end: endOfDay(referenceDate) };
    case 'week':
      return {
        start: startOfWeek(base, { weekStartsOn: WEEK_STARTS_ON }),
        end: endOfWeek(base, { weekStartsOn: WEEK_STARTS_ON }),
      };
    case 'month': {
      const monthStart = new Date(base.getFullYear(), base.getMonth(), 1);
      const gridStart = startOfWeek(monthStart, { weekStartsOn: WEEK_STARTS_ON });
      const nextMonth = new Date(base.getFullYear(), base.getMonth() + 1, 1);
      const lastDay = addDays(nextMonth, -1);
      const gridEnd = endOfWeek(lastDay, { weekStartsOn: WEEK_STARTS_ON });
      return { start: gridStart, end: gridEnd };
    }
  }
}

export function getWeekRange(referenceDate: Date): WeekRange {
  const base = startOfDay(referenceDate);
  return {
    start: startOfWeek(base, { weekStartsOn: WEEK_STARTS_ON }),
    end: endOfWeek(base, { weekStartsOn: WEEK_STARTS_ON }),
  };
}

// =============================================================================
// Core occurrence computation
// =============================================================================

interface TeamColorResolver {
  getTeamColor: (teamName: string) => string;
  getTeamDisplayName: (teamName: string) => string;
}

export function computeCalendarOccurrences(
  schedules: Schedule[],
  rangeStart: Date,
  rangeEnd: Date,
  resolvers: TeamColorResolver
): CalendarOccurrence[] {
  if (schedules.length === 0) return [];

  const allOccurrences: CalendarOccurrence[] = [];

  for (const schedule of schedules) {
    if (schedule.status === 'disabled') continue;

    const rawDates = enumerateCronInRange(
      schedule.cronExpression,
      schedule.timezone,
      rangeStart,
      rangeEnd
    );

    for (const date of rawDates) {
      allOccurrences.push({
        scheduleId: schedule.id,
        teamName: schedule.teamName,
        label: schedule.label || '',
        cronDescription: '',
        status: schedule.status,
        date,
        hour: date.getHours(),
        minute: date.getMinutes(),
        durationMinutes: DEFAULT_DURATION_MINUTES,
        color: resolvers.getTeamColor(schedule.teamName),
        teamDisplayName: resolvers.getTeamDisplayName(schedule.teamName),
        column: 0,
        totalColumns: 1,
      });
    }
  }

  resolveOverlaps(allOccurrences);
  return allOccurrences;
}

// =============================================================================
// Cron enumeration
// =============================================================================

function enumerateCronInRange(
  cronExpression: string,
  timezone: string,
  rangeStart: Date,
  rangeEnd: Date
): Date[] {
  try {
    const job = new Cron(cronExpression.trim(), { timezone, paused: true });
    const raw = job.nextRuns(MAX_OCCURRENCES_PER_SCHEDULE, rangeStart);
    const results: Date[] = [];
    for (const d of raw) {
      const dt = d instanceof Date ? d : new Date(d);
      if (isBefore(rangeEnd, dt)) break;
      if (!isBefore(dt, rangeStart)) {
        results.push(dt);
      }
    }
    return results;
  } catch {
    return [];
  }
}

// =============================================================================
// Overlap resolution — greedy column assignment within each day
// =============================================================================

function resolveOverlaps(occurrences: CalendarOccurrence[]): void {
  // Group by day key (YYYY-MM-DD)
  const byDay = new Map<string, CalendarOccurrence[]>();
  for (const occ of occurrences) {
    const key = dayKey(occ.date);
    const list = byDay.get(key);
    if (list) list.push(occ);
    else byDay.set(key, [occ]);
  }

  for (const dayOccurrences of byDay.values()) {
    if (dayOccurrences.length > 1) {
      resolveOverlapsInDay(dayOccurrences);
    }
  }
}

function resolveOverlapsInDay(occurrences: CalendarOccurrence[]): void {
  const sorted = [...occurrences].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

  // --- Pass 1: greedy column assignment ---
  // columnEndTimes[col] = minute-of-day when that column becomes free
  const columnEndTimes: number[] = [];

  for (const occ of sorted) {
    const startMin = occ.hour * 60 + occ.minute;
    const endMin = startMin + occ.durationMinutes;

    let assignedCol = -1;
    for (let col = 0; col < columnEndTimes.length; col++) {
      if (columnEndTimes[col] <= startMin) {
        assignedCol = col;
        break;
      }
    }
    if (assignedCol === -1) {
      assignedCol = columnEndTimes.length;
      columnEndTimes.push(0);
    }
    columnEndTimes[assignedCol] = endMin;
    occ.column = assignedCol;
  }

  // --- Pass 2: propagate max totalColumns to all events in each overlap group ---
  // Build overlap graph, then for each connected component set totalColumns = max column + 1
  const visited = new Set<CalendarOccurrence>();

  for (const occ of sorted) {
    if (visited.has(occ)) continue;

    // BFS to find all transitively overlapping events
    const component: CalendarOccurrence[] = [];
    const queue = [occ];
    visited.add(occ);

    while (queue.length > 0) {
      const current = queue.pop()!;
      component.push(current);
      const curStart = current.hour * 60 + current.minute;
      const curEnd = curStart + current.durationMinutes;

      for (const other of sorted) {
        if (visited.has(other)) continue;
        const otherStart = other.hour * 60 + other.minute;
        const otherEnd = otherStart + other.durationMinutes;
        if (otherStart < curEnd && otherEnd > curStart) {
          visited.add(other);
          queue.push(other);
        }
      }
    }

    const maxCol = Math.max(...component.map((o) => o.column));
    for (const o of component) {
      o.totalColumns = maxCol + 1;
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
