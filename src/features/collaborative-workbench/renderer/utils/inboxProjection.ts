import { getReviewStateFromTask } from '@shared/utils/reviewState';

import type { GlobalTask } from '@shared/types';

export type InboxTaskView = 'in_progress' | 'review' | 'completed';
export type InboxAttentionKind = 'clarification' | 'unread' | 'review' | 'unassigned' | 'recent';

export interface InboxTaskProjection {
  task: GlobalTask;
  key: string;
  attention: InboxAttentionKind;
  attentionRank: number;
  unreadCount: number;
  updatedAtMs: number;
}

/** 收件箱任务行动态条目（deliveries/feedbackItems 的统一投影，取代已删除的任务评论） */
export interface InboxTaskActivityItem {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface InboxTaskMessageProjection {
  task: GlobalTask;
  key: string;
  latestMessage: InboxTaskActivityItem;
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

/**
 * 任务行动态 = 交付（deliveries，agent 侧）+ 反馈条目（feedbackItems，用户侧），
 * 按时间序合并；与右栏评审邮件线程同源，不再读已删除的 comments 字段。
 */
export function getTaskInboxActivityItems(task: GlobalTask): InboxTaskActivityItem[] {
  const items: InboxTaskActivityItem[] = [];
  for (const delivery of task.deliveries ?? []) {
    const summary = delivery.summary?.trim();
    items.push({
      id: `delivery:${delivery.version}`,
      author: task.owner?.trim() || 'agent',
      text: `交付 第 ${delivery.version} 版${summary ? `：${summary}` : ''}`,
      createdAt: delivery.deliveredAt,
    });
  }
  for (const item of task.feedbackItems ?? []) {
    items.push({ id: item.id, author: 'user', text: item.text, createdAt: item.createdAt });
  }
  return items.sort((a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt));
}

/** agent 侧的动态条目（未读计数只算这些——用户自己的操作不算未读） */
export function getAgentActivityItems(task: GlobalTask): InboxTaskActivityItem[] {
  return getTaskInboxActivityItems(task).filter(
    (item) => item.author.trim().toLocaleLowerCase() !== 'user'
  );
}

export function findReferencedTask(
  tasks: GlobalTask[],
  target: { taskId: string; teamName?: string }
): GlobalTask | undefined {
  if (target.teamName) {
    return tasks.find((task) => task.teamName === target.teamName && task.id === target.taskId);
  }

  const matches = tasks.filter((task) => task.id === target.taskId);
  return matches.length === 1 ? matches[0] : undefined;
}

function toTimestamp(raw: string | Date | null | undefined): number {
  if (!raw) return 0;
  const timestamp = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function getInboxTaskView(task: GlobalTask): InboxTaskView {
  const reviewState = getReviewStateFromTask(task);
  if (reviewState === 'review') return 'review';
  if (task.status === 'completed') return 'completed';
  return 'in_progress';
}

function matchesView(task: GlobalTask, view: InboxTaskView): boolean {
  return getInboxTaskView(task) === view;
}

function deriveAttention(task: GlobalTask, unreadCount: number): [InboxAttentionKind, number] {
  if (task.needsClarification === 'user') return ['clarification', 0];
  if (unreadCount > 0) return ['unread', 1];
  const reviewState = getReviewStateFromTask(task);
  if (reviewState === 'needsFix' || reviewState === 'review') {
    return ['review', 2];
  }
  if (!task.owner?.trim()) return ['unassigned', 3];
  return ['recent', 4];
}

export function projectInboxTaskMessages({
  tasks,
  query = '',
  teamName = 'all',
  unreadCountByTask = {},
}: Omit<InboxProjectionOptions, 'view' | 'owner'>): InboxTaskMessageProjection[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return tasks
    .filter((task) => task.status !== 'deleted' && !task.deletedAt && !task.teamDeleted)
    .filter((task) => teamName === 'all' || task.teamName === teamName)
    .map((task) => {
      const latestMessage = getTaskInboxActivityItems(task).at(-1);
      if (!latestMessage) return null;
      const key = getGlobalTaskKey(task);
      return {
        task,
        key,
        latestMessage,
        unreadCount: unreadCountByTask[key] ?? 0,
        updatedAtMs: toTimestamp(latestMessage.createdAt),
      };
    })
    .filter((entry): entry is InboxTaskMessageProjection => entry !== null)
    .filter((entry) => {
      if (!normalizedQuery) return true;
      return [
        entry.task.subject,
        entry.task.teamDisplayName,
        entry.task.owner,
        entry.latestMessage.author,
        entry.latestMessage.text,
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    })
    .sort((left, right) => {
      const leftUnread = left.unreadCount > 0 ? 1 : 0;
      const rightUnread = right.unreadCount > 0 ? 1 : 0;
      if (leftUnread !== rightUnread) return rightUnread - leftUnread;
      if (left.updatedAtMs !== right.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
      return left.key.localeCompare(right.key);
    });
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
      if (view === 'in_progress' && a.attentionRank !== b.attentionRank) {
        return a.attentionRank - b.attentionRank;
      }
      if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
      const teamOrder = a.task.teamDisplayName.localeCompare(b.task.teamDisplayName, 'zh-CN');
      if (teamOrder !== 0) return teamOrder;
      return a.key.localeCompare(b.key);
    });
}
