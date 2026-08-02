import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@renderer/components/ui/ExpandableContent', () => ({
  ExpandableContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <>{children}</> : null,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: React.forwardRef<
    HTMLDivElement,
    React.ComponentPropsWithoutRef<'div'> & { side?: string; align?: string; sideOffset?: number }
  >(({ children, side: _side, align: _align, sideOffset: _sideOffset, ...rest }, ref) => (
    <div ref={ref} {...rest}>
      {children}
    </div>
  )),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => <span>{name}</span>,
}));

import { TaskReviewThread } from '../../../src/features/collaborative-workbench/renderer/ui/TaskReviewThread';

import type { Delivery, FeedbackAnchor, FeedbackItem, TaskHistoryEvent } from '@shared/types';

function makeDelivery(overrides: Partial<Delivery>): Delivery {
  return {
    version: 1,
    result: '第一版成果',
    deliveredAt: '2026-07-30T10:00:00.000Z',
    ...overrides,
  };
}

function makeFeedback(overrides: Partial<FeedbackItem>): FeedbackItem {
  return {
    id: 'fb-1',
    text: '请补充错误处理',
    status: 'open',
    createdAt: '2026-07-30T11:00:00.000Z',
    ...overrides,
  };
}

function renderThread(props: {
  deliveries?: Delivery[];
  feedbackItems?: FeedbackItem[];
  historyEvents?: TaskHistoryEvent[];
  reviewState?: 'none' | 'review' | 'needsFix' | 'approved';
  owner?: string | null;
  onRequestChanges?: (text: string, anchor?: FeedbackAnchor) => Promise<void> | void;
  precipitationSuggestion?: { text: string; at?: string } | null;
}): { host: HTMLElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<TaskReviewThread members={[]} {...props} />);
  });
  return { host, root };
}

