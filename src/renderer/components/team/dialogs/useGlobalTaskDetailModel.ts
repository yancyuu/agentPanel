import { useCallback, useEffect, useMemo } from 'react';

import { useStore } from '@renderer/store';
import { selectResolvedMembersForTeamName } from '@renderer/store/slices/teamSlice';
import { buildTaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import { useShallow } from 'zustand/react/shallow';

import {
  hasSelectedTargetTeamData,
  shouldKeepGlobalTaskDialogLoading,
} from './globalTaskDetailDialogLoading';

import type {
  GlobalTask,
  KanbanTaskState,
  ResolvedTeamMember,
  TeamTaskWithKanban,
} from '@shared/types';

export interface GlobalTaskDetailModel {
  task: GlobalTask | null;
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
    selectedTeamName,
    selectedTeamData,
    selectedTeamMembers,
    selectedTeamLoading,
    selectedTeamError,
    selectTeam,
    openTeamTab,
    setPendingReviewRequest,
    globalTasks,
  } = useStore(
    useShallow((state) => ({
      selectedTeamName: state.selectedTeamName,
      selectedTeamData: state.selectedTeamData,
      selectedTeamMembers: selectResolvedMembersForTeamName(state, state.selectedTeamName),
      selectedTeamLoading: state.selectedTeamLoading,
      selectedTeamError: state.selectedTeamError,
      selectTeam: state.selectTeam,
      openTeamTab: state.openTeamTab,
      setPendingReviewRequest: state.setPendingReviewRequest,
      globalTasks: state.globalTasks,
    }))
  );

  const hasTargetTeamData = hasSelectedTargetTeamData(
    teamName,
    selectedTeamName,
    selectedTeamData?.teamName
  );

  useEffect(() => {
    if (!teamName || !taskId) return;
    if (selectedTeamName === teamName && (selectedTeamData || selectedTeamLoading)) return;
    void selectTeam(teamName, { skipProjectAutoSelect: true });
  }, [selectTeam, selectedTeamData, selectedTeamLoading, selectedTeamName, taskId, teamName]);

  const taskMap = useMemo(() => {
    const map = new Map<string, TeamTaskWithKanban>();
    if (!teamName || !taskId) return map;
    if (hasTargetTeamData && selectedTeamData) {
      for (const task of selectedTeamData.tasks) map.set(task.id, task);
      return map;
    }
    for (const task of globalTasks) {
      if (task.teamName === teamName) map.set(task.id, task);
    }
    return map;
  }, [globalTasks, hasTargetTeamData, selectedTeamData, taskId, teamName]);

  const members = useMemo(
    () => (hasTargetTeamData ? selectedTeamMembers.filter((member) => !member.removedAt) : []),
    [hasTargetTeamData, selectedTeamMembers]
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

  const task = (taskMap.get(taskId) as GlobalTask | undefined) ?? null;
  const loading = shouldKeepGlobalTaskDialogLoading({
    teamName,
    taskId,
    selectedTeamName,
    selectedTeamDataPresent: hasTargetTeamData,
    selectedTeamLoading,
    selectedTeamError,
    hasTaskInMap: taskMap.has(taskId),
  });

  return {
    task,
    taskMap,
    members,
    kanbanTaskState: hasTargetTeamData ? selectedTeamData?.kanbanState.tasks[taskId] : undefined,
    loading: !hasTargetTeamData && loading,
    isFullTeamLoaded: hasTargetTeamData,
    openTeam,
    viewChanges,
  };
}
