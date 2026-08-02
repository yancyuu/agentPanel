/**
 * 评审邮件线程消息构建器 — deliver/request_changes/approved 时写入
 * teams/<slug>/messages/group.jsonl，让交付/反馈/归档在收件箱里像邮件一样串联。
 * conversationId 统一为 `task:<taskId>`，同一任务的评审往来收进一条线程。
 */

import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';

import type { AppendGroupMessageInput, Task } from './TeamWorkspaceService';
import type { Delivery, FeedbackAnchor, TaskRef } from '@shared/types/team';

export function reviewThreadConversationId(taskId: string): string {
  return `task:${taskId}`;
}

function reviewTaskRefs(teamSlug: string, taskId: string): TaskRef[] {
  return [{ taskId, displayId: deriveTaskDisplayId(taskId), teamName: teamSlug }];
}

/** 交付到达：from=任务执行者，正文为「交付 第 N 版」+【本版变更摘要】+ 成果全文 */
export function buildDeliveryThreadMessage(
  teamSlug: string,
  task: Pick<Task, 'id' | 'assignee'>,
  delivery: Delivery
): AppendGroupMessageInput {
  const summary = delivery.summary?.trim();
  const text = [
    `交付 第 ${delivery.version} 版`,
    '',
    summary ? `【本版变更摘要】${summary}` : null,
    summary ? '' : null,
    delivery.result,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  return {
    from: task.assignee?.trim() || 'agent',
    to: 'user',
    content: text,
    meta: {
      source: 'runtime_delivery',
      conversationId: reviewThreadConversationId(task.id),
      taskRefs: reviewTaskRefs(teamSlug, task.id),
      ...(summary ? { summary } : {}),
    },
  };
}

/** 退回意见：from=user，quote 锚点以引用形式并入正文 */
export function buildFeedbackThreadMessage(
  teamSlug: string,
  task: Pick<Task, 'id'>,
  text: string,
  anchor?: FeedbackAnchor
): AppendGroupMessageInput {
  const content =
    anchor?.kind === 'quote' && anchor.quote.trim() ? `> ${anchor.quote.trim()}\n\n${text}` : text;
  return {
    from: 'user',
    to: 'team',
    content,
    meta: {
      source: 'user_sent',
      conversationId: reviewThreadConversationId(task.id),
      taskRefs: reviewTaskRefs(teamSlug, task.id),
    },
  };
}

/** 通过归档：from=user 的收尾标记 */
export function buildApprovalThreadMessage(
  teamSlug: string,
  task: Pick<Task, 'id' | 'deliveries'>
): AppendGroupMessageInput {
  const version = task.deliveries?.at(-1)?.version;
  return {
    from: 'user',
    to: 'team',
    content: version ? `已通过并归档（第 ${version} 版交付）` : '已通过并归档',
    meta: {
      source: 'user_sent',
      conversationId: reviewThreadConversationId(task.id),
      taskRefs: reviewTaskRefs(teamSlug, task.id),
    },
  };
}

/** 沉淀建议消息 source（同一任务只建议一次） */
export const PRECIPITATION_SUGGESTION_SOURCE = 'precipitation_suggestion';

/** 归档后的沉淀建议：引导用户回复「沉淀一下」进入正常沉淀流程 */
export function buildPrecipitationSuggestionMessage(
  teamSlug: string,
  task: Pick<Task, 'id'>
): AppendGroupMessageInput {
  return {
    from: 'system',
    to: 'user',
    content: '这次的做法要沉淀为工作流吗？回复「沉淀一下」我就整理好。',
    meta: {
      source: PRECIPITATION_SUGGESTION_SOURCE,
      conversationId: reviewThreadConversationId(task.id),
      taskRefs: reviewTaskRefs(teamSlug, task.id),
    },
  };
}
