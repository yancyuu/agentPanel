import type { GlobalTask } from '@shared/types';

export type InboxTaskView = 'inbox' | 'in_progress' | 'completed';
export type InboxAttentionKind = 'clarification' | 'unread' | 'review' | 'unassigned' | 'recent';

export interface InboxTaskProjection {
  task: GlobalTask;
  key: string;
  attention: InboxAttentionKind;
  attentionRank: number;
  unreadCount: number;
  updatedAtMs: number;
}

export interface InboxProjectionOptions {
  tasks: GlobalTask[];
  view: InboxTaskView;
  query?: string;
  teamName?: string;
  owner?: string;
  unreadCountByTask?: Readonly<Record<string, number>>;
}

export function getGlobalTaskKey(task: Pick<GlobalTask, 'teamName' | 'id'>): string {
  return `${task.teamName}:${task.id}`;
}

function toTimestamp(raw: string | Date | null | undefined): number {
  if (!raw) return 0;
  const timestamp = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function matchesView(task: GlobalTask, view: InboxTaskView): boolean {
  if (view === 'completed') return task.status === 'completed';
  if (view === 'in_progress') return task.status === 'in_progress';
  return task.status === 'pending' || task.status === 'in_progress';
}

function deriveAttention(task: GlobalTask, unreadCount: number): [InboxAttentionKind, number] {
  if (task.needsClarification === 'user') return ['clarification', 0];
  if (unreadCount > 0) return ['unread', 1];
  if (
    task.reviewState === 'needsFix' ||
    task.reviewState === 'review' ||
    task.kanbanColumn === 'review'
  ) {
    return ['review', 2];
  }
  if (!task.owner?.trim()) return ['unassigned', 3];
  return ['recent', 4];
}

export function projectInboxTasks({
  tasks,
  view,
  query = '',
  teamName = 'all',
  owner = 'all',
  unreadCountByTask = {},
}: InboxProjectionOptions): InboxTaskProjection[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return tasks
    .filter((task) => task.status !== 'deleted' && !task.deletedAt && !task.teamDeleted)
    .filter((task) => matchesView(task, view))
    .filter((task) => teamName === 'all' || task.teamName === teamName)
    .filter(
      (task) => owner === 'all' || (owner === 'unassigned' ? !task.owner : task.owner === owner)
    )
    .filter((task) => {
      if (!normalizedQuery) return true;
      return [
        task.subject,
        task.description,
        task.displayId,
        task.id,
        task.teamName,
        task.teamDisplayName,
        task.owner,
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    })
    .map((task) => {
      const key = getGlobalTaskKey(task);
      const unreadCount = unreadCountByTask[key] ?? 0;
      const [attention, attentionRank] = deriveAttention(task, unreadCount);
      return {
        task,
        key,
        attention,
        attentionRank,
        unreadCount,
        updatedAtMs: toTimestamp(task.updatedAt ?? task.createdAt),
      };
    })
    .sort((a, b) => {
      if (view === 'inbox' && a.attentionRank !== b.attentionRank) {
        return a.attentionRank - b.attentionRank;
      }
      if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
      const teamOrder = a.task.teamDisplayName.localeCompare(b.task.teamDisplayName, 'zh-CN');
      if (teamOrder !== 0) return teamOrder;
      return a.key.localeCompare(b.key);
    });
}
