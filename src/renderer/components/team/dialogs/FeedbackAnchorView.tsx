import { extractFilePathFromChangeKey } from '@renderer/utils/reviewKey';
import { FileDiff, Quote } from 'lucide-react';

import type { FeedbackAnchor } from '@shared/types';

interface FeedbackAnchorViewProps {
  anchor: FeedbackAnchor;
  /**
   * Called when a hunk anchor is clicked (e.g. open the task change review
   * dialog). When omitted, the hunk chip renders as static text.
   */
  onOpenHunk?: (changeKey: string) => void;
}

/**
 * 评论/反馈的定位锚点展示：
 * - quote：引用片段（样式对齐评论引用块）
 * - hunk：文件名 + 第 N 个 hunk，可点击跳转变更审查
 */
export const FeedbackAnchorView = ({
  anchor,
  onOpenHunk,
}: FeedbackAnchorViewProps): React.JSX.Element => {
  if (anchor.kind === 'quote') {
    return (
      <div className="relative overflow-hidden rounded-md border border-indigo-400/20 bg-blue-100/40 py-1.5 pl-2.5 pr-2 dark:border-indigo-500/20 dark:bg-blue-950/20">
        <div className="mb-0.5 flex items-center gap-1 text-[10px] text-indigo-600/60 dark:text-indigo-300/60">
          <Quote size={9} />
          引用
        </div>
        <div className="line-clamp-3 whitespace-pre-wrap break-words text-[11px] text-[var(--color-text-secondary)] opacity-80">
          {anchor.quote}
        </div>
      </div>
    );
  }

  const filePath = extractFilePathFromChangeKey(anchor.changeKey);
  const label = `${filePath} · 第 ${anchor.hunkIndex + 1} 个 hunk`;

  if (!onOpenHunk) {
    return (
      <span
        className="inline-flex max-w-full items-center gap-1 rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]"
        title={anchor.changeKey}
      >
        <FileDiff size={10} className="shrink-0" />
        <span className="truncate font-mono">{label}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 transition-colors hover:bg-indigo-500/25 dark:text-indigo-300"
      title={anchor.changeKey}
      onClick={(e) => {
        e.stopPropagation();
        onOpenHunk(anchor.changeKey);
      }}
    >
      <FileDiff size={10} className="shrink-0" />
      <span className="truncate font-mono">{label}</span>
    </button>
  );
};
