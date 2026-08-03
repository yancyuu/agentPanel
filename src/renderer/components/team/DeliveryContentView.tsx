import { useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { cn } from '@renderer/lib/utils';

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

interface DeliveryContentViewProps {
  content: string;
}

/**
 * 交付成果按内容类型渲染（delivery-html-preview）：
 * - 嗅探为完整 HTML 文档 → 沙盒 iframe 渲染页面视图（sandbox 最严：无脚本/同源），
 *   提供「预览/源码」切换（默认预览；源码为可选中的纯文本，便于选中提意见）；
 * - 其他内容 → 维持既有 markdown 渲染。
 */
export const DeliveryContentView = ({
  content,
}: Readonly<DeliveryContentViewProps>): React.JSX.Element => {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');

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
