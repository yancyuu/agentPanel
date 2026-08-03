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
  injectBaseTagIntoHtml,
  isHtmlDeliveryContent,
  isStandaloneUrlContent,
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

describe('injectBaseTagIntoHtml 注入位置', () => {
  const BASE = '<base href="about:blank" target="_blank">';

  it('含 <head> 时紧随其后，doctype 保持在最前', () => {
    const input = '<!DOCTYPE html>\n<html lang="zh">\n<head><meta charset="utf-8"></head><body>x</body></html>';
    const output = injectBaseTagIntoHtml(input);
    expect(output.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(output.indexOf('<head>' + BASE)).toBeGreaterThan(-1);
    expect(output.indexOf(BASE)).toBeLessThan(output.indexOf('<meta'));
  });

  it('含 <head 属性> 时插在开标签之后', () => {
    const output = injectBaseTagIntoHtml('<html><head class="a"><title>t</title></head><body>x</body></html>');
    expect(output).toContain(`<head class="a">${BASE}<title>t</title>`);
  });

  it('无 head 含 <html> 时紧随 <html> 开标签之后', () => {
    const output = injectBaseTagIntoHtml('<!DOCTYPE html><html lang="zh"><body>x</body></html>');
    expect(output.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(output).toContain(`<html lang="zh">${BASE}<body>`);
  });

  it('纯片段直接前置；带 doctype 的片段 base 在 doctype 之后', () => {
    expect(injectBaseTagIntoHtml('<div>片段</div>').startsWith(BASE)).toBe(true);
    const withDoctype = injectBaseTagIntoHtml('<!DOCTYPE html>\n<div>片段</div>');
    expect(withDoctype.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(withDoctype.indexOf(BASE)).toBeLessThan(withDoctype.indexOf('<div>'));
  });
});

describe('isHtmlDeliveryContent 嗅探', () => {  it('识别完整 HTML 文档', () => {
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

  it('HTML 成果默认渲染沙盒 iframe 预览（可交互但 opaque origin、禁顶层导航），可切源码', () => {
    const { host, root } = renderView(HTML_DOC);

    const iframe = host.querySelector<HTMLIFrameElement>('[data-testid="delivery-html-preview"]');
    expect(iframe).not.toBeNull();
    // srcDoc 注入 <base href="about:blank" target="_blank">：相对链接不再套娃工作台
    const srcdoc = iframe?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toBe(injectBaseTagIntoHtml(HTML_DOC));
    expect(srcdoc).toContain('<base href="about:blank" target="_blank">');
    expect(srcdoc.startsWith('<!DOCTYPE html>')).toBe(true);
    const sandbox = iframe?.getAttribute('sandbox') ?? '';
    // 可交互：允许脚本/表单/弹窗
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).toContain('allow-forms');
    expect(sandbox).toContain('allow-popups');
    // 安全边界：opaque origin + 禁顶层导航
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-top-navigation');
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

describe('isStandaloneUrlContent 嗅探', () => {
  it('整段即 http(s) 链接（允许首尾空白）识别为 URL 成果', () => {
    expect(isStandaloneUrlContent('https://example.com/page')).toBe(true);
    expect(isStandaloneUrlContent('  http://192.168.1.10:8080/preview \n')).toBe(true);
  });

  it('含文字的 URL、markdown 内联链接、非 http 协议不识别', () => {
    expect(isStandaloneUrlContent('看这里 https://example.com')).toBe(false);
    expect(isStandaloneUrlContent('[文档](https://example.com)')).toBe(false);
    expect(isStandaloneUrlContent('ftp://example.com/x')).toBe(false);
    expect(isStandaloneUrlContent('https://example.com/a https://example.com/b')).toBe(false);
  });
});

describe('DeliveryContentView URL 成果', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('顶部 iframe 预览（放宽 sandbox）+ 下方原文本链接（新窗口打开）', () => {
    const { host, root } = renderView('https://example.com/landing');

    const iframe = host.querySelector<HTMLIFrameElement>('[data-testid="delivery-url-preview"]');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe('https://example.com/landing');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');

    const link = host.querySelector<HTMLAnchorElement>('[data-testid="delivery-url-link"]');
    expect(link?.getAttribute('href')).toBe('https://example.com/landing');
    expect(link?.getAttribute('target')).toBe('_blank');
    // 布局：预览在上，文本链接在下
    expect(
      iframe!.compareDocumentPosition(link!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // URL 模式不走 markdown 渲染
    expect(host.querySelector('[data-testid="markdown-viewer"]')).toBeNull();
    act(() => root.unmount());
  });

  it('iframe 超时不可达（如被 X-Frame-Options 拒绝）降级为链接卡片（域名 + 打开按钮）', () => {
    vi.useFakeTimers();
    const { host, root } = renderView('https://blocked.example.com/page');
    expect(host.querySelector('[data-testid="delivery-url-preview"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(5_100);
    });
    expect(host.querySelector('[data-testid="delivery-url-preview"]')).toBeNull();
    const fallback = host.querySelector<HTMLAnchorElement>('[data-testid="delivery-url-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.getAttribute('href')).toBe('https://blocked.example.com/page');
    expect(fallback?.textContent).toContain('blocked.example.com');
    expect(fallback?.textContent).toContain('在新窗口打开');
    act(() => root.unmount());
  });
});
