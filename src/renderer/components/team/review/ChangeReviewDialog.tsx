import React, { useCallback, useEffect } from 'react';

import { useStore } from '@renderer/store';
import { X } from 'lucide-react';

import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type { EditorSelectionAction } from '@shared/types/editor';
import type { FileChangeSummary } from '@shared/types/review';

interface ChangeReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamName: string;
  mode: 'agent' | 'task';
  memberName?: string;
  taskId?: string;
  initialFilePath?: string;
  taskChangeRequestOptions?: TaskChangeRequestOptions;
  projectPath?: string;
  onEditorAction?: (action: EditorSelectionAction) => void;
}

function formatFileStatus(file: FileChangeSummary): string {
  if (file.ledgerSummary?.deletedInTask) return 'deleted';
  if (file.isNewFile || file.ledgerSummary?.createdInTask) return 'added';
  return 'modified';
}

export const ChangeReviewDialog: React.FC<ChangeReviewDialogProps> = ({
  open,
  onOpenChange,
  teamName,
  mode,
  taskId,
  taskChangeRequestOptions,
}) => {
  const changeSetLoading = useStore((s) => s.changeSetLoading);
  const changeSetError = useStore((s) => s.changeSetError);
  const activeChangeSet = useStore((s) => s.activeChangeSet);
  const fetchTaskChanges = useStore((s) => s.fetchTaskChanges);

  useEffect(() => {
    if (open && taskId && taskChangeRequestOptions && fetchTaskChanges) {
      void fetchTaskChanges(teamName, taskId, taskChangeRequestOptions);
    }
  }, [open, teamName, taskId, taskChangeRequestOptions, fetchTaskChanges]);

  const activeTaskId =
    activeChangeSet && 'taskId' in activeChangeSet ? activeChangeSet.taskId : undefined;
  const files: FileChangeSummary[] =
    mode === 'task' && activeTaskId !== taskId
      ? []
      : Array.isArray(activeChangeSet?.files)
        ? activeChangeSet.files
        : [];

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  if (!open) return null;

  const loading = changeSetLoading && files.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-[var(--color-text)]">变更查看</h2>
          {files.length > 0 && (
            <span className="text-xs text-[var(--color-text-muted)]">{files.length} 个文件</span>
          )}
        </div>
        <button
          onClick={handleClose}
          className="rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-4 py-3">
        {loading && (
          <div className="flex items-center justify-center py-12 text-[var(--color-text-muted)]">
            <span className="text-sm">加载变更中...</span>
          </div>
        )}

        {changeSetError && (
          <div className="mx-auto max-w-xl rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-center">
            <p className="text-sm text-red-400">{changeSetError}</p>
          </div>
        )}

        {!loading && !changeSetError && files.length > 0 && (
          <div className="space-y-1">
            {files.map((file) => {
              const status = formatFileStatus(file);
              return (
                <div
                  key={file.filePath}
                  className={
                    status === 'added'
                      ? 'flex items-center gap-2 rounded-md bg-emerald-500/5 px-3 py-2 font-mono text-xs text-emerald-400'
                      : status === 'deleted'
                        ? 'flex items-center gap-2 rounded-md bg-red-500/5 px-3 py-2 font-mono text-xs text-red-400'
                        : 'flex items-center gap-2 rounded-md bg-indigo-500/5 px-3 py-2 font-mono text-xs text-indigo-400'
                  }
                >
                  <span className="w-12 shrink-0 text-center font-sans text-[10px] uppercase tracking-wide opacity-60">
                    {status}
                  </span>
                  <span className="min-w-0 truncate">{file.filePath}</span>
                  <span className="ml-auto shrink-0 font-sans text-[var(--color-text-muted)]">
                    +{file.linesAdded} -{file.linesRemoved}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {!loading && !changeSetError && files.length === 0 && (
          <div className="flex items-center justify-center py-12 text-[var(--color-text-muted)]">
            <span className="text-sm">未记录文件变更</span>
          </div>
        )}
      </div>
    </div>
  );
};
