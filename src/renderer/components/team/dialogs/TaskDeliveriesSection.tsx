import { useCallback, useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { ExpandableContent } from '@renderer/components/ui/ExpandableContent';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock,
  Copy,
  Printer,
  Sparkles,
} from 'lucide-react';

import { FeedbackAnchorView } from './FeedbackAnchorView';

import type { Delivery, FeedbackItem } from '@shared/types';

interface TaskDeliveriesSectionProps {
  deliveries?: Delivery[];
  feedbackItems?: FeedbackItem[];
  /** 点击 hunk 锚点时打开变更审查（无则静态展示）。 */
  onOpenHunk?: (changeKey: string) => void;
  /** 只读展示时的评审入口引导文案（如「前往收件箱评审」） */
  reviewLocationHint?: string;
  /** 提供时引导渲染为可点击按钮 */
  onReviewLocationClick?: () => void;
}

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

/**
 * 交付成果 + 反馈待办点（只读）：
 * - deliveries 追加式版本化，默认展示最新一版，可前后切换；
 * - 每版突出显示本版变更摘要（summary），并列出本版处理的反馈条目；
 * - feedbackItems 条目化展示，open 项计数醒目提示，resolved 项弱化；
 * - 评审交互（通过/退回/选中提意见）在收件箱进行，此处仅展示。
 */
