import type { ScheduleStatus } from '@shared/types';

// =============================================================================
// Calendar view mode
// =============================================================================

export type CalendarViewMode = 'day' | 'week' | 'month';

// =============================================================================
// Calendar occurrence — a single cron fire event on the calendar
// =============================================================================

export interface CalendarOccurrence {
  scheduleId: string;
  teamName: string;
  label: string;
  cronDescription: string;
  status: ScheduleStatus;
  /** The Date of this specific cron occurrence */
  date: Date;
  /** Hour of day (0-23) for positioning */
  hour: number;
  /** Minute within the hour (0-59) */
  minute: number;
  /** Visual block height in minutes — defaults to 30 */
  durationMinutes: number;
  /** Team color (CSS color string) */
  color: string;
  /** Team display name */
  teamDisplayName: string;
  /** Column index for side-by-side stacking (computed by overlap algorithm) */
  column: number;
  /** Total number of overlapping columns in this slot */
  totalColumns: number;
}

// =============================================================================
// Date range helpers
// =============================================================================

export interface WeekRange {
  start: Date;
  end: Date;
}
