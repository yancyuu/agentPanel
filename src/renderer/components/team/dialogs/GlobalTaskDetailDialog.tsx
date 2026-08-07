import { useStore } from '@renderer/store';
import { ExternalLink } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { TaskDetailDialog } from './TaskDetailDialog';
import { useGlobalTaskDetailModel } from './useGlobalTaskDetailModel';

/**
 * Global wrapper around the shared task detail panel.
 * Mounted at layout level so it can be opened from anywhere without navigating
 * to the team page first.
 */
export const GlobalTaskDetailDialog = (): React.JSX.Element | null => {
  const { globalTaskDetail, closeGlobalTaskDetail } = useStore(
    useShallow((state) => ({
      globalTaskDetail: state.globalTaskDetail,
      closeGlobalTaskDetail: state.closeGlobalTaskDetail,
    }))
  );
  const teamName = globalTaskDetail?.teamName ?? '';
  const taskId = globalTaskDetail?.taskId ?? '';
  const model = useGlobalTaskDetailModel(teamName, taskId, closeGlobalTaskDetail);

  if (!globalTaskDetail) return null;

  return (
    <TaskDetailDialog
      open
      variant={model.isFullTeamLoaded ? 'team' : 'global'}
      loading={model.loading}
      task={model.task}
      teamName={teamName}
      kanbanTaskState={model.kanbanTaskState}
      taskMap={model.taskMap}
      members={model.members}
      onClose={closeGlobalTaskDetail}
      onOwnerChange={undefined}
      onViewChanges={
        model.isFullTeamLoaded
          ? (viewTaskId, filePath) => model.viewChanges(viewTaskId, filePath)
          : undefined
      }
      headerExtra={
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
          onClick={() => model.openTeam()}
        >
          <ExternalLink size={12} />
          打开团队
        </button>
      }
    />
  );
};
