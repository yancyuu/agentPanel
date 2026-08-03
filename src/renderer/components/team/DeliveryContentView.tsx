import { useEffect, useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { cn } from '@renderer/lib/utils';
import { ExternalLink, Globe } from 'lucide-react';

/**
 * HTML 成果嗅探：`<!DOCTYPE`/`<html` 开头，或允许前置注释/空白、
 * 以 `<html … </html>` 为骨架的完整文档。片段（如单个 div）不算。
 */
export function isHtmlDeliveryContent(content: string): boolean {
  const trimmed = content.trimStart();
  const head = trimmed.slice(0, 500).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return true;
  return head.includes('<html') && content.toLowerCase().includes('</html>');
}

/**
 * URL 成果嗅探：整段内容 trim 后就是一个 http(s) 链接（允许首尾空白）。
 * markdown 正文里的内联链接不算——只对「整段即 URL」的成果做预览，避免过度渲染。
 */
export function isStandaloneUrlContent(content: string): boolean {
  return /^https?:\/\/\S+$/i.test(content.trim());
}

/** 外链预览的可达性等待上限：超时未 load 视为被 X-Frame-Options/CSP 拒绝，降级链接卡片 */
const URL_PREVIEW_TIMEOUT_MS = 5_000;

function urlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 链接成果：顶部 iframe 预览 + 下方原文本（可点、新窗口打开）。
 * 加载失败（onError 或超时不可达）降级为显眼链接卡片，不显示空白框。
 */
const UrlDeliveryView = ({ url }: Readonly<{ url: string }>): React.JSX.Element => {
  const [frameState, setFrameState] = useState<'loading' | 'loaded' | 'failed'>('loading');

  useEffect(() => {
    if (frameState !== 'loading') return;
    const timer = setTimeout(() => setFrameState('failed'), URL_PREVIEW_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [frameState]);

  return (
    <div className="space-y-1.5" data-testid="delivery-url-view">
      {frameState === 'failed' ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          data-testid="delivery-url-fallback"
          className="flex items-center gap-2 rounded-md border border-indigo-500/25 bg-indigo-500/[0.06] px-3 py-2.5 text-xs font-medium text-indigo-600 transition-colors hover:bg-indigo-500/10 dark:text-indigo-300"
        >
          <Globe size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{urlHostname(url)}</span>
          <span className="inline-flex shrink-0 items-center gap-1">
            在新窗口打开
            <ExternalLink size={11} />
          </span>
        </a>
      ) : (
        <iframe
          title="链接页面预览"
          data-testid="delivery-url-preview"
          // 外链刻意放宽为 allow-scripts allow-same-origin：大多数现代站点
          // 没有脚本会直接白屏（主场景是本地/内网预览链接）；风险由目标站点
          // 自身 CSP 承担，且加载失败会降级为链接卡片，不污染工作台上下文。
          sandbox="allow-scripts allow-same-origin"
          src={url}
          onLoad={() => setFrameState('loaded')}
          onError={() => setFrameState('failed')}
          className="h-96 w-full rounded-md border border-[var(--color-border)] bg-white"
        />
      )}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        data-testid="delivery-url-link"
        className="block break-all text-xs text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-500 dark:text-indigo-300"
      >
        {url}
      </a>
    </div>
  );
};

interface DeliveryContentViewProps {
  content: string;
}

/**
 * 交付成果按内容类型渲染（delivery-html-preview）：
 * - 整段即 http(s) 链接 → 顶部 iframe 预览（失败降级链接卡片）+ 下方原文本；
 * - 嗅探为完整 HTML 文档 → 沙盒 iframe 渲染页面视图（sandbox 最严：无脚本/同源），
 *   提供「预览/源码」切换（默认预览；源码为可选中的纯文本，便于选中提意见）；
 * - 其他内容 → 维持既有 markdown 渲染。
 */
export const DeliveryContentView = ({
  content,
}: Readonly<DeliveryContentViewProps>): React.JSX.Element => {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');

  if (isStandaloneUrlContent(content)) {
    return <UrlDeliveryView url={content.trim()} />;
  }

  if (!isHtmlDeliveryContent(content)) {
    return <MarkdownViewer content={content} maxHeight="max-h-none" bare />;
  }

  return (
    <div className="space-y-1.5" data-testid="delivery-content-view">
      <div className="flex items-center gap-1" role="tablist" aria-label="成果展示方式">
        {(['preview', 'source'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={mode === candidate}
            data-testid={`delivery-mode-${candidate}`}
            onClick={() => setMode(candidate)}
            className={cn(
              'rounded-md px-2 py-0.5 text-[11px] transition-colors',
              mode === candidate
                ? 'bg-[var(--color-surface-selected)] font-medium text-[var(--color-text)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]'
            )}
          >
            {candidate === 'preview' ? '预览' : '源码'}
          </button>
        ))}
      </div>
      {mode === 'preview' ? (
        <iframe
          title="交付成果页面预览"
          data-testid="delivery-html-preview"
          // 最严沙盒：不含 allow-scripts/allow-same-origin，
          // 成果内脚本、表单提交与顶层导航都不能影响工作台上下文
          sandbox=""
          srcDoc={content}
          className="h-96 w-full rounded-md border border-[var(--color-border)] bg-white"
        />
      ) : (
        <pre
          data-testid="delivery-html-source"
          className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-xs leading-5 text-[var(--color-text-secondary)]"
        >
          {content}
        </pre>
      )}
    </div>
  );
};
