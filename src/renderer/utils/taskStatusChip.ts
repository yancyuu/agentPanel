import { getReviewStateFromTask } from '@shared/utils/reviewState';

import type { TaskHistoryEvent, TeamReviewState, TeamTaskStatus } from '@shared/types/team';

export interface TaskStatusChip {
  label: string;
  className: string;
}

interface TaskStatusChipInput {
  status: TeamTaskStatus;
  needsClarification?: 'lead' | 'user' | null;
  waitingForAgent?: boolean;
  reviewState?: TeamReviewState;
  historyEvents?: TaskHistoryEvent[];
}

/**
 * 任务状态 chip 单一事实源：收件箱任务行与任务详情头部共用同一映射。
 * 优先级：等待智能体上线 > 待你补充 > 待你评审 > 已完成 > 待处理 > 进行中。
 * needsFix（返工中）按任务状态归入「进行中」（橙橘），不单独出 chip。
 */
export function getTaskStatusChip(task: TaskStatusChipInput): TaskStatusChip {
  // 派发未送达的等待态优先级最高：区别于「进行中」，避免误导用户以为 agent 在干活
  if (task.waitingForAgent) {
    return {
      label: '等待智能体上线',
      className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    };
  }
  if (task.needsClarification === 'user') {
    return {
      label: '待你补充',
      className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    };
  }
  // 只有「等用户评审」是用户的行动项，优先级高于任务状态
  if (getReviewStateFromTask(task) === 'review') {
    return {
      label: '待你评审',
      className: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    };
  }
  if (task.status === 'completed') {
    return {
      label: '已完成',
      className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    };
  }
  if (task.status === 'pending') {
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
