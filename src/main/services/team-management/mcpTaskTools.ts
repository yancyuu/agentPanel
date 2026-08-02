/**
 * MCP 任务工具执行器 — 从 mcpRoutes.ts 抽出以便独立测试。
 *
 * 任务交付评审闭环（成果版本化 + 反馈条目化）：
 *   deliver_task  → 追加一条 Delivery（version 递增；非首次交付必须带 summary）
 *                   + status=done + reviewState=review（交付待审，看板 review 列由 reviewState 承载）
 *                   addressedFeedbackIds 会把对应 open 反馈条目标记为 resolved
 *   approve_task  → 仍有 open 反馈条目时拒绝通过（督促闭环）；
 *                   否则 reviewState=approved，清零退回计数与人工介入标记
 *   reject_result → 创建一条 open 的 FeedbackItem（可带 anchor）
 *                   + status 回 doing + revisionCount+1，
 *                   退回 >= 3 次置 needsHumanIntervention 并在返回中提示
 *
 * claim/complete/deliver/approve/reject 各节点都会向 historyEvents 追加事件。
 *
 * 当前不存在跨团队 dispatch，dispatch_id 即本团队 task id，返回中原样回显。
 */

import { getDerivedReviewState } from '@shared/utils/taskHistory';

import { archiveTaskDeliverable } from './TaskDeliverableArchiveService';
import { buildDeliveryThreadMessage } from './reviewThreadMessages';

import type { AppendGroupMessageInput } from './TeamWorkspaceService';
import type { TeamProvisioningService } from './TeamProvisioningService';
import type { Task } from './TeamWorkspaceService';
import type { FeedbackAnchor, TaskHistoryEvent, TeamReviewState } from '@shared/types/team';

export type McpToolContent = { type: string; text: string }[];

type TaskToolService = Pick<
  TeamProvisioningService,
  | 'readTasks'
  | 'createTask'
  | 'patchTask'
  | 'addDelivery'
  | 'addFeedbackItem'
  | 'appendTaskHistoryEvent'
>;

/**
 * 评审邮件线程写入钩子（可选）：交付/退回/通过时把评审事件写进
 * messages/group.jsonl 并广播 inbox SSE；写入失败不影响任务操作本身。
 */
export interface McpReviewThreadHooks {
  appendMessage?: (teamSlug: string, input: AppendGroupMessageInput) => Promise<unknown>;
  broadcastInboxChange?: (teamSlug: string) => void;
}

async function appendReviewThreadMessage(
  hooks: McpReviewThreadHooks | undefined,
  teamSlug: string,
  input: AppendGroupMessageInput
): Promise<void> {
  if (!hooks?.appendMessage) return;
  try {
    await hooks.appendMessage(teamSlug, input);
    hooks.broadcastInboxChange?.(teamSlug);
  } catch (error) {
    // 消息线程只是展示层镜像，写入失败不影响任务操作
    console.warn('[review-thread] 交付线程消息写入失败（不影响任务状态）:', error);
  }
}

/** 退回达到该次数后需要人工介入 */
export const HUMAN_INTERVENTION_REVISION_THRESHOLD = 3;

export function historyEventId(): string {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** 宽松解析反馈锚点，非法输入返回 undefined（忽略而非报错） */
export function asFeedbackAnchor(value: unknown): FeedbackAnchor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const anchor = value as Record<string, unknown>;
  if (anchor.kind === 'quote' && typeof anchor.quote === 'string') {
    return { kind: 'quote', quote: anchor.quote };
  }
  if (
    anchor.kind === 'hunk' &&
    typeof anchor.changeKey === 'string' &&
    typeof anchor.hunkIndex === 'number'
  ) {
    return {
      kind: 'hunk',
      changeKey: anchor.changeKey,
      hunkIndex: anchor.hunkIndex,
      ...(typeof anchor.contextHash === 'string' ? { contextHash: anchor.contextHash } : {}),
    };
  }
  return undefined;
}