function clickButtonByText(host: HTMLElement, text: string): void {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function clickButtonByTextAsync(host: HTMLElement, text: string): Promise<void> {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) throw new Error(`button not found: ${text}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

function typeInTextarea(host: HTMLElement, value: string): void {
  const textarea = host.querySelector('textarea');
  if (!textarea) throw new Error('textarea not found');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('textarea value setter not found');
  setter.call(textarea, value);
  act(() => {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function selectTextIn(host: HTMLElement, text: string, selectedText: string) {
  const contentEl = [...host.querySelectorAll('div')].find((el) => el.textContent === text);
  expect(contentEl).toBeDefined();
  const selection = {
    toString: () => selectedText,
    rangeCount: 1,
    anchorNode: contentEl!.firstChild ?? contentEl!,
    getRangeAt: () => ({
      getBoundingClientRect: () => ({ top: 10, left: 10, width: 40, height: 14 }),
    }),
    removeAllRanges: vi.fn(),
  };
  const getSelectionSpy = vi
    .spyOn(window, 'getSelection')
    .mockReturnValue(selection as unknown as Selection);
  act(() => {
    contentEl!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  return { getSelectionSpy };
}

describe('TaskReviewThread', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders deliveries, feedback replies, and the approval marker as a mail thread', () => {
    const { host } = renderThread({
      owner: 'alice',
      deliveries: [
        makeDelivery({ version: 1, result: '第一版成果' }),
        makeDelivery({
          version: 2,
          result: '第二版成果',
          summary: '按反馈重写标题',
          deliveredAt: '2026-07-31T09:00:00.000Z',
        }),
      ],
      feedbackItems: [makeFeedback({ text: '标题不够凝练' })],
      historyEvents: [
        {
          id: 'e1',
          type: 'review_approved',
          from: 'review',
          to: 'approved',
          timestamp: '2026-07-31T10:00:00.000Z',
        },
      ],
    });

    expect(host.textContent).toContain('交付 第 1 版');
    expect(host.textContent).toContain('交付 第 2 版');
    expect(host.textContent).toContain('本版变更摘要');
    expect(host.textContent).toContain('按反馈重写标题');
    expect(host.textContent).toContain('标题不够凝练');
    expect(host.textContent).toContain('已通过并归档');

    // 时间降序：最新在最上面（归档 > v2 > 反馈 > v1）
    const text = host.textContent ?? '';
    const approvalAt = text.indexOf('已通过并归档');
    const v2At = text.indexOf('交付 第 2 版');
    const feedbackAt = text.indexOf('标题不够凝练');
    const v1At = text.indexOf('交付 第 1 版');
    expect(approvalAt).toBeGreaterThanOrEqual(0);
    expect(approvalAt).toBeLessThan(v2At);
    expect(v2At).toBeLessThan(feedbackAt);
    expect(feedbackAt).toBeLessThan(v1At);
  });

  it('reply composer submits request_changes with the reply text and clears for the next one', async () => {
    const onRequestChanges = vi.fn().mockResolvedValue(undefined);
    const { host } = renderThread({
      reviewState: 'review',
      deliveries: [makeDelivery({})],
      onRequestChanges,
    });

    expect(host.textContent).toContain('回复即提出修改意见');
    typeInTextarea(host, '请补充数据来源');
    await clickButtonByTextAsync(host, '发送');
    expect(onRequestChanges).toHaveBeenCalledWith('请补充数据来源', undefined);
    expect(host.querySelector('textarea')?.value).toBe('');

    // 连续提交第二条（一轮退回多条意见）
    typeInTextarea(host, '结论部分再压缩一半');
    await clickButtonByTextAsync(host, '发送');
    expect(onRequestChanges).toHaveBeenNthCalledWith(2, '结论部分再压缩一半', undefined);
  });

  it('hides the reply composer when the task is not in a review flow', () => {
    const { host } = renderThread({
      reviewState: 'approved',
      deliveries: [makeDelivery({})],
      onRequestChanges: vi.fn(),
    });
    expect(host.querySelector('[data-testid="review-reply-composer"]')).toBeNull();
  });

  it('shows the reply composer while the task is in needsFix (追加意见)', () => {
    const { host } = renderThread({
      reviewState: 'needsFix',
      deliveries: [makeDelivery({})],
      onRequestChanges: vi.fn(),
    });
    expect(host.querySelector('[data-testid="review-reply-composer"]')).not.toBeNull();
  });

  it('selected text on a delivery card opens the quote popover and submits with the quote anchor', async () => {
    const onRequestChanges = vi.fn().mockResolvedValue(undefined);
    const { host } = renderThread({
      reviewState: 'review',
      deliveries: [makeDelivery({ result: '第一版成果' })],
      onRequestChanges,
    });

    const { getSelectionSpy } = selectTextIn(host, '第一版成果', '第一版成果');
    const quoteButton = host.querySelector('[data-testid="quote-feedback-button"]');
    expect(quoteButton).not.toBeNull();
    act(() => {
      quoteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const popover = host.querySelector('[data-testid="quote-feedback-popover"]');
    expect(popover).not.toBeNull();
    expect(popover!.textContent).toContain('引用');
    expect(popover!.textContent).toContain('第一版成果');

    typeInTextarea(host, '这里要改');
    await clickButtonByTextAsync(host, '提交');
    expect(onRequestChanges).toHaveBeenCalledWith('这里要改', {
      kind: 'quote',
      quote: '第一版成果',
    });
    expect(host.querySelector('[data-testid="quote-feedback-popover"]')).toBeNull();
    getSelectionSpy.mockRestore();
  });

  it('keeps the selected text highlighted via the Custom Highlight API while the popover is open', () => {
    const highlights = new Map<string, unknown>();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal(
      'Highlight',
      class {
        constructor(public range: unknown) {}
      }
    );
    const { host } = renderThread({
      reviewState: 'review',
      deliveries: [makeDelivery({ result: '第一版成果' })],
      onRequestChanges: vi.fn(),
    });

    const { getSelectionSpy } = selectTextIn(host, '第一版成果', '第一版成果');
    act(() => {
      host
        .querySelector('[data-testid="quote-feedback-button"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(highlights.has('deliverable-quote-selection')).toBe(true);

    clickButtonByText(host, '取消');
    expect(highlights.has('deliverable-quote-selection')).toBe(false);
    getSelectionSpy.mockRestore();
  });

  it('closes the quote popover on Escape without submitting', () => {
    const onRequestChanges = vi.fn().mockResolvedValue(undefined);
    const { host } = renderThread({
      reviewState: 'review',
      deliveries: [makeDelivery({ result: '第一版成果' })],
      onRequestChanges,
    });

    const { getSelectionSpy } = selectTextIn(host, '第一版成果', '第一版成果');
    act(() => {
      host
        .querySelector('[data-testid="quote-feedback-button"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const popover = host.querySelector('[data-testid="quote-feedback-popover"]');
    expect(popover).not.toBeNull();
    act(() => {
      popover!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[data-testid="quote-feedback-popover"]')).toBeNull();
    expect(onRequestChanges).not.toHaveBeenCalled();
    getSelectionSpy.mockRestore();
  });

  it('truncates long selected text in the quote anchor', async () => {
    const onRequestChanges = vi.fn().mockResolvedValue(undefined);
    const { host } = renderThread({
      reviewState: 'review',
      deliveries: [makeDelivery({ result: '第一版成果' })],
      onRequestChanges,
    });

    const { getSelectionSpy } = selectTextIn(host, '第一版成果', 'x'.repeat(250));
    act(() => {
      host
        .querySelector('[data-testid="quote-feedback-button"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    typeInTextarea(host, '这段有问题');
    await clickButtonByTextAsync(host, '提交');
    const anchor = onRequestChanges.mock.calls[0][1] as FeedbackAnchor;
    expect(anchor.kind).toBe('quote');
    if (anchor.kind === 'quote') {
      expect(anchor.quote).toHaveLength(201);
      expect(anchor.quote.endsWith('…')).toBe(true);
    }
    getSelectionSpy.mockRestore();
  });

  it('feedback replies render the quote anchor', () => {
    const { host } = renderThread({
      feedbackItems: [
        makeFeedback({
          anchor: { kind: 'quote', quote: 'return null;' },
        }),
      ],
    });
    expect(host.textContent).toContain('引用');
    expect(host.textContent).toContain('return null;');
  });

  it('renders the precipitation suggestion as a light hint card', () => {
    const { host } = renderThread({
      deliveries: [makeDelivery({})],
      precipitationSuggestion: {
        text: '这次的做法要沉淀为工作流吗？回复「沉淀一下」我就整理好。',
        at: '2026-07-31T10:00:00.000Z',
      },
    });
    const hint = host.querySelector('[data-testid="precipitation-suggestion"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain('沉淀一下');
  });
});
