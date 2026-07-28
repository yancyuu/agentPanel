import { TaskDetailPanel } from '@renderer/components/team/dialogs/TaskDetailPanel';
import { useGlobalTaskDetailModel } from '@renderer/components/team/dialogs/useGlobalTaskDetailModel';
import { Inbox } from 'lucide-react';

import { useCollaborativeInbox } from '../hooks/useCollaborativeInbox';

import { InboxTaskList } from './InboxTaskList';

export function CollaborativeInboxView(): React.JSX.Element {
  const inbox = useCollaborativeInbox();
  const selected = inbox.selectedTask;
  const model = useGlobalTaskDetailModel(selected?.task.teamName ?? '', selected?.task.id ?? '');

  return (
    <div className="h-full min-h-0 min-w-0 overflow-x-auto">
      <div className="grid h-full min-h-0 min-w-[620px] grid-cols-[minmax(280px,340px)_minmax(340px,1fr)]">
        <div className="min-h-0 border-r border-[var(--surface-border-subtle)]">
          <InboxTaskList
            view={inbox.view}
            onViewChange={(view) => inbox.setView(view)}
            query={inbox.query}
            onQueryChange={(query) => inbox.setQuery(query)}
            teamFilter={inbox.teamFilter}
            onTeamFilterChange={(teamName) => inbox.setTeamFilter(teamName)}
            ownerFilter={inbox.ownerFilter}
            onOwnerFilterChange={(owner) => inbox.setOwnerFilter(owner)}
            teamOptions={inbox.teamOptions}
            ownerOptions={inbox.ownerOptions}
            tasks={inbox.tasks}
            selectedKey={inbox.selectedKey}
            onSelect={(key) => inbox.selectTask(key)}
            onRefresh={() => inbox.refresh()}
            loading={inbox.loading}
            error={inbox.error}
          />
        </div>
        <div className="min-h-0 min-w-0 bg-page-canvas">
          {selected ? (
            <TaskDetailPanel
              key={selected.key}
              presentation="inline"
              variant={model.isFullTeamLoaded ? 'team' : 'global'}
              loading={model.loading}
              task={model.task ?? selected.task}
              teamName={selected.task.teamName}
              kanbanTaskState={model.kanbanTaskState}
              taskMap={
                model.taskMap.size > 0
                  ? model.taskMap
                  : new Map([[selected.task.id, selected.task]])
              }
              members={model.members}
              onOwnerChange={
                model.isFullTeamLoaded
                  ? (taskId, owner) => inbox.updateOwner(selected.task.teamName, taskId, owner)
                  : undefined
              }
              onViewChanges={
                model.isFullTeamLoaded
                  ? (taskId, filePath) => model.viewChanges(taskId, filePath)
                  : undefined
              }
              headerExtra={
                <button
                  type="button"
                  onClick={() => model.openTeam()}
                  className="hover:bg-surface-hover rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]"
                >
                  打开团队
                </button>
              }
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[var(--color-text-muted)]">
              <Inbox size={34} className="opacity-25" />
              <p className="text-sm">选择一个任务开始协作</p>
              <p className="text-xs opacity-70">任务描述、评论和执行记录会显示在这里。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
