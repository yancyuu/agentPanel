import { useCallback, useEffect, useMemo, useState } from 'react';

import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { buildTaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import { useShallow } from 'zustand/react/shallow';

import type { KanbanTaskState, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

export interface GlobalTaskDetailModel {
  task: TeamTaskWithKanban | null;
  taskMap: Map<string, TeamTaskWithKanban>;
  members: ResolvedTeamMember[];
  kanbanTaskState?: KanbanTaskState;
  loading: boolean;
  isFullTeamLoaded: boolean;
  openTeam(): void;
  viewChanges(taskId: string, filePath?: string): void;
}

export function useGlobalTaskDetailModel(
  teamName: string,
  taskId: string,
  onDismiss?: () => void
): GlobalTaskDetailModel {
  const {
    teamData,
    teamMembers,
    refreshTeamData,
    openTeamTab,
    setPendingReviewRequest,
    globalTasks,
  } = useStore(
    useShallow((state) => ({
      teamData: selectTeamDataForName(state, teamName),
      teamMembers: selectResolvedMembersForTeamName(state, teamName),
      refreshTeamData: state.refreshTeamData,
      openTeamTab: state.openTeamTab,
      setPendingReviewRequest: state.setPendingReviewRequest,
      globalTasks: state.globalTasks,
    }))
  );
  const [completedRequestKey, setCompletedRequestKey] = useState<string | null>(null);

  useEffect(() => {
    if (!teamName || !taskId || teamData) return;
    let active = true;
    void refreshTeamData(teamName, { withDedup: true })
      .catch(() => undefined)
      .finally(() => {
        if (active) setCompletedRequestKey(`${teamName}:${taskId}`);
      });
    return () => {
      active = false;
    };
  }, [refreshTeamData, taskId, teamData, teamName]);

  const taskMap = useMemo(() => {
    const map = new Map<string, TeamTaskWithKanban>();
    if (!teamName || !taskId) return map;
    if (teamData) {
      for (const task of teamData.tasks) map.set(task.id, task);
      return map;
    }
    for (const task of globalTasks) {
      if (task.teamName === teamName) map.set(task.id, task);
    }
    return map;
  }, [globalTasks, taskId, teamData, teamName]);

  const members = useMemo(
    () => (teamData ? teamMembers.filter((member) => !member.removedAt) : []),
    [teamData, teamMembers]
  );

  const openTeam = useCallback(() => {
    onDismiss?.();
    openTeamTab(teamName, undefined, { taskId });
  }, [onDismiss, openTeamTab, taskId, teamName]);

  const viewChanges = useCallback(
    (viewTaskId: string, filePath?: string) => {
      const targetTask = taskMap.get(viewTaskId);
      if (!targetTask) return;
      setPendingReviewRequest({
        taskId: viewTaskId,
        filePath,
        requestOptions: buildTaskChangeRequestOptions(targetTask),
      });
      onDismiss?.();
      openTeamTab(teamName);
    },
    [onDismiss, openTeamTab, setPendingReviewRequest, taskMap, teamName]
  );

  return {
    task: taskMap.get(taskId) ?? null,
    taskMap,
    members,
    kanbanTaskState: teamData?.kanbanState.tasks[taskId],
    loading: !taskMap.has(taskId) && !teamData && completedRequestKey !== `${teamName}:${taskId}`,
    isFullTeamLoaded: Boolean(teamData),
    openTeam,
    viewChanges,
  };
}