export const TaskDeliveriesSection = ({
  deliveries,
  feedbackItems,
  onOpenHunk,
  reviewLocationHint,
  onReviewLocationClick,
}: TaskDeliveriesSectionProps): React.JSX.Element | null => {
  // null = 跟随最新一版；用户手动切换后固定在所选版本
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [resultCopied, setResultCopied] = useState(false);

  const sortedDeliveries = deliveries ? [...deliveries].sort((a, b) => a.version - b.version) : [];
  const latestDelivery = sortedDeliveries.at(-1);
  const currentDelivery =
    (selectedVersion != null
      ? sortedDeliveries.find((d) => d.version === selectedVersion)
      : undefined) ?? latestDelivery;

  const feedbackById = new Map((feedbackItems ?? []).map((item) => [item.id, item]));
  const openFeedback = (feedbackItems ?? []).filter((item) => item.status === 'open');
  const resolvedFeedback = (feedbackItems ?? []).filter((item) => item.status === 'resolved');

  const copyResult = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setResultCopied(true);
    } catch {
      setResultCopied(false);
    }
  }, []);

  const printResult = useCallback(() => {
    window.print();
  }, []);

  if (sortedDeliveries.length === 0 && (feedbackItems ?? []).length === 0) {
    return null;
  }

  const addressedItems =
    currentDelivery?.addressedFeedbackIds
      ?.map((id) => feedbackById.get(id))
      .filter((item): item is FeedbackItem => Boolean(item)) ?? [];

  const currentIndex = currentDelivery
    ? sortedDeliveries.findIndex((d) => d.version === currentDelivery.version)
    : -1;

  return (
    <div className="space-y-3">
      {reviewLocationHint ? (
        onReviewLocationClick ? (
          <button
            type="button"
            data-testid="review-location-button"
            onClick={onReviewLocationClick}
            className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/[0.06] px-2.5 py-1 text-[11px] font-medium text-indigo-600 transition-colors hover:bg-indigo-500/15 dark:text-indigo-300"
          >
            {reviewLocationHint}
          </button>
        ) : (
          <div className="text-[11px] text-[var(--color-text-muted)] opacity-70">
            {reviewLocationHint}
          </div>
        )
      ) : null}

      {currentDelivery ? (
        <div className="space-y-2" data-testid="delivery-version">
          {/* 版本切换 + 交付时间 + 次要操作（复制/保存 PDF 仅图标） */}
          <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
            {sortedDeliveries.length > 1 ? (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="上一版"
                  className="rounded p-0.5 transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] disabled:opacity-30"
                  disabled={currentIndex <= 0}
                  onClick={() =>
                    setSelectedVersion(sortedDeliveries[currentIndex - 1]?.version ?? null)
                  }
                >
                  <ChevronLeft size={12} />
                </button>
                <span className="tabular-nums">
                  第 {currentDelivery.version} 版 / 共 {sortedDeliveries.length} 版
                </span>
                <button
                  type="button"
                  aria-label="下一版"
                  className="rounded p-0.5 transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] disabled:opacity-30"
                  disabled={currentIndex < 0 || currentIndex >= sortedDeliveries.length - 1}
                  onClick={() =>
                    setSelectedVersion(sortedDeliveries[currentIndex + 1]?.version ?? null)
                  }
                >
                  <ChevronRight size={12} />
                </button>
              </span>
            ) : null}
            {formatRelativeTime(currentDelivery.deliveredAt) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1">
                    <Clock size={10} />
                    交付于 {formatRelativeTime(currentDelivery.deliveredAt)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {formatFullTime(currentDelivery.deliveredAt)}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="复制成果"
                    onClick={() => void copyResult(currentDelivery.result)}
                    className="inline-flex items-center rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]"
                  >
                    {resultCopied ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{resultCopied ? '已复制' : '复制'}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="保存 PDF"
                    onClick={printResult}
                    className="inline-flex items-center rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]"
                  >
                    <Printer size={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">保存 PDF</TooltipContent>
              </Tooltip>
            </span>
          </div>

          {/* 本版变更摘要 —— 只审增量的入口，突出显示 */}
          {currentDelivery.summary ? (
            <div className="rounded-md border border-indigo-400/25 bg-indigo-500/10 px-2.5 py-1.5">
              <div className="mb-0.5 flex items-center gap-1 text-[10px] font-medium text-indigo-600 dark:text-indigo-300">
                <Sparkles size={10} />
                本版变更摘要
              </div>
              <div className="whitespace-pre-wrap break-words text-xs text-[var(--color-text-secondary)]">
                {currentDelivery.summary}
              </div>
            </div>
          ) : null}

          {/* 成果内容 */}
          <ExpandableContent collapsedHeight={200} className="text-xs">
            <MarkdownViewer content={currentDelivery.result} maxHeight="max-h-none" bare />
          </ExpandableContent>

          {/* 本版处理的反馈 */}
          {addressedItems.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[10px] font-medium text-[var(--color-text-muted)]">
                本版处理的反馈
              </div>
              <ul className="space-y-1">
                {addressedItems.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]"
                  >
                    <CheckCircle2 size={11} className="shrink-0 text-emerald-400" />
                    <span className="min-w-0 break-words">{item.text}</span>
                    {item.anchor ? (
                      <FeedbackAnchorView anchor={item.anchor} onOpenHunk={onOpenHunk} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 反馈待办点 */}
      {(feedbackItems ?? []).length > 0 ? (
        <div className="space-y-1.5" data-testid="feedback-list">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
              反馈待办点
            </span>
            {openFeedback.length > 0 ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-300">
                {openFeedback.length} 条待处理
              </span>
            ) : (
              <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
                全部已解决
              </span>
            )}
          </div>
          <ul className="space-y-1.5">
            {[...openFeedback, ...resolvedFeedback].map((item) => {
              const isResolved = item.status === 'resolved';
              const createdLabel = formatRelativeTime(item.createdAt);
              const resolvedLabel = item.resolvedAt ? formatRelativeTime(item.resolvedAt) : null;
              return (
                <li
                  key={item.id}
                  className={`rounded-md border px-2.5 py-1.5 ${
                    isResolved
                      ? 'border-[var(--color-border)] opacity-60'
                      : 'border-amber-500/25 bg-amber-500/5'
                  }`}
                >
                  <div className="flex items-start gap-1.5">
                    {isResolved ? (
                      <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-400" />
                    ) : (
                      <CircleDot size={12} className="mt-0.5 shrink-0 text-amber-400" />
                    )}
                    <div className="min-w-0 flex-1 space-y-1">
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
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[var(--color-text-muted)]">
                        <span>{isResolved ? '已解决' : '待处理'}</span>
                        {createdLabel ? <span>创建于 {createdLabel}</span> : null}
                        {isResolved && resolvedLabel ? <span>解决于 {resolvedLabel}</span> : null}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
};
