import React, { useCallback, useMemo, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { getCronDescription } from '@renderer/utils/scheduleFormatters';
import { Cron } from 'croner';
import { addDays, addHours, format, isSameDay, isToday } from 'date-fns';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { Schedule, ScheduleStatus } from '@shared/types';

// =============================================================================
// Config
// =============================================================================

type TimeRange = '6h' | '24h' | '3d' | '7d';

const RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '3d', label: '3d' },
  { value: '7d', label: '7d' },
];

const RANGE_MS: Record<TimeRange, number> = {
  '6h': 6 * 3600_000,
  '24h': 24 * 3600_000,
  '3d': 3 * 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
};

const MAX_EXPANDED_ITEMS = 5;
const MAX_CRON_HITS = 200;

// Left column width for team/schedule labels
const LEFT_W = '140px';
// Minimum width for the timeline area so it doesn't cramp
const TIMELINE_MIN_W = '500px';

// =============================================================================
// Types
// =============================================================================

interface ScheduleHit {
  schedule: Schedule;
  date: Date;
}

interface TeamGroup {
  teamName: string;
  displayName: string;
  color: string;
  schedules: Schedule[];
  hits: ScheduleHit[];
}

// =============================================================================
// TeamGanttView
// =============================================================================

interface TeamGanttViewProps {
  schedules: Schedule[];
  getTeamColor: (teamName: string) => string;
  getTeamDisplayName: (teamName: string) => string;
  onEdit: (schedule: Schedule) => void;
}

