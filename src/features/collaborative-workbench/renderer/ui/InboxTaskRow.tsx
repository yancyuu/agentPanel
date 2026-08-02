import { Badge } from '@renderer/components/ui/badge';
import { cn } from '@renderer/lib/utils';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import { formatDistanceToNow } from 'date-fns';
import { CheckCircle2, Circle, CircleDot, HelpCircle, MessageSquare } from 'lucide-react';

import type { InboxTaskProjection } from '../utils/inboxProjection';

export interface InboxTaskRowProps {
  entry: InboxTaskProjection;
  selected: boolean;
  onSelect(): void;
}

const attentionLabels = {
  clarification: '等待说明',
  unread: '新动态',
  review: '需要关注',
  unassigned: '未分配',
  recent: '',
} as const;

export function InboxTaskRow({
  entry,
  selected,
  onSelect,
}: Readonly<InboxTaskRowProps>): React.JSX.Element {
  const { task, unreadCount, attention } = entry;
  const date = new Date(task.updatedAt ?? task.createdAt ?? 0);
  const relativeTime = Number.isNaN(date.getTime())
    ? ''
    : formatDistanceToNow(date, { addSuffix: true });
  const StatusIcon =
    task.status === 'completed' ? CheckCircle2 : task.status === 'in_progress' ? CircleDot : Circle;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group w-full rounded-md px-3 py-2.5 text-left transition-colors',
        selected
          ? 'bg-surface-selected text-[var(--color-text)]'
          : 'hover:bg-surface-hover text-[var(--color-text-secondary)]'
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <StatusIcon
          size={15}
          className={cn(
            'mt-0.5 shrink-0',
            task.status === 'completed'
              ? 'text-success'
              : task.status === 'in_progress'
                ? 'text-orange-500 dark:text-orange-400'
                : 'text-[var(--color-text-muted)]'
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span
              className={cn(
                'mt-1.5 size-2 shrink-0 rounded-full bg-red-500 transition-opacity',
                unreadCount > 0 ? 'opacity-100' : 'opacity-0'
              )}
              aria-label={unreadCount > 0 ? '有未读任务反馈' : undefined}
              aria-hidden={unreadCount === 0}
            />
            <p className={cn('min-w-0 flex-1 truncate text-sm', selected && 'font-medium')}>
              {task.subject}
            </p>
            {attention !== 'recent' ? (
              <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] font-normal">
                {attention === 'clarification' ? <HelpCircle size={10} className="mr-1" /> : null}
                {attentionLabels[attention]}
              </Badge>
            ) : null}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
            <span className="shrink-0 font-mono">
              #{task.displayId ?? deriveTaskDisplayId(task.id)}
            </span>
            <span aria-hidden>·</span>
            <span className="truncate">{task.teamDisplayName}</span>
            {task.owner ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{task.owner}</span>
              </>
            ) : null}
            <span className="ml-auto shrink-0">{relativeTime}</span>
          </div>
          {unreadCount > 0 ? (
            <div className="mt-1.5 flex items-center gap-1 text-xs text-info">
              <MessageSquare size={11} />
              {unreadCount} 条未读动态
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}
