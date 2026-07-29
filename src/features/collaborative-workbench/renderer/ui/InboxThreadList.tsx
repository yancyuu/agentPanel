import { useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { Mail, Plus, RefreshCw, Search } from 'lucide-react';

import type { InboxRecipientOption } from '../hooks/useInboxThreads';
import type { InboxThreadProjection } from '../utils/inboxThreadProjection';

interface InboxThreadListProps {
  threads: InboxThreadProjection[];
  selectedKey: string | null;
  query: string;
  onQueryChange(query: string): void;
  teamFilter: string;
  onTeamFilterChange(teamName: string): void;
  teamOptions: [string, string][];
  recipientOptions: InboxRecipientOption[];
  onCreateThread(teamName: string, memberName: string): void;
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
  recipientOptions,
  onCreateThread,
  onSelect,
  onRefresh,
  loading,
}: Readonly<InboxThreadListProps>): React.JSX.Element {
  const [composeOpen, setComposeOpen] = useState(false);
  const [recipientKey, setRecipientKey] = useState('');
  const selectedRecipient = recipientOptions.find(
    (option) => `${option.teamName}\u0000${option.memberName}` === recipientKey
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
      <div className="space-y-2 border-b border-[var(--surface-border-subtle)] p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setComposeOpen((current) => !current)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90"
          >
            <Plus size={14} />
            新建对话
          </button>
          <select
            value={teamFilter}
            onChange={(event) => onTeamFilterChange(event.target.value)}
            aria-label="按团队筛选对话"
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
            aria-label="刷新对话"
            onClick={onRefresh}
            className="shrink-0 rounded-md p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>

        {composeOpen ? (
          <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2">
            <select
              value={recipientKey}
              onChange={(event) => setRecipientKey(event.target.value)}
              aria-label="选择数字员工"
              className="h-8 min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] outline-none"
            >
              <option value="">选择数字员工</option>
              {recipientOptions.map((option) => {
                const value = `${option.teamName}\u0000${option.memberName}`;
                return (
                  <option key={value} value={value}>
                    {option.teamDisplayName} · {option.memberName}
                  </option>
                );
              })}
            </select>
            <button
              type="button"
              disabled={!selectedRecipient}
              onClick={() => {
                if (!selectedRecipient) return;
                onCreateThread(selectedRecipient.teamName, selectedRecipient.memberName);
                setComposeOpen(false);
                setRecipientKey('');
              }}
              className="h-8 shrink-0 rounded-md bg-[var(--color-text)] px-3 text-xs font-medium text-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              开始对话
            </button>
          </div>
        ) : null}

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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="对话邮件列表">
        {threads.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[var(--color-text-muted)]">
            <Mail size={30} className="opacity-30" />
            <p className="text-sm">收件箱还是空的</p>
            <p className="text-xs opacity-70">点击上方“新建对话”，选择数字员工开始沟通。</p>
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
