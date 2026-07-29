import { cn } from '@renderer/lib/utils';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { Mail, RefreshCw, Search } from 'lucide-react';

import type { InboxThreadProjection } from '../utils/inboxThreadProjection';

interface InboxThreadListProps {
  threads: InboxThreadProjection[];
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

function formatThreadTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function InboxThreadList({
  threads,
  selectedKey,
  query,
  onQueryChange,
  teamFilter,
  onTeamFilterChange,
  teamOptions,
  onSelect,
  onRefresh,
  loading,
}: Readonly<InboxThreadListProps>): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
      <div className="space-y-2 border-b border-[var(--surface-border-subtle)] p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium text-[var(--color-text)]">对话邮件</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              每封邮件都是一个可持续回复的对话
            </div>
          </div>
          <button
            type="button"
            aria-label="刷新对话"
            onClick={onRefresh}
            className="rounded-md p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
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
            placeholder="搜索发件人、主题或正文"
            className="h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] pl-8 pr-2 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-border-emphasis)]"
          />
        </div>
        <select
          value={teamFilter}
          onChange={(event) => onTeamFilterChange(event.target.value)}
          aria-label="按团队筛选对话"
          className="h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 text-xs text-[var(--color-text-secondary)] outline-none"
        >
          <option value="all">全部团队</option>
          {teamOptions.map(([teamName, displayName]) => (
            <option key={teamName} value={teamName}>
              {displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="对话邮件列表">
        {threads.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[var(--color-text-muted)]">
            <Mail size={30} className="opacity-30" />
            <p className="text-sm">收件箱还是空的</p>
            <p className="text-xs opacity-70">从数字员工详情点击“发消息”即可新建一封对话邮件。</p>
          </div>
        ) : (
          threads.map((thread) => (
            <button
              key={thread.key}
              type="button"
              role="option"
              aria-selected={selectedKey === thread.key}
              onClick={() => onSelect(thread.key)}
              className={cn(
                'flex w-full gap-3 border-b border-[var(--surface-border-subtle)] px-3 py-3 text-left transition-colors',
                selectedKey === thread.key
                  ? 'bg-[var(--color-surface-selected)]'
                  : 'hover:bg-[var(--color-surface-hover)]'
              )}
            >
              <div className="relative mt-0.5 shrink-0">
                <img
                  src={agentAvatarUrl(thread.participant, 32)}
                  alt=""
                  className="size-8 rounded-full bg-[var(--color-surface-raised)]"
                  loading="lazy"
                />
                {thread.unread ? (
                  <span
                    className="absolute -left-1.5 top-1/2 size-2 -translate-y-1/2 rounded-full bg-red-500"
                    aria-label="未读"
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-xs',
                      thread.unread
                        ? 'font-semibold text-[var(--color-text)]'
                        : 'text-[var(--color-text-secondary)]'
                    )}
                  >
                    {thread.participant}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                    {thread.draft ? '新建' : formatThreadTime(thread.updatedAt)}
                  </span>
                </div>
                <div className="mt-1 truncate text-xs font-medium text-[var(--color-text)]">
                  {thread.subject}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
                  {thread.teamDisplayName} · {thread.preview}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
