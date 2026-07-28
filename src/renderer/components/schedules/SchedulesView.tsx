import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { WorkbenchPageHeader } from '@features/collaborative-workbench/renderer';
import { Button } from '@renderer/components/ui/button';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useStore } from '@renderer/store';
import { nameColorSet } from '@renderer/utils/projectColor';
import { Calendar, Plus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CcCronScheduleDialog } from '../team/schedule/CcCronScheduleDialog';

import { ScheduleCalendarBoard } from './calendar';

import type { CalendarViewMode } from './calendar';
import type { Schedule } from '@shared/types';

export const SchedulesView = (): React.JSX.Element => {
  const { schedules, schedulesLoading, fetchSchedules, openTeamTab, teamByName } = useStore(
    useShallow((s) => ({
      schedules: s.schedules,
      schedulesLoading: s.schedulesLoading,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Zustand actions do not use `this`; preserve the stable store function reference.
      fetchSchedules: s.fetchSchedules,
      openTeamTab: s.openTeamTab,
      teamByName: s.teamByName,
    }))
  );

  const getTeamColor = useCallback(
    (teamName: string): string => {
      const team = teamByName[teamName];
      if (team?.color) return getTeamColorSet(team.color).text;
      return nameColorSet(team?.displayName || teamName).text;
    },
    [teamByName]
  );

  const getTeamDisplayName = useCallback(
    (teamName: string): string => teamByName[teamName]?.displayName || teamName,
    [teamByName]
  );

  const [calendarView, setCalendarView] = useState<CalendarViewMode>('week');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  useEffect(() => {
    void fetchSchedules();
  }, [fetchSchedules]);

  const sortedSchedules = useMemo(
    () =>
      [...schedules].sort((a, b) => {
        const statusOrder = { active: 0, paused: 1, disabled: 2 };
        const statusDiff = statusOrder[a.status] - statusOrder[b.status];
        if (statusDiff !== 0) return statusDiff;
        if (a.nextRunAt && b.nextRunAt) {
          return new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime();
        }
        if (a.nextRunAt) return -1;
        if (b.nextRunAt) return 1;
        return 0;
      }),
    [schedules]
  );

  const activeScheduleCount = useMemo(
    () => schedules.filter((schedule) => schedule.status === 'active').length,
    [schedules]
  );

  const handleEdit = useCallback((schedule: Schedule) => {
    setEditingSchedule(schedule);
    setDialogOpen(true);
  }, []);

  const handleCreate = useCallback(() => {
    setEditingSchedule(null);
    setDialogOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setDialogOpen(false);
    setEditingSchedule(null);
  }, []);

  const handleTeamClick = useCallback(
    (teamName: string) => {
      openTeamTab(teamName);
    },
    [openTeamTab]
  );

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-page-canvas">
      <WorkbenchPageHeader
        title="计划任务"
        description={
          schedules.length > 0
            ? `${activeScheduleCount} 个计划正在运行`
            : '按计划触发团队任务和 Loop 工作流。'
        }
        count={schedules.length}
        actions={
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={handleCreate}
          >
            <Plus className="size-3.5" />
            <span className="hidden sm:inline">添加计划</span>
            <span className="sm:hidden">添加</span>
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {schedulesLoading && schedules.length === 0 ? (
          <div className="flex items-center justify-center py-24 text-sm text-[var(--color-text-muted)]">
            正在加载计划...
          </div>
        ) : schedules.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-[var(--surface-border)] bg-[var(--color-surface)] px-4 text-center">
            <Calendar className="size-6 text-[var(--color-text-muted)] opacity-40" />
            <p className="max-w-md text-xs leading-5 text-[var(--color-text-muted)]">
              暂无计划任务。在 Loop 工作区中创建计划后，系统会按设定时间自动运行。
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-1 gap-1.5 text-xs"
              onClick={handleCreate}
            >
              <Plus className="size-3.5" />
              创建计划
            </Button>
          </div>
        ) : (
          <ScheduleCalendarBoard
            schedules={sortedSchedules}
            viewMode={calendarView}
            onViewModeChange={setCalendarView}
            onEdit={handleEdit}
            onTeamClick={handleTeamClick}
            getTeamColor={getTeamColor}
            getTeamDisplayName={getTeamDisplayName}
          />
        )}
      </div>

      <CcCronScheduleDialog
        open={dialogOpen}
        teamName={editingSchedule?.teamName}
        schedule={editingSchedule}
        onClose={handleClose}
      />
    </div>
  );
};
