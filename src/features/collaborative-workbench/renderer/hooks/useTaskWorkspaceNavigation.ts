import { useCallback } from 'react';

import { useStore } from '@renderer/store';

export function useTaskWorkspaceNavigation(): {
  openTask: (teamName: string, taskId: string) => void;
} {
  const openTasksTab = useStore((state) => state.openTasksTab);
  const openGlobalTaskDetail = useStore((state) => state.openGlobalTaskDetail);

  const openTask = useCallback(
    (teamName: string, taskId: string): void => {
      openTasksTab();
      openGlobalTaskDetail(teamName, taskId);
    },
    [openGlobalTaskDetail, openTasksTab]
  );

  return { openTask };
}
