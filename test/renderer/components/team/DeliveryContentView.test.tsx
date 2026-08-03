import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => (
    <div data-testid="markdown-viewer">{content}</div>
  ),
}));

import {
  DeliveryContentView,
  isHtmlDeliveryContent,
} from '@renderer/components/team/DeliveryContentView';

const HTML_DOC = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>落地页</title><style>body{margin:0}</style></head>
<body><h1>新首页</h1><script>alert('x')</script></body>
</html>`;

function renderView(content: string): { host: HTMLElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<DeliveryContentView content={content} />);
  });
  return { host, root };
}

describe('isHtmlDeliveryContent 嗅探', () => {
  it('识别完整 HTML 文档', () => {
    expect(isHtmlDeliveryContent(HTML_DOC)).toBe(true);
    expect(isHtmlDeliveryContent('<html><body>x</body></html>')).toBe(true);
    expect(isHtmlDeliveryContent('  <!-- 注释 -->\n<html><body>x</body></html>')).toBe(true);
    expect(isHtmlDeliveryContent('<!doctype html>\n<html><body>x</body></html>')).toBe(true);
  });

  it('markdown/纯文本/标签片段不识别为 HTML 文档', () => {
    expect(isHtmlDeliveryContent('# 调研报告\n\n正文')).toBe(false);
    expect(isHtmlDeliveryContent('普通文本')).toBe(false);
    expect(isHtmlDeliveryContent('<div>只是一个片段</div>')).toBe(false);
    expect(isHtmlDeliveryContent('')).toBe(false);
  });
});

describe('DeliveryContentView', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('HTML 成果默认渲染沙盒 iframe 预览（无 allow-scripts/allow-same-origin），可切源码', () => {
    const { host, root } = renderView(HTML_DOC);

    const iframe = host.querySelector<HTMLIFrameElement>('[data-testid="delivery-html-preview"]');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('srcdoc')).toBe(HTML_DOC);
    const sandbox = iframe?.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(host.querySelector('[data-testid="markdown-viewer"]')).toBeNull();

    // 切到源码：展示原始 HTML 纯文本（可选中），iframe 移除
    act(() => {
      host
        .querySelector<HTMLButtonElement>('[data-testid="delivery-mode-source"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="delivery-html-preview"]')).toBeNull();
    const source = host.querySelector('[data-testid="delivery-html-source"]');
    expect(source?.textContent).toContain('<h1>新首页</h1>');

    // 切回预览
    act(() => {
      host
        .querySelector<HTMLButtonElement>('[data-testid="delivery-mode-preview"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="delivery-html-preview"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('markdown 成果维持原渲染，不出现预览/源码切换', () => {
    const { host, root } = renderView('# 调研报告\n\n这是结论。');
    expect(host.querySelector('[data-testid="markdown-viewer"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="delivery-mode-preview"]')).toBeNull();
    expect(host.querySelector('[data-testid="delivery-html-preview"]')).toBeNull();
    act(() => root.unmount());
  });
});
