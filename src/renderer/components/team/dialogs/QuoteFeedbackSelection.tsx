import { useCallback, useEffect, useRef, useState } from 'react';

import { Popover, PopoverAnchor, PopoverContent } from '@renderer/components/ui/popover';
import { Loader2, MessageSquareX } from 'lucide-react';

import { FeedbackAnchorView } from './FeedbackAnchorView';

import type { FeedbackAnchor } from '@shared/types';

/** 选中提意见的 quote 锚点最大存储长度 */
const MAX_QUOTE_LENGTH = 200;

/** 选中提意见期间保持原文高亮的自定义 highlight 名称 */
const QUOTE_HIGHLIGHT_NAME = 'deliverable-quote-selection';

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

function getHighlightRegistry(): HighlightRegistry | undefined {
  return (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
}

function getHighlightCtor(): (new (range: Range) => unknown) | undefined {
  return (globalThis as { Highlight?: new (range: Range) => unknown }).Highlight;
}

let quoteHighlightStyleInjected = false;

/** 注入 ::highlight 样式（琥珀色浅底，深浅主题都可读），只需一次 */
function ensureQuoteHighlightStyle(): void {
  if (quoteHighlightStyleInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = `::highlight(${QUOTE_HIGHLIGHT_NAME}) { background-color: rgb(251 191 36 / 0.28); color: inherit; }`;
  document.head.appendChild(style);
  quoteHighlightStyleInjected = true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

interface QuoteFeedbackSelectionProps {
  /** 提交一条带 quote 锚点的反馈意见（request_changes 语义） */
  onSubmit: (text: string, anchor: FeedbackAnchor) => Promise<void> | void;
  children: React.ReactNode;
}

/**
 * 「选中文字 → 对此提意见」容器：
 * 包裹渲染态内容，监听选区浮出「对此提意见」按钮，点击后在选区原位展开
 * 悬浮输入框（引用预览 + textarea + 提交/取消），打开期间保持原文高亮。
 */
export const QuoteFeedbackSelection = ({
  onSubmit,
  children,
}: QuoteFeedbackSelectionProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverContentRef = useRef<HTMLDivElement>(null);
  // popover 打开期间保持原文高亮用的选区 Range（多段选择只取第一个 range）
  const savedRangeRef = useRef<Range | null>(null);
  const [selectionQuote, setSelectionQuote] = useState<{
    text: string;
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [quotePopover, setQuotePopover] = useState<{
    quote: string;
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [quoteText, setQuoteText] = useState('');
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    const container = containerRef.current;
    const text = selection?.toString().trim() ?? '';
    if (!selection || selection.rangeCount === 0 || !text || !container) {
      setSelectionQuote(null);
      return;
    }
    if (!selection.anchorNode || !container.contains(selection.anchorNode)) {
      setSelectionQuote(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setSelectionQuote({
      text: text.length > MAX_QUOTE_LENGTH ? `${text.slice(0, MAX_QUOTE_LENGTH)}…` : text,
      top: rect.top - containerRect.top,
      left: rect.left - containerRect.left,
      width: rect.width,
      height: rect.height,
    });
  }, []);

  // 点击「对此提意见」：在选区原位展开悬浮输入框，
  // 并保存选区 Range 用于 popover 打开期间保持原文高亮
  const handleQuoteFeedback = useCallback(() => {
    if (!selectionQuote) return;
    const selection = window.getSelection();
    const rawRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    savedRangeRef.current = rawRange
      ? typeof rawRange.cloneRange === 'function'
        ? rawRange.cloneRange()
        : rawRange
      : null;
    setQuotePopover({
      quote: selectionQuote.text,
      top: selectionQuote.top,
      left: selectionQuote.left,
      width: selectionQuote.width,
      height: selectionQuote.height,
    });
    setQuoteText('');
    setQuoteError(null);
    setSelectionQuote(null);
    window.getSelection()?.removeAllRanges();
  }, [selectionQuote]);

  const closeQuotePopover = useCallback(() => {
    setQuotePopover(null);
    setQuoteText('');
    setQuoteError(null);
    savedRangeRef.current = null;
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleQuoteSubmit = useCallback(async () => {
    const text = quoteText.trim();
    if (!text || quoteSubmitting || !quotePopover) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    try {
      await onSubmit(text, { kind: 'quote', quote: quotePopover.quote });
      closeQuotePopover();
    } catch (error) {
      setQuoteError(errorMessage(error));
    } finally {
      setQuoteSubmitting(false);
    }
  }, [closeQuotePopover, onSubmit, quotePopover, quoteSubmitting, quoteText]);

  // 悬浮框打开期间：滚动（含内部滚动容器）或窗口变化即关闭，不做位置跟随
  useEffect(() => {
    if (!quotePopover) return;
    const handleScrollOrResize = (event: Event) => {
      if (event.target instanceof Node && popoverContentRef.current?.contains(event.target)) {
        return;
      }
      closeQuotePopover();
    };
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [closeQuotePopover, quotePopover]);

  // 悬浮框打开期间保持原文高亮：
  // 优先 CSS Custom Highlight API（不改 DOM、re-render 不丢）；
  // 不可用时退化为 selectionchange 监听，在选区塌陷后 re-add 保存的 Range
  useEffect(() => {
    if (!quotePopover) return;
    const range = savedRangeRef.current;
    if (!range) return;

    const registry = getHighlightRegistry();
    const HighlightCtor = getHighlightCtor();
    if (registry && HighlightCtor) {
      ensureQuoteHighlightStyle();
      registry.set(QUOTE_HIGHLIGHT_NAME, new HighlightCtor(range));
      return () => {
        registry.delete(QUOTE_HIGHLIGHT_NAME);
      };
    }

    const reapplySelection = (): void => {
      const selection = window.getSelection();
      if (!selection) return;
      if (selection.rangeCount > 0 && typeof Range === 'function') {
        const current = selection.getRangeAt(0);
        try {
          if (
            current.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
            current.compareBoundaryPoints(Range.END_TO_END, range) === 0
          ) {
            return;
          }
        } catch {
          // 边界比较失败时按需要重设
        }
      }
      try {
        selection.removeAllRanges();
        selection.addRange(range);
      } catch {
        // re-render 后 Range 失效时放弃恢复
      }
    };
    document.addEventListener('selectionchange', reapplySelection);
    return () => {
      document.removeEventListener('selectionchange', reapplySelection);
    };
  }, [quotePopover]);

  return (
    <div ref={containerRef} className="relative" onMouseUp={handleMouseUp}>
      {children}
      {selectionQuote ? (
        <button
          type="button"
          data-testid="quote-feedback-button"
          className="absolute z-10 inline-flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-full bg-red-600 px-2.5 py-1 text-[10px] font-medium text-white shadow-md transition-colors hover:bg-red-500"
          style={{
            top: selectionQuote.top,
            left: selectionQuote.left + selectionQuote.width / 2,
          }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleQuoteFeedback}
        >
          <MessageSquareX size={10} />
          对此提意见
        </button>
      ) : null}
      {/* 选区原位悬浮输入框：引用预览 + textarea + 提交/取消 */}
      {quotePopover ? (
        <Popover
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) closeQuotePopover();
          }}
        >
          <PopoverAnchor asChild>
            <div
              data-testid="quote-popover-anchor"
              className="absolute"
              style={{
                top: quotePopover.top,
                left: quotePopover.left,
                width: quotePopover.width,
                height: quotePopover.height,
              }}
            />
          </PopoverAnchor>
          <PopoverContent
            ref={popoverContentRef}
            side="bottom"
            align="center"
            sideOffset={6}
            className="w-80 space-y-2 p-3"
            data-testid="quote-feedback-popover"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                closeQuotePopover();
              }
            }}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-red-500 dark:text-red-300">
              <MessageSquareX size={12} />
              对此提意见
            </div>
            <FeedbackAnchorView anchor={{ kind: 'quote', quote: quotePopover.quote }} />
            <textarea
              autoFocus
              value={quoteText}
              onChange={(e) => setQuoteText(e.target.value)}
              placeholder="描述需要修改的内容..."
              rows={3}
              className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-red-400/50"
            />
            {quoteError ? <div className="text-[11px] text-red-400">{quoteError}</div> : null}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeQuotePopover}
                className="rounded-full px-3 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!quoteText.trim() || quoteSubmitting}
                onClick={() => void handleQuoteSubmit()}
                className="inline-flex items-center gap-1 rounded-full bg-red-600 px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {quoteSubmitting ? <Loader2 size={11} className="animate-spin" /> : null}
                提交
              </button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
};
