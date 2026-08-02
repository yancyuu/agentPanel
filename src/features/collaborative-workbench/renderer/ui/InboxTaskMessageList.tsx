import { cn } from '@renderer/lib/utils';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { RefreshCw, Search } from 'lucide-react';

import type { InboxTaskMessageProjection } from '../utils/inboxProjection';

interface InboxTaskMessageListProps {
  messages: InboxTaskMessageProjection[];
  selectedKey: string | null;
  query: string;
  onQueryChange(query: string): void;
  teamFilter: string;
  onTeamFilterChange(teamName: string): void;
  teamOptions: [string, string][];
  onSelect(key: string): void;
  onRefresh(): void;
  loading: boolean;
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function getTaskFeedbackState(entry: InboxTaskMessageProjection): {
  label: string;
  className: string;
} {
  if (entry.task.needsClarification === 'user') {
    return {
      label: '待你补充',
      className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    };
  }
  // 只有「等用户评审」是用户的行动项，优先级高于任务状态；
  // needsFix（返工中）按任务状态归入「进行中」，approved 归入「已完成」。
  if (entry.task.reviewState === 'review') {
    return {
      label: '待你评审',
      className: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    };
  }
  if (entry.task.status === 'completed') {
    return {
      label: '已完成',
      className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    };
  }
  if (entry.task.status === 'pending') {
    return {
      label: '待处理',
      className: 'bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]',
    };
  }
  return {
    label: '进行中',
    className: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  };
}

export function InboxTaskMessageList({
  messages,
  selectedKey,
  query,
  onQueryChange,
  teamFilter,
  onTeamFilterChange,
  teamOptions,
  onSelect,
  onRefresh,
  loading,
}: Readonly<InboxTaskMessageListProps>): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
      <div className="space-y-3 border-b border-[var(--surface-border-subtle)] p-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text)]">任务反馈</h2>
          <p className="mt-1 text-[11px] leading-4 text-[var(--color-text-muted)]">
            长周期任务的提问、进展和交付会在这里提醒你。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={teamFilter}
            onChange={(event) => onTeamFilterChange(event.target.value)}
            aria-label="按团队筛选消息"
            className="h-8 min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 text-xs text-[var(--color-text-secondary)] outline-none"
          >
            <option value="all">全部团队</option>
            {teamOptions.map(([teamName, displayName]) => (
              <option key={teamName} value={teamName}>
                {displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="刷新消息"
            onClick={onRefresh}
            className="shrink-0 rounded-md p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索任务或反馈"
            className="h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] pl-8 pr-2 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-border-emphasis)]"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="任务反馈列表">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[var(--color-text-muted)]">
            <p className="text-sm">暂时没有需要处理的任务反馈</p>
            <p className="text-xs opacity-70">智能体有新进展、问题或交付时，会在这里提醒你。</p>
          </div>
        ) : (
          messages.map((entry) => {
            const selected = selectedKey === entry.key;
            const unread = entry.unreadCount > 0;
            const preview = stripAgentBlocks(entry.latestMessage.text).trim();
            const feedbackState = getTaskFeedbackState(entry);
            return (
              <button
                key={entry.key}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(entry.key)}
                className={cn(
                  'relative flex w-full gap-3 border-b border-[var(--surface-border-subtle)] px-3 py-3 text-left transition-all duration-150',
                  selected
                    ? 'bg-[var(--color-surface-selected)] before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand'
                    : 'hover:bg-[var(--color-surface-hover)]'
                )}
              >
                <div className="relative mt-0.5 shrink-0">
                  <img
                    src={agentAvatarUrl(entry.latestMessage.author, 32)}
                    alt=""
                    className="size-8 rounded-full bg-[var(--color-surface-raised)]"
                    loading="lazy"
                  />
                  <span
                    className={cn(
                      'absolute -left-1.5 top-1/2 size-2 -translate-y-1/2 rounded-full bg-red-500 transition-[opacity,transform] duration-150',
                      unread ? 'scale-100 opacity-100' : 'scale-75 opacity-0'
                    )}
                    aria-label={unread ? '未读' : undefined}
                    aria-hidden={!unread}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-xs font-medium',
                        unread ? 'text-[var(--color-text)]' : 'text-[var(--color-text-secondary)]'
                      )}
                    >
                      {entry.task.subject}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium',
                        feedbackState.className
                      )}
                    >
                      {feedbackState.label}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]">
                    {preview}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                    <span className="truncate">
                      {entry.latestMessage.author === entry.task.teamDisplayName
                        ? entry.latestMessage.author
                        : `${entry.latestMessage.author} · ${entry.task.teamDisplayName}`}
                    </span>
                    <span className="ml-auto shrink-0">
                      {formatMessageTime(entry.latestMessage.createdAt)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
