import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CollaborativeInboxView,
  WorkbenchPageHeader,
} from '@features/collaborative-workbench/renderer';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import {
  Calendar,
  CheckCircle2,
  ClipboardList,
  Columns3,
  Inbox,
  PlayCircle,
  RefreshCw,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { SchedulesView } from '../schedules/SchedulesView';
import { KanbanColumn } from '../team/kanban/KanbanColumn';

import type { GlobalTask, TeamTaskStatus } from '@shared/types';

type TasksSubTab = 'inbox' | 'overview' | 'schedules';
type OverviewStatus = Extract<TeamTaskStatus, 'pending' | 'in_progress' | 'completed'>;
interface OverviewTaskEntry {
  task: GlobalTask;
  updatedAtMs: number;
}

const SUB_TABS: { id: TasksSubTab; label: string; icon: React.ReactNode }[] = [
  { id: 'inbox', label: '收件箱', icon: <Inbox size={13} /> },
  { id: 'overview', label: '看板', icon: <Columns3 size={13} /> },
  { id: 'schedules', label: '定时任务', icon: <Calendar size={13} /> },
];

const COLUMNS: {
  id: OverviewStatus;
  title: string;
  headerBg: string;
  bodyBg: string;
  icon: React.ReactNode;
}[] = [
  {
    id: 'pending',
    title: '待处理',
    headerBg: 'rgba(148, 163, 184, 0.08)',
    bodyBg: 'rgba(148, 163, 184, 0.02)',
    icon: <ClipboardList size={13} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  {
    id: 'in_progress',
    title: '进行中',
    headerBg: 'rgba(6, 182, 212, 0.08)',
    bodyBg: 'rgba(6, 182, 212, 0.02)',
    icon: <PlayCircle size={13} className="shrink-0 text-cyan-400/60" />,
  },
  {
    id: 'completed',
    title: '已完成',
    headerBg: 'rgba(34, 197, 94, 0.08)',
    bodyBg: 'rgba(34, 197, 94, 0.02)',
    icon: <CheckCircle2 size={13} className="shrink-0 text-green-400/60" />,
  },
];

function isOverviewStatus(status: TeamTaskStatus): status is OverviewStatus {
  return status === 'pending' || status === 'in_progress' || status === 'completed';
}

function toTimestamp(raw: string | Date | null | undefined): number {
  if (!raw) return 0;
  const time = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(time) ? time : 0;
}

function buildOptionLabel(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export const TasksView = (): React.JSX.Element => {
  const [activeTab, setActiveTab] = useState<TasksSubTab>('inbox');
  const tabRefs = useRef<Partial<Record<TasksSubTab, HTMLButtonElement>>>({});

  const selectTabFromKeyboard = (event: React.KeyboardEvent, currentIndex: number): void => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % SUB_TABS.length;
    if (event.key === 'ArrowLeft')
      nextIndex = (currentIndex - 1 + SUB_TABS.length) % SUB_TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = SUB_TABS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = SUB_TABS[nextIndex];
    setActiveTab(nextTab.id);
    tabRefs.current[nextTab.id]?.focus();
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-page-canvas">
      <WorkbenchPageHeader title="收件箱" description="集中处理跨团队任务、评论与 Agent 执行状态" />
      <div
        role="tablist"
        aria-label="任务工作台视图"
        aria-orientation="horizontal"
        className="flex items-center gap-0 border-b border-[var(--surface-border-subtle)] px-4 pt-3"
      >
        {SUB_TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[tab.id] = element ?? undefined;
            }}
            id={`tasks-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`tasks-tabpanel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => selectTabFromKeyboard(event, index)}
            className={cn(
              'flex items-center gap-1.5 border-b-2 px-3 pb-2 text-xs transition-colors',
              activeTab === tab.id
                ? 'border-[var(--color-text)] font-medium text-[var(--color-text)]'
                : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {SUB_TABS.map((tab) => (
          <div
            key={tab.id}
            id={`tasks-tabpanel-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`tasks-tab-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            hidden={activeTab !== tab.id}
            className="h-full min-h-0 overflow-hidden"
          >
            {activeTab === tab.id && tab.id === 'inbox' ? <CollaborativeInboxView /> : null}
            {activeTab === tab.id && tab.id === 'overview' ? (
              <div className="h-full overflow-auto">
                <TaskOverviewPool />
              </div>
            ) : null}
            {activeTab === tab.id && tab.id === 'schedules' ? (
              <div className="h-full overflow-auto">
                <SchedulesView />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

const TaskOverviewPool = (): React.JSX.Element => {
  const {
    globalTasks,
    globalTasksLoading,
    globalTasksInitialized,
    fetchAllTasks,
    openGlobalTaskDetail,
  } = useStore(
    useShallow((s) => ({
      globalTasks: s.globalTasks,
      globalTasksLoading: s.globalTasksLoading,
      globalTasksInitialized: s.globalTasksInitialized,
      fetchAllTasks: s.fetchAllTasks,
      openGlobalTaskDetail: s.openGlobalTaskDetail,
    }))
  );
  const [teamFilter, setTeamFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | OverviewStatus>('all');
  const [ownerFilter, setOwnerFilter] = useState('all');

  useEffect(() => {
    void fetchAllTasks();
  }, [fetchAllTasks]);

  const overviewTaskEntries = useMemo<OverviewTaskEntry[]>(
    () =>
      globalTasks
        .filter((task) => isOverviewStatus(task.status) && !task.teamDeleted)
        .map((task) => ({
          task,
          updatedAtMs: toTimestamp(task.updatedAt ?? task.createdAt),
        })),
    [globalTasks]
  );

  const overviewTasks = useMemo(
    () => overviewTaskEntries.map((entry) => entry.task),
    [overviewTaskEntries]
  );

  const teamOptions = useMemo(
    () =>
      Array.from(
        new Map(overviewTasks.map((task) => [task.teamName, task.teamDisplayName])).entries()
      ).sort((a, b) => a[1].localeCompare(b[1])),
    [overviewTasks]
  );

  const ownerOptions = useMemo(() => {
    const owners = new Set<string>();
    for (const task of overviewTasks) {
      if (task.owner?.trim()) owners.add(task.owner.trim());
    }
    return Array.from(owners).sort((a, b) => a.localeCompare(b));
  }, [overviewTasks]);

  const filteredTasks = useMemo(
    () =>
      overviewTaskEntries
        .filter(({ task }) => teamFilter === 'all' || task.teamName === teamFilter)
        .filter(({ task }) => statusFilter === 'all' || task.status === statusFilter)
        .filter(({ task }) => ownerFilter === 'all' || task.owner === ownerFilter)
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
        .map((entry) => entry.task),
    [overviewTaskEntries, ownerFilter, statusFilter, teamFilter]
  );

  const grouped = useMemo(() => {
    const map = new Map<OverviewStatus, GlobalTask[]>();
    for (const column of COLUMNS) {
      map.set(column.id, []);
    }
    for (const task of filteredTasks) {
      if (isOverviewStatus(task.status)) {
        map.get(task.status)?.push(task);
      }
    }
    return map;
  }, [filteredTasks]);

  const clearFilters = useCallback(() => {
    setTeamFilter('all');
    setStatusFilter('all');
    setOwnerFilter('all');
  }, []);

  const hasFilters = teamFilter !== 'all' || statusFilter !== 'all' || ownerFilter !== 'all';

  if (globalTasksLoading && !globalTasksInitialized) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
        加载 Loop 任务…
      </div>
    );
  }

  const selectCls =
    'h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-emphasis)] focus:text-[var(--color-text)]';

  return (
    <div className="flex h-full min-w-0 flex-col gap-3 p-4">
      {/* Compact filter row */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          className={selectCls}
        >
          <option value="all">全部 Loop workspace</option>
          {teamOptions.map(([teamName, displayName]) => (
            <option key={teamName} value={teamName}>
              {displayName}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | OverviewStatus)}
          className={selectCls}
        >
          <option value="all">全部状态</option>
          <option value="pending">待处理</option>
          <option value="in_progress">进行中</option>
          <option value="completed">已完成</option>
        </select>

        <select
          value={ownerFilter}
          onChange={(e) => setOwnerFilter(e.target.value)}
          className={selectCls}
        >
          <option value="all">全部负责人</option>
          {ownerOptions.map((owner) => (
            <option key={owner} value={owner}>
              {owner}
            </option>
          ))}
        </select>

        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            清空筛选
          </button>
        )}

        <button
          type="button"
          className="ml-auto text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          onClick={() => void fetchAllTasks()}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {overviewTasks.length === 0 ? (
        // Genuinely empty task bus (not just hidden by filters) — show an
        // explanatory empty state so a fresh user / QA reader doesn't mistake
        // the light content for a rendering bug (QA F-3).
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <ClipboardList size={28} className="text-[var(--color-text-muted)] opacity-30" />
          <p className="text-sm text-[var(--color-text-muted)]">暂无 Loop 任务</p>
          <p className="max-w-sm text-[11px] leading-5 text-[var(--color-text-muted)] opacity-60">
            各团队看板上 pending / in_progress / completed 的任务会自动汇总到这里。
          </p>
        </div>
      ) : (
        /* Kanban columns — reuse team kanban styling */
        <div className="w-full min-w-0 max-w-full overflow-x-auto overflow-y-hidden pb-6">
          <div className="grid min-w-[900px] grid-cols-3 items-start gap-3">
            {COLUMNS.map((column) => {
              const tasks = grouped.get(column.id) ?? [];
              return (
                <KanbanColumn
                  key={column.id}
                  title={column.title}
                  count={tasks.length}
                  icon={column.icon}
                  headerBg={column.headerBg}
                  bodyBg={column.bodyBg}
                >
                  {tasks.length === 0 ? (
                    <div className="py-6 text-center text-[11px] text-[var(--color-text-muted)] opacity-40">
                      暂无任务
                    </div>
                  ) : (
                    tasks.map((task) => (
                      <GlobalOverviewTaskCard
                        key={`${task.teamName}:${task.id}`}
                        task={task}
                        onOpenTask={openGlobalTaskDetail}
                      />
                    ))
                  )}
                </KanbanColumn>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const GlobalOverviewTaskCard = memo(function GlobalOverviewTaskCard({
  task,
  onOpenTask,
}: {
  task: GlobalTask;
  onOpenTask: (teamName: string, taskId: string) => void;
}): React.JSX.Element {
  const ownerLabel = buildOptionLabel(task.owner, '未分配');
  const handleOpen = useCallback(() => {
    onOpenTask(task.teamName, task.id);
  }, [onOpenTask, task.id, task.teamName]);
  return (
    <button
      type="button"
      className="w-full rounded-md border px-2.5 py-2 text-left transition-colors hover:border-[var(--color-border-emphasis)]"
      style={{
        borderColor: 'var(--color-border)',
        backgroundColor: 'var(--color-surface-raised)',
      }}
      onClick={handleOpen}
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-0.5 shrink-0 text-[9px] tabular-nums text-[var(--color-text-muted)] opacity-50">
          #{task.displayId ?? deriveTaskDisplayId(task.id)}
        </span>
        <h5
          className="line-clamp-2 min-w-0 flex-1 text-[11px] font-medium"
          style={{ color: 'var(--color-text)' }}
        >
          {task.subject}
        </h5>
      </div>
      <div
        className="mt-1.5 flex items-center gap-1.5 text-[10px]"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <span>{task.teamDisplayName}</span>
        <span style={{ opacity: 0.3 }}>·</span>
        <span>{ownerLabel}</span>
      </div>
    </button>
  );
});
