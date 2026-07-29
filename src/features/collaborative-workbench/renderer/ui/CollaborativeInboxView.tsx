import { useEffect, useState } from 'react';

import { TaskDetailPanel } from '@renderer/components/team/dialogs/TaskDetailPanel';
import { useGlobalTaskDetailModel } from '@renderer/components/team/dialogs/useGlobalTaskDetailModel';
import { cn } from '@renderer/lib/utils';
import { ArrowLeft, ClipboardList, Mail } from 'lucide-react';

import { useCollaborativeInbox } from '../hooks/useCollaborativeInbox';
import { useInboxThreads } from '../hooks/useInboxThreads';

import { InboxTaskList } from './InboxTaskList';
import { InboxThreadDetail } from './InboxThreadDetail';
import { InboxThreadList } from './InboxThreadList';

type InboxMode = 'messages' | 'tasks';

export function CollaborativeInboxView(): React.JSX.Element {
  const taskInbox = useCollaborativeInbox();
  const threadInbox = useInboxThreads();
  const [mode, setMode] = useState<InboxMode>('messages');
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const selectedTask = taskInbox.selectedTask;
  const taskModel = useGlobalTaskDetailModel(
    selectedTask?.task.teamName ?? '',
    selectedTask?.task.id ?? ''
  );

  useEffect(() => {
    if (!threadInbox.navigationRequestAt) return;
    setMode('messages');
    setMobileDetailOpen(true);
  }, [threadInbox.navigationRequestAt]);

  useEffect(() => {
    if (mode === 'tasks' && !selectedTask) setMobileDetailOpen(false);
    if (mode === 'messages' && !threadInbox.selectedThread) setMobileDetailOpen(false);
  }, [mode, selectedTask, threadInbox.selectedThread]);

  return (
    <div className="size-full min-h-0 min-w-0">
      <div className="grid size-full min-h-0 min-w-0 md:grid-cols-[minmax(300px,360px)_minmax(340px,1fr)]">
        <div
          className={`${mobileDetailOpen ? 'hidden md:flex' : 'flex'} min-h-0 flex-col border-r border-[var(--surface-border-subtle)]`}
        >
          <div
            role="tablist"
            aria-label="收件箱内容"
            className="flex shrink-0 items-center gap-1 border-b border-[var(--surface-border-subtle)] bg-[var(--color-surface)] px-3 py-2"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'messages'}
              onClick={() => {
                setMode('messages');
                setMobileDetailOpen(false);
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                mode === 'messages'
                  ? 'bg-[var(--color-surface-selected)] font-medium text-[var(--color-text)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]'
              )}
            >
              <Mail size={13} />
              私信
              {threadInbox.threads.some((thread) => thread.unread) ? (
                <span className="size-2 rounded-full bg-red-500" aria-label="有未读私信" />
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'tasks'}
              onClick={() => {
                setMode('tasks');
                setMobileDetailOpen(false);
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                mode === 'tasks'
                  ? 'bg-[var(--color-surface-selected)] font-medium text-[var(--color-text)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]'
              )}
            >
              <ClipboardList size={13} />
              任务
            </button>
          </div>

          <div className="min-h-0 flex-1">
            {mode === 'messages' ? (
              <InboxThreadList
                threads={threadInbox.threads}
                selectedKey={threadInbox.selectedKey}
                query={threadInbox.query}
                onQueryChange={threadInbox.setQuery}
                teamFilter={threadInbox.teamFilter}
                onTeamFilterChange={threadInbox.setTeamFilter}
                teamOptions={threadInbox.teamOptions}
                recipientOptions={threadInbox.recipientOptions}
                onCreateThread={threadInbox.createThread}
                onSelect={(key) => {
                  threadInbox.selectThread(key);
                  setMobileDetailOpen(true);
                }}
                onRefresh={threadInbox.refresh}
                loading={threadInbox.loading}
              />
            ) : (
              <InboxTaskList
                view={taskInbox.view}
                onViewChange={taskInbox.setView}
                query={taskInbox.query}
                onQueryChange={taskInbox.setQuery}
                teamFilter={taskInbox.teamFilter}
                onTeamFilterChange={taskInbox.setTeamFilter}
                ownerFilter={taskInbox.ownerFilter}
                onOwnerFilterChange={taskInbox.setOwnerFilter}
                teamOptions={taskInbox.teamOptions}
                ownerOptions={taskInbox.ownerOptions}
                tasks={taskInbox.tasks}
                selectedKey={taskInbox.selectedKey}
                onSelect={(key) => {
                  taskInbox.selectTask(key);
                  setMobileDetailOpen(true);
                }}
                onRefresh={taskInbox.refresh}
                loading={taskInbox.loading}
                error={taskInbox.error}
              />
            )}
          </div>
        </div>

        <div
          className={`${mobileDetailOpen ? 'block' : 'hidden md:block'} min-h-0 min-w-0 bg-page-canvas`}
        >
          {mode === 'messages' ? (
            <InboxThreadDetail
              thread={threadInbox.selectedThread}
              inbox={threadInbox}
              onBack={() => setMobileDetailOpen(false)}
            />
          ) : selectedTask ? (
            <TaskDetailPanel
              key={selectedTask.key}
              presentation="inline"
              variant={taskModel.isFullTeamLoaded ? 'team' : 'global'}
              loading={taskModel.loading}
              task={taskModel.task ?? selectedTask.task}
              teamName={selectedTask.task.teamName}
              kanbanTaskState={taskModel.kanbanTaskState}
              taskMap={
                taskModel.taskMap.size > 0
                  ? taskModel.taskMap
                  : new Map([[selectedTask.task.id, selectedTask.task]])
              }
              members={taskModel.members}
              onScrollToTask={(taskRef) => {
                taskInbox.selectReferencedTask(taskRef);
                setMobileDetailOpen(true);
              }}
              onOwnerChange={
                taskModel.isFullTeamLoaded
                  ? (taskId, owner) => {
                      void taskInbox.updateOwner(selectedTask.task.teamName, taskId, owner);
                    }
                  : undefined
              }
              onViewChanges={
                taskModel.isFullTeamLoaded
                  ? (taskId, filePath) => taskModel.viewChanges(taskId, filePath)
                  : undefined
              }
              headerExtra={
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setMobileDetailOpen(false)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] md:hidden"
                  >
                    <ArrowLeft size={13} />
                    返回列表
                  </button>
                  <button
                    type="button"
                    onClick={() => taskModel.openTeam()}
                    className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                  >
                    打开团队
                  </button>
                </div>
              }
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[var(--color-text-muted)]">
              <ClipboardList size={34} className="opacity-25" />
              <p className="text-sm">选择一个任务开始协作</p>
              <p className="text-xs opacity-70">任务描述、评论和执行记录会显示在这里。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
