import { Input } from '@renderer/components/ui/input';
import { cn } from '@renderer/lib/utils';
import { CheckCircle2, CircleDot, Inbox, RefreshCw, Search } from 'lucide-react';

import { InboxTaskRow } from './InboxTaskRow';

import type { InboxTaskProjection, InboxTaskView } from '../utils/inboxProjection';

export interface InboxTaskListProps {
  view: InboxTaskView;
  onViewChange(view: InboxTaskView): void;
  query: string;
  onQueryChange(query: string): void;
  teamFilter: string;
  onTeamFilterChange(teamName: string): void;
  ownerFilter: string;
  onOwnerFilterChange(owner: string): void;
  teamOptions: [string, string][];
  ownerOptions: string[];
  tasks: InboxTaskProjection[];
  selectedKey: string | null;
  onSelect(key: string): void;
  onRefresh(): void;
  loading?: boolean;
  error?: string | null;
}

const views: { id: InboxTaskView; label: string; icon: React.ReactNode }[] = [
  { id: 'inbox', label: '收件箱', icon: <Inbox size={13} /> },
  { id: 'in_progress', label: '进行中', icon: <CircleDot size={13} /> },
  { id: 'completed', label: '已完成', icon: <CheckCircle2 size={13} /> },
];

export function InboxTaskList({
  view,
  onViewChange,
  query,
  onQueryChange,
  teamFilter,
  onTeamFilterChange,
  ownerFilter,
  onOwnerFilterChange,
  teamOptions,
  ownerOptions,
  tasks,
  selectedKey,
  onSelect,
  onRefresh,
  loading = false,
  error,
}: Readonly<InboxTaskListProps>): React.JSX.Element {
  const selectClass =
    'h-8 min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

  return (
    <div className="flex h-full min-w-0 flex-col bg-[var(--color-surface)]">
      <div className="border-b border-[var(--surface-border-subtle)] p-3">
        <div
          role="tablist"
          aria-label="任务收件箱视图"
          className="flex items-center gap-1 rounded-md bg-[var(--color-surface-raised)] p-1"
        >
          {views.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                'flex h-7 flex-1 items-center justify-center gap-1 rounded px-2 text-xs transition-colors',
                view === item.id
                  ? 'bg-surface-selected font-medium text-[var(--color-text)]'
                  : 'hover:bg-surface-hover text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
        <div className="relative mt-3">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索任务、团队或负责人"
            aria-label="搜索任务"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <select
            aria-label="筛选团队"
            value={teamFilter}
            onChange={(event) => onTeamFilterChange(event.target.value)}
            className={cn(selectClass, 'flex-1')}
          >
            <option value="all">全部团队</option>
            {teamOptions.map(([teamName, displayName]) => (
              <option key={teamName} value={teamName}>
                {displayName}
              </option>
            ))}
          </select>
          <select
            aria-label="筛选负责人"
            value={ownerFilter}
            onChange={(event) => onOwnerFilterChange(event.target.value)}
            className={cn(selectClass, 'flex-1')}
          >
            <option value="all">全部负责人</option>
            <option value="unassigned">未分配</option>
            {ownerOptions.map((owner) => (
              <option key={owner} value={owner}>
                {owner}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="刷新任务"
            className="hover:bg-surface-hover flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[var(--color-text-muted)]">
            <Inbox size={28} className="opacity-30" />
            <p className="text-sm">当前视图没有任务</p>
            <p className="text-xs leading-5 opacity-70">调整筛选条件，或刷新后再查看。</p>
          </div>
        ) : (
          <div className="space-y-1">
            {tasks.map((entry) => (
              <InboxTaskRow
                key={entry.key}
                entry={entry}
                selected={entry.key === selectedKey}
                onSelect={() => onSelect(entry.key)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
