import React, { useCallback } from 'react';

import { TeamGanttView } from './TeamGanttView';

import type { CalendarViewMode } from './types';
import type { Schedule } from '@shared/types';

interface ScheduleCalendarBoardProps {
  schedules: Schedule[];
  viewMode: CalendarViewMode;
  onViewModeChange: (mode: CalendarViewMode) => void;
  onEdit: (schedule: Schedule) => void;
  onTeamClick: (teamName: string) => void;
  getTeamColor: (teamName: string) => string;
  getTeamDisplayName: (teamName: string) => string;
}

const ScheduleCalendarBoardInner = ({
  schedules,
  onEdit,
  getTeamColor,
  getTeamDisplayName,
}: ScheduleCalendarBoardProps) => {
  const handleEdit = useCallback(
    (schedule: Schedule) => {
      onEdit(schedule);
    },
    [onEdit]
  );

  return (
    <TeamGanttView
      schedules={schedules}
      getTeamColor={getTeamColor}
      getTeamDisplayName={getTeamDisplayName}
      onEdit={handleEdit}
    />
  );
};

export const ScheduleCalendarBoard = React.memo(ScheduleCalendarBoardInner);