async function readTaskOrThrow(
  svc: TaskToolService,
  teamSlug: string,
  taskId: string
): Promise<Task> {
  const tasks = await svc.readTasks(teamSlug);
  const existing = tasks.find((task) => task.id === taskId);
  if (!existing) throw new Error(`task not found: ${taskId}`);
  return existing;
}

/** 从 historyEvents 推导当前评审状态（无事件时回退到任务上的 reviewState） */
function currentReviewState(task: Task): TeamReviewState {
  const derived = getDerivedReviewState({ historyEvents: task.historyEvents });
  if (derived !== 'none') return derived;
  return task.reviewState ?? 'none';
}

export async function executeMcpTool(
  svc: TaskToolService,
  toolName: string,
  args: Record<string, unknown>,
  reviewThreadHooks?: McpReviewThreadHooks
): Promise<McpToolContent> {
  const text = (result: unknown): McpToolContent => [
    { type: 'text', text: JSON.stringify(result, null, 2) },
  ];
  const teamSlug = asString(args.team_slug) ?? '';

  if (toolName === 'list_tasks') {
    const tasks = await svc.readTasks(teamSlug);
    return text(tasks);
  }

  if (toolName === 'create_task') {
    const task = await svc.createTask(teamSlug, {
      title: asString(args.title) ?? '',
      description: asString(args.description),
      assignee: asString(args.assignee) ?? null,
    });
    return text(task);
  }

  if (toolName === 'claim_task') {
    const taskId = asString(args.task_id) ?? '';
    const existing = await readTaskOrThrow(svc, teamSlug, taskId);
    const task = await svc.patchTask(teamSlug, taskId, { status: 'doing' });
    const event: TaskHistoryEvent = {
      id: historyEventId(),
      type: 'status_changed',
      from: existing.status === 'done' ? 'completed' : 'pending',
      to: 'in_progress',
      timestamp: new Date().toISOString(),
      actor: 'agent',
    };
    await svc.appendTaskHistoryEvent(teamSlug, taskId, event);
    return text({ ...task, historyEvents: [...(task.historyEvents ?? []), event] });
  }

  if (toolName === 'complete_task') {
    const taskId = asString(args.task_id) ?? '';
    const result = asString(args.result);
    if (result) {
      // 带 result 时记录为一条交付成果（delivery）
      const { delivery } = await svc.addDelivery(teamSlug, taskId, { result });
      const existing = await readTaskOrThrow(svc, teamSlug, taskId);
      await appendReviewThreadMessage(
        reviewThreadHooks,
        teamSlug,
        buildDeliveryThreadMessage(teamSlug, existing, delivery)
      );
    }
    const task = await svc.patchTask(teamSlug, taskId, { status: 'done' });
    const event: TaskHistoryEvent = {
      id: historyEventId(),
      type: 'status_changed',
      from: 'in_progress',
      to: 'completed',
      timestamp: new Date().toISOString(),
      actor: 'agent',
    };
    await svc.appendTaskHistoryEvent(teamSlug, taskId, event);
    return text({ ...task, historyEvents: [...(task.historyEvents ?? []), event] });
  }

  if (toolName === 'deliver_task') {
    const dispatchId = asString(args.dispatch_id) ?? '';
    const result = asString(args.result) ?? '';
    const summary = asString(args.summary);
    const addressedFeedbackIds = asStringArray(args.addressed_feedback_ids);
    const existing = await readTaskOrThrow(svc, teamSlug, dispatchId);
    if ((existing.deliveries?.length ?? 0) > 0 && !summary?.trim()) {
      throw new Error('该任务已有历史交付，再次交付时必须提供 summary（本轮变更摘要）。');
    }
    const {
      task: withDelivery,
      delivery,
      skippedFeedbackIds,
    } = await svc.addDelivery(teamSlug, dispatchId, {
      result,
      summary: summary?.trim() || undefined,
      addressedFeedbackIds,
    });
    const task = await svc.patchTask(teamSlug, dispatchId, {
      status: 'done',
      reviewState: 'review',
      // 交付新版本即视为人工介入已处理
      needsHumanIntervention: false,
    });
    const event: TaskHistoryEvent = {
      id: historyEventId(),
      type: 'review_requested',
      from: currentReviewState(withDelivery),
      to: 'review',
      timestamp: new Date().toISOString(),
      actor: 'agent',
      note: summary?.trim() || undefined,
    };
    await svc.appendTaskHistoryEvent(teamSlug, dispatchId, event);
    await appendReviewThreadMessage(
      reviewThreadHooks,
      teamSlug,
      buildDeliveryThreadMessage(teamSlug, existing, delivery)
    );
    return text({
      ...task,
      historyEvents: [...(task.historyEvents ?? []), event],
      dispatch_id: dispatchId,
      delivery,
      ...(skippedFeedbackIds.length ? { skippedFeedbackIds } : {}),
    });
  }

  if (toolName === 'approve_task') {
    const dispatchId = asString(args.dispatch_id) ?? '';
    const existing = await readTaskOrThrow(svc, teamSlug, dispatchId);
    const openItems = (existing.feedbackItems ?? []).filter((item) => item.status === 'open');
    if (openItems.length > 0) {
      const listing = openItems.map((item) => `- [${item.id}] ${item.text}`).join('\n');
      throw new Error(
        `仍有 ${openItems.length} 条未处理的反馈，不能审核通过。请先处理并在交付时用 addressed_feedback_ids 标记：\n${listing}`
      );
    }
    if (!(existing.deliveries?.at(-1)?.result.trim() ?? '')) {
      throw new Error('任务还没有可归档的交付结果。');
    }
    const task = await svc.patchTask(teamSlug, dispatchId, {
      revisionCount: 0,
      needsHumanIntervention: false,
      reviewState: 'approved',
    });
    try {
      await archiveTaskDeliverable({ teamName: teamSlug, task });
    } catch (error) {
      await svc.patchTask(teamSlug, dispatchId, {
        status: existing.status,
        reviewState: existing.reviewState,
        revisionCount: existing.revisionCount,
        needsHumanIntervention: existing.needsHumanIntervention,
      });
      throw error;
    }
    const event: TaskHistoryEvent = {
      id: historyEventId(),
      type: 'review_approved',
      from: currentReviewState(existing),
      to: 'approved',
      timestamp: new Date().toISOString(),
      actor: 'reviewer',
    };
    await svc.appendTaskHistoryEvent(teamSlug, dispatchId, event);
    return text({
      ...task,
      historyEvents: [...(task.historyEvents ?? []), event],
      dispatch_id: dispatchId,
    });
  }

  if (toolName === 'reject_result') {
    const dispatchId = asString(args.dispatch_id) ?? '';
    const feedback = (asString(args.feedback) ?? '').trim();
    if (!feedback) throw new Error('feedback is required');
    const anchor = asFeedbackAnchor(args.anchor);
    const existing = await readTaskOrThrow(svc, teamSlug, dispatchId);
    const feedbackItem = await svc.addFeedbackItem(teamSlug, dispatchId, {
      text: feedback,
      anchor,
    });
    const revisionCount = (existing.revisionCount ?? 0) + 1;
    const needsHumanIntervention = revisionCount >= HUMAN_INTERVENTION_REVISION_THRESHOLD;
    const task = await svc.patchTask(teamSlug, dispatchId, {
      status: 'doing',
      revisionCount,
      needsHumanIntervention,
      reviewState: 'needsFix',
    });
    const event: TaskHistoryEvent = {
      id: historyEventId(),
      type: 'review_changes_requested',
      from: currentReviewState(existing),
      to: 'needsFix',
      timestamp: new Date().toISOString(),
      actor: 'reviewer',
      note: feedback,
    };
    await svc.appendTaskHistoryEvent(teamSlug, dispatchId, event);
    return text({
      ...task,
      historyEvents: [...(task.historyEvents ?? []), event],
      dispatch_id: dispatchId,
      feedbackItem,
      ...(needsHumanIntervention
        ? {
            humanInterventionRequired: true,
            note: `该任务交付已退回 ${revisionCount} 次（>= ${HUMAN_INTERVENTION_REVISION_THRESHOLD}），需要人工介入处理。`,
          }
        : {}),
    });
  }

  throw new Error(`Unknown tool: ${toolName}`);
}
