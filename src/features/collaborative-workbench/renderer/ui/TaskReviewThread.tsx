import { useCallback, useMemo, useState } from 'react';

import { FeedbackAnchorView } from '@renderer/components/team/dialogs/FeedbackAnchorView';
import { QuoteFeedbackSelection } from '@renderer/components/team/dialogs/QuoteFeedbackSelection';
import { DeliveryContentView } from '@renderer/components/team/DeliveryContentView';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { ExpandableContent } from '@renderer/components/ui/ExpandableContent';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { format, formatDistanceToNow } from 'date-fns';
import {
  CheckCircle2,
  CircleDot,
  Loader2,
  MessageCircleQuestion,
  MessageSquareX,
  PackageCheck,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import type {
  Delivery,
  FeedbackAnchor,
  FeedbackItem,
  ResolvedTeamMember,
  TaskHistoryEvent,
  TeamReviewState,
} from '@shared/types';

interface TaskReviewThreadProps {
  deliveries?: Delivery[];
  feedbackItems?: FeedbackItem[];
  historyEvents?: TaskHistoryEvent[];
  reviewState?: TeamReviewState;
  /** 任务执行者（交付邮件的署名） */
  owner?: string | null;
  members: ResolvedTeamMember[];
  /** 点击 hunk 锚点时打开变更审查（无则静态展示）。 */
  onOpenHunk?: (changeKey: string) => void;
  /** 回复/选中提意见 = request_changes；传入且任务在评审流程中时显示回复框 */
  onRequestChanges?: (text: string, anchor?: FeedbackAnchor) => Promise<void> | void;
  /** 任务待用户补充标记：'user' 时回复语义切换为补充说明 */
  needsClarification?: 'lead' | 'user' | null;
  /** 待补充态突出展示的 agent 澄清问题（任务线程最新 agent 消息） */
  clarificationQuestion?: { text: string; at?: string } | null;
  /** 补充说明/普通讨论提交（send-message 讨论语义，不产生反馈条目） */
  onSubmitDiscussion?: (text: string) => Promise<void> | void;
  /** 归档后的沉淀建议消息（来自 task:<taskId> 线程，轻量提示卡） */
  precipitationSuggestion?: { text: string; at?: string } | null;
}

type ThreadEntry =
  | { kind: 'delivery'; at: string; delivery: Delivery }
  | { kind: 'feedback'; at: string; item: FeedbackItem }
  | { kind: 'event'; at: string; event: TaskHistoryEvent };

function formatRelativeTime(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return null;
  return formatDistanceToNow(date, { addSuffix: true });
}

function formatFullTime(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return null;
  return format(date, 'yyyy-MM-dd HH:mm:ss');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

/**
 * 评审邮件线程（收件箱右栏）：
 * 交付像邮件一样按时间串成线程——每版交付是一封邮件卡片（可折叠、可选中文字提意见），
 * 每条退回意见是回复邮件（含引用锚点），通过归档是收尾标记；
 * 底部回复框提交即 request_changes。数据源为结构化的 deliveries/feedbackItems/historyEvents。
 */
export const TaskReviewThread = ({
  deliveries,
  feedbackItems,
  historyEvents,
  reviewState,
  owner,
  members,
  onOpenHunk,
  onRequestChanges,
  needsClarification,
  clarificationQuestion,
  onSubmitDiscussion,
  precipitationSuggestion,
}: TaskReviewThreadProps): React.JSX.Element => {
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const [replyText, setReplyText] = useState('');
  const [replySubmitting, setReplySubmitting] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const entries = useMemo<ThreadEntry[]>(() => {
    const list: ThreadEntry[] = [];
    for (const delivery of deliveries ?? []) {
      list.push({ kind: 'delivery', at: delivery.deliveredAt, delivery });
    }
    const feedbackTexts = new Set((feedbackItems ?? []).map((item) => item.text.trim()));
    for (const item of feedbackItems ?? []) {
      list.push({ kind: 'feedback', at: item.createdAt, item });
    }
    for (const event of historyEvents ?? []) {
      if (event.type === 'review_approved') {
        list.push({ kind: 'event', at: event.timestamp, event });
      } else if (event.type === 'review_changes_requested') {
        // 带 comment 的退回已体现为反馈条目，避免线程里重复出现
        if (event.note?.trim() && feedbackTexts.has(event.note.trim())) continue;
        list.push({ kind: 'event', at: event.timestamp, event });
      }
    }
    // 时间降序：最新交付/反馈在最上面（邮件线程的「最新优先」阅读顺序）
    return list.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [deliveries, feedbackItems, historyEvents]);

  // 回复语义按任务状态分派：待你补充 → 补充说明；评审态 → 修改意见；其他 → 普通讨论
  type ReplyMode = 'clarify' | 'review' | 'discussion';
  const replyMode: ReplyMode | null =
    needsClarification === 'user' && onSubmitDiscussion
      ? 'clarify'
      : onRequestChanges && (reviewState === 'review' || reviewState === 'needsFix')
        ? 'review'
        : onSubmitDiscussion
          ? 'discussion'
          : null;
  const canReply = replyMode !== null;
  const replyHint =
    replyMode === 'clarify'
      ? '回复即补充说明'
      : replyMode === 'review'
        ? '回复即提出修改意见'
        : '发送讨论消息';
  const replyPlaceholder =
    replyMode === 'clarify'
      ? '写下要补充的信息…'
      : replyMode === 'review'
        ? '写下需要修改的地方…'
        : '写下想讨论的内容…';

  const submitReply = useCallback(
    async (text: string, anchor?: FeedbackAnchor) => {
      const trimmed = text.trim();
      if (!trimmed || !replyMode) return;
      setReplySubmitting(true);
      setReplyError(null);
      try {
        if (replyMode === 'review') {
          await onRequestChanges?.(trimmed, anchor);
        } else {
          await onSubmitDiscussion?.(trimmed);
        }
        setReplyText('');
      } catch (error) {
        setReplyError(errorMessage(error));
        throw error;
      } finally {
        setReplySubmitting(false);
      }
    },
    [replyMode, onRequestChanges, onSubmitDiscussion]
  );

  const handleReplySubmit = useCallback(async () => {
    try {
      await submitReply(replyText);
    } catch {
      // 错误已在 submitReply 中落到 replyError
    }
  }, [replyText, submitReply]);

  // 交付邮件卡片上的选中提意见：错误展示交给 QuoteFeedbackSelection 自身
  const handleQuoteSubmit = useCallback(
    async (text: string, anchor?: FeedbackAnchor) => {
      if (!onRequestChanges) return;
      await onRequestChanges(text, anchor);
    },
    [onRequestChanges]
  );

  return (
    <div className="space-y-3" data-testid="review-thread">
      {/* 待你补充态：突出展示 agent 的澄清问题（琥珀色，置顶） */}
      {needsClarification === 'user' ? (
        <div
          className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2.5"
          data-testid="clarification-question"
        >
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            <MessageCircleQuestion size={12} className="shrink-0" />
            agent 在等你补充
            {clarificationQuestion?.at && formatRelativeTime(clarificationQuestion.at) ? (
              <span className="ml-auto shrink-0 text-[10px] font-normal opacity-60">
                {formatRelativeTime(clarificationQuestion.at)}
              </span>
            ) : null}
          </div>
          <div className="whitespace-pre-wrap break-words text-xs text-[var(--color-text-secondary)]">
            {clarificationQuestion?.text?.trim() ||
              'agent 需要更多信息才能继续，请在下方回复补充。'}
          </div>
        </div>
      ) : null}

      {/* 邮件式回复框：回复语义随任务状态切换（补充说明/修改意见/讨论）。
          线程最新在前，回复框置顶靠近最新内容 */}
      {canReply ? (
        <div
          className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
          data-testid="review-reply-composer"
          data-reply-mode={replyMode}
        >
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={replyPlaceholder}
            rows={3}
            className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-indigo-400/50"
          />
          {replyError ? <div className="text-[11px] text-red-400">{replyError}</div> : null}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--color-text-muted)]">{replyHint}</span>
            <button
              type="button"
              disabled={!replyText.trim() || replySubmitting}
              onClick={() => void handleReplySubmit()}
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {replySubmitting ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Send size={11} />
              )}
              发送
            </button>
          </div>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">还没有评审往来记录</p>
      ) : null}

      {/* 归档后的沉淀建议（轻量提示）：通常是最新动态，置顶展示 */}
      {precipitationSuggestion ? (
        <div
          className="flex items-center gap-2 rounded-md border border-indigo-400/20 bg-indigo-500/[0.06] px-3 py-2 text-[11px] text-indigo-600 dark:text-indigo-300"
          data-testid="precipitation-suggestion"
        >
          <Sparkles size={12} className="shrink-0" />
          <span className="min-w-0 flex-1">{precipitationSuggestion.text}</span>
          {precipitationSuggestion.at && formatRelativeTime(precipitationSuggestion.at) ? (
            <span className="shrink-0 text-[10px] opacity-60">
              {formatRelativeTime(precipitationSuggestion.at)}
            </span>
          ) : null}
        </div>
      ) : null}

      {entries.map((entry, index) => {
        if (entry.kind === 'delivery') {
          const { delivery } = entry;
          const timeLabel = formatRelativeTime(delivery.deliveredAt);
          const author = owner?.trim() || 'agent';
          const cardContent = (
            <>
              {delivery.summary ? (
                <div className="rounded-md border border-indigo-400/25 bg-indigo-500/10 px-2.5 py-1.5">
                  <div className="mb-0.5 flex items-center gap-1 text-[10px] font-medium text-indigo-600 dark:text-indigo-300">
                    <Sparkles size={10} />
                    本版变更摘要
                  </div>
                  <div className="whitespace-pre-wrap break-words text-xs text-[var(--color-text-secondary)]">
                    {delivery.summary}
                  </div>
                </div>
              ) : null}
              <ExpandableContent collapsedHeight={200} className="text-xs">
                <DeliveryContentView content={delivery.result} />
              </ExpandableContent>
            </>
          );
          return (
            <article
              key={`delivery:${delivery.version}`}
              className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
              data-testid="thread-delivery"
            >
              <header className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <PackageCheck size={13} />
                </span>
                <MemberBadge name={author} color={colorMap.get(author)} size="sm" />
                <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
                  交付 第 {delivery.version} 版
                </span>
                {timeLabel ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">
                        {timeLabel}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {formatFullTime(delivery.deliveredAt)}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </header>
              {replyMode === 'review' ? (
                <QuoteFeedbackSelection onSubmit={handleQuoteSubmit}>
                  {cardContent}
                </QuoteFeedbackSelection>
              ) : (
                cardContent
              )}
            </article>
          );
        }

        if (entry.kind === 'feedback') {
          const { item } = entry;
          const isResolved = item.status === 'resolved';
          const createdLabel = formatRelativeTime(item.createdAt);
          return (
            <article
              key={`feedback:${item.id}`}
              className={`space-y-1.5 rounded-lg border px-3 py-2.5 ${
                isResolved
                  ? 'border-[var(--color-border)] opacity-70'
                  : 'border-amber-500/25 bg-amber-500/5'
              }`}
              data-testid="thread-feedback"
            >
              <header className="flex items-center gap-2">
                {isResolved ? (
                  <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />
                ) : (
                  <CircleDot size={13} className="shrink-0 text-amber-400" />
                )}
                <MemberBadge name="user" size="sm" hideAvatar />
                <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
                  {isResolved ? '修改意见（已解决）' : '修改意见'}
                </span>
                {createdLabel ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">
                        {createdLabel}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{formatFullTime(item.createdAt)}</TooltipContent>
                  </Tooltip>
                ) : null}
              </header>
              <div
                className={`whitespace-pre-wrap break-words text-xs ${
                  isResolved
                    ? 'text-[var(--color-text-muted)] line-through'
                    : 'text-[var(--color-text-secondary)]'
                }`}
              >
                {item.text}
              </div>
              {item.anchor ? (
                <FeedbackAnchorView anchor={item.anchor} onOpenHunk={onOpenHunk} />
              ) : null}
              {isResolved && item.resolvedAt ? (
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  解决于 {formatRelativeTime(item.resolvedAt)}
                </div>
              ) : null}
            </article>
          );
        }

        const { event } = entry;
        const isApproval = event.type === 'review_approved';
        return (
          <div
            key={`event:${event.id}:${index}`}
            className="flex items-center justify-center gap-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
            data-testid="thread-event"
          >
            {isApproval ? (
              <>
                <ShieldCheck size={11} className="text-emerald-400" />
                已通过并归档
              </>
            ) : (
              <>
                <MessageSquareX size={11} className="text-amber-400" />
                请求修改
                {'note' in event && event.note ? `：${event.note}` : ''}
              </>
            )}
            <span className="opacity-60">{formatRelativeTime(event.timestamp)}</span>
          </div>
        );
      })}
    </div>
  );
};