export const TeamGanttView = React.memo(function TeamGanttView({
  schedules,
  getTeamColor,
  getTeamDisplayName,
  onEdit,
}: TeamGanttViewProps): React.JSX.Element {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());

  const [now] = useState(() => Date.now());
  const rangeMs = RANGE_MS[timeRange];
  const rangeEnd = now + rangeMs;

  // Tick labels for the time axis
  const ticks = useMemo(() => {
    let intervalMs: number;
    switch (timeRange) {
      case '6h':
        intervalMs = 3600_000;
        break;
      case '24h':
        intervalMs = 3 * 3600_000;
        break;
      case '3d':
        intervalMs = 12 * 3600_000;
        break;
      case '7d':
        intervalMs = 24 * 3600_000;
        break;
      default:
        intervalMs = 3600_000;
        break;
    }
    const result: { time: number; pct: number }[] = [];
    const start = Math.floor(now / intervalMs) * intervalMs;
    for (let t = start; t <= now + rangeMs; t += intervalMs) {
      if (t < now) continue;
      const pct = ((t - now) / rangeMs) * 100;
      if (pct > 100) break;
      result.push({ time: t, pct });
    }
    return result;
  }, [now, rangeMs, timeRange]);

  // Group schedules by team and compute cron hits
  const teams = useMemo(() => {
    const groupMap = new Map<string, TeamGroup>();
    for (const schedule of schedules) {
      if (schedule.status === 'disabled') continue;
      const key = schedule.teamName;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          teamName: key,
          displayName: getTeamDisplayName(key),
          color: getTeamColor(key),
          schedules: [],
          hits: [],
        });
      }
      const group = groupMap.get(key)!;
      group.schedules.push(schedule);
      const hits = enumerateHits(schedule, now, rangeEnd);
      group.hits.push(...hits);
    }
    return [...groupMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [schedules, now, rangeEnd, getTeamColor, getTeamDisplayName]);

  // Per-schedule hits for expanded rows
  const scheduleHits = useMemo(() => {
    const map = new Map<string, ScheduleHit[]>();
    for (const team of teams) {
      for (const schedule of team.schedules) {
        map.set(schedule.id, enumerateHits(schedule, now, rangeEnd));
      }
    }
    return map;
  }, [teams, now, rangeEnd]);

  const toggleTeam = useCallback((teamName: string) => {
    setExpandedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(teamName)) next.delete(teamName);
      else next.add(teamName);
      return next;
    });
  }, []);

  return (
    <div className="rounded-xl border border-[var(--color-border)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-xs text-[var(--color-text-muted)]">{teams.length} 个计划</span>
        <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={cn(
                'rounded-sm px-2 py-0.5 text-[10px] transition-colors',
                timeRange === opt.value
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}
              onClick={() => setTimeRange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Time axis — aligned to grid, horizontally scrollable */}
      <div className="overflow-x-auto border-b border-[var(--color-border)]">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `${LEFT_W} minmax(${TIMELINE_MIN_W}, 1fr)`,
            minWidth: `calc(${LEFT_W} + ${TIMELINE_MIN_W})`,
          }}
        >
          <div className="px-3 py-1.5 text-[10px] text-[var(--color-text-muted)] opacity-50">
            团队
          </div>
          <div className="relative h-6">
            {ticks.map((tick, i) => (
              <span
                key={i}
                className="absolute top-0.5 text-[10px] tabular-nums text-[var(--color-text-muted)]"
                style={{
                  left: `${tick.pct}%`,
                  transform: 'translateX(-50%)',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatTick(tick.time, timeRange)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Team rows — scrollable horizontally */}
      {teams.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-xs text-[var(--color-text-muted)]">
          当前范围内没有计划任务
        </div>
      ) : (
        <div className="overflow-x-auto">
          {teams.map((team) => {
            const expanded = expandedTeams.has(team.teamName);
            const hitCount = team.hits.length;
            const showSchedules = team.schedules.slice(0, MAX_EXPANDED_ITEMS);
            const hiddenCount = team.schedules.length - MAX_EXPANDED_ITEMS;

            return (
              <div
                key={team.teamName}
                className="group/team border-b border-[var(--color-border)] last:border-b-0"
              >
                {/* Team row (collapsed) — grid aligned */}
                <div
                  className="grid items-center transition-colors hover:bg-white/[0.02]"
                  style={{
                    gridTemplateColumns: `${LEFT_W} minmax(${TIMELINE_MIN_W}, 1fr)`,
                    minWidth: `calc(${LEFT_W} + ${TIMELINE_MIN_W})`,
                  }}
                >
                  {/* Left: team info */}
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2 px-3 py-2.5 text-left"
                    onClick={() => toggleTeam(team.teamName)}
                  >
                    <span className="text-[var(--color-text-muted)]">
                      {expanded ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )}
                    </span>
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: team.color }}
                    />
                    <span className="truncate text-xs font-medium text-[var(--color-text)]">
                      {team.displayName}
                    </span>
                  </button>

                  {/* Right: mini timeline */}
                  <div className="relative h-10">
                    {/* Grid lines */}
                    {ticks.map((tick, i) => (
                      <div
                        key={i}
                        className="absolute inset-y-0 w-px bg-[var(--color-border)] opacity-30"
                        style={{ left: `${tick.pct}%` }}
                      />
                    ))}
                    {/* Now marker */}
                    <div className="absolute inset-y-0 w-px bg-red-500/50" style={{ left: '0%' }} />

                    {/* Fallback: show schedule names when no hits in range */}
                    {hitCount === 0 &&
                      team.schedules.map((schedule) => (
                        <button
                          key={schedule.id}
                          type="button"
                          className="absolute top-1/2 z-10 -translate-y-1/2 rounded-sm border border-[var(--color-border)] px-2 py-0.5 text-left transition-colors hover:bg-white/[0.04]"
                          style={{ left: '8px', transform: 'translateY(-50%)' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(schedule);
                          }}
                        >
                          <span className="text-[10px] font-medium text-[var(--color-text-secondary)]">
                            {schedule.label || getCronDescription(schedule.cronExpression)}
                          </span>
                          <span className="ml-2 text-[9px] text-[var(--color-text-muted)]">
                            {schedule.nextRunAt
                              ? `下次 ${format(new Date(schedule.nextRunAt), 'M/d HH:mm')}`
                              : '无计划'}
                          </span>
                        </button>
                      ))}

                    {/* Hits as labeled pills */}
                    {team.hits.map((hit, i) => {
                      const pct = ((hit.date.getTime() - now) / rangeMs) * 100;
                      if (pct < 0 || pct > 100) return null;
                      const isActive = hit.schedule.status === 'active';
                      return (
                        <button
                          key={`${hit.schedule.id}-${i}`}
                          type="button"
                          className={cn(
                            'absolute top-1/2 z-10 -translate-y-1/2 rounded-sm px-1.5 py-0.5 text-left transition-transform hover:z-20 hover:scale-105',
                            isActive && 'opacity-100',
                            !isActive && 'opacity-40'
                          )}
                          style={{
                            left: `${pct}%`,
                            backgroundColor: team.color,
                            maxWidth: 120,
                            transform: `translate(-50%, -50%)`,
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(hit.schedule);
                          }}
                          title={`${hit.schedule.label || getCronDescription(hit.schedule.cronExpression)}\n${hit.date.toLocaleString('zh-CN')}`}
                        >
                          <span className="block truncate text-[9px] font-medium leading-tight text-white">
                            {format(hit.date, 'HH:mm')}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Expanded: per-schedule rows */}
                {expanded && (
                  <div className="bg-[var(--color-surface-raised)]/30">
                    {showSchedules.map((schedule) => {
                      const hits = scheduleHits.get(schedule.id) ?? [];
                      const statusLabel =
                        schedule.status === 'active'
                          ? '运行中'
                          : schedule.status === 'paused'
                            ? '已暂停'
                            : schedule.status;

                      return (
                        <div
                          key={schedule.id}
                          className="grid items-center transition-colors hover:bg-white/[0.02]"
                          style={{
                            gridTemplateColumns: `${LEFT_W} minmax(${TIMELINE_MIN_W}, 1fr)`,
                            minWidth: `calc(${LEFT_W} + ${TIMELINE_MIN_W})`,
                          }}
                        >
                          {/* Left: schedule info */}
                          <button
                            type="button"
                            className="flex min-w-0 items-center gap-2 py-2 pl-7 pr-3 text-left"
                            onClick={() => onEdit(schedule)}
                          >
                            <span className="truncate text-[11px] text-[var(--color-text-secondary)]">
                              {schedule.label || getCronDescription(schedule.cronExpression)}
                            </span>
                            <span
                              className={cn(
                                'shrink-0 rounded-sm px-1 py-px text-[9px]',
                                schedule.status === 'active' &&
                                  'bg-emerald-500/15 text-emerald-400',
                                schedule.status === 'paused' && 'bg-amber-500/15 text-amber-400'
                              )}
                            >
                              {statusLabel}
                            </span>
                          </button>

                          {/* Right: schedule timeline */}
                          <div className="relative h-7">
                            {ticks.map((tick, i) => (
                              <div
                                key={i}
                                className="absolute inset-y-0 w-px bg-[var(--color-border)] opacity-20"
                                style={{ left: `${tick.pct}%` }}
                              />
                            ))}
                            <div
                              className="absolute inset-y-0 w-px bg-red-500/30"
                              style={{ left: '0%' }}
                            />

                            {hits.map((hit, i) => {
                              const pct = ((hit.date.getTime() - now) / rangeMs) * 100;
                              if (pct < 0 || pct > 100) return null;
                              return (
                                <span
                                  key={i}
                                  className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                                  style={{ left: `${pct}%`, backgroundColor: team.color }}
                                  title={hit.date.toLocaleString('zh-CN')}
                                />
                              );
                            })}

                            {/* Next run label */}
                            {schedule.nextRunAt && (
                              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] tabular-nums text-[var(--color-text-muted)]">
                                下次 {format(new Date(schedule.nextRunAt), 'HH:mm')}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {hiddenCount > 0 && (
                      <div className="py-1.5 pl-7 pr-3 text-[10px] text-[var(--color-text-muted)]">
                        +{hiddenCount} 更多
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// =============================================================================
// Helpers
// =============================================================================

function enumerateHits(schedule: Schedule, rangeStart: number, rangeEnd: number): ScheduleHit[] {
  try {
    const job = new Cron(schedule.cronExpression.trim(), {
      timezone: schedule.timezone,
      paused: true,
    });
    const raw = job.nextRuns(MAX_CRON_HITS, new Date(rangeStart));
    const results: ScheduleHit[] = [];
    for (const d of raw) {
      const dt = d instanceof Date ? d : new Date(d);
      if (dt.getTime() > rangeEnd) break;
      if (dt.getTime() >= rangeStart) {
        results.push({ schedule, date: dt });
      }
    }
    return results;
  } catch {
    return [];
  }
}

function formatTick(time: number, range: TimeRange): string {
  const d = new Date(time);
  if (range === '6h' || range === '24h') {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
