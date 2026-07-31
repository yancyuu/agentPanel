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

import { TaskDeliveriesSection } from '@renderer/components/team/dialogs/TaskDeliveriesSection';

import type { Delivery, FeedbackItem } from '@shared/types';

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

function renderSection(props: {
  deliveries?: Delivery[];
  feedbackItems?: FeedbackItem[];
  onOpenHunk?: (changeKey: string) => void;
}): { host: HTMLElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<TaskDeliveriesSection {...props} />);
  });
  return { host, root };
}

function clickButton(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === label
  );
  if (!button) {
    throw new Error(`button not found: ${label}`);
  }
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('TaskDeliveriesSection', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders nothing when there are no deliveries and no feedback items', () => {
    const { host } = renderSection({ deliveries: [], feedbackItems: [] });
    expect(host.innerHTML).toBe('');
  });

  it('shows the latest delivery by default and switches versions with arrows', () => {
    const { host } = renderSection({
      deliveries: [
        makeDelivery({ version: 1, result: '第一版成果' }),
        makeDelivery({
          version: 2,
          result: '第二版成果',
          summary: '修复了空指针',
          deliveredAt: '2026-07-31T09:00:00.000Z',
        }),
      ],
    });

    expect(host.textContent).toContain('第二版成果');
    expect(host.textContent).not.toContain('第一版成果');
    expect(host.textContent).toContain('第 2 版 / 共 2 版');
    expect(host.textContent).toContain('本版变更摘要');
    expect(host.textContent).toContain('修复了空指针');

    clickButton(host, '上一版');
    expect(host.textContent).toContain('第一版成果');
    expect(host.textContent).not.toContain('第二版成果');
    expect(host.textContent).toContain('第 1 版 / 共 2 版');

    clickButton(host, '下一版');
    expect(host.textContent).toContain('第二版成果');
  });

  it('offers copy and save-as-PDF actions for the current delivery', () => {
    const { host } = renderSection({ deliveries: [makeDelivery({})] });
    expect(host.textContent).toContain('复制');
    expect(host.textContent).toContain('保存 PDF');
  });

  it('resolves addressedFeedbackIds to feedback text instead of raw ids', () => {
    const { host } = renderSection({
      deliveries: [
        makeDelivery({
          version: 2,
          result: '第二版成果',
          addressedFeedbackIds: ['fb-1'],
        }),
      ],
      feedbackItems: [makeFeedback({ id: 'fb-1', text: '请补充错误处理', status: 'resolved' })],
    });

    expect(host.textContent).toContain('本版处理的反馈');
    expect(host.textContent).toContain('请补充错误处理');
  });

  it('renders open feedback with a prominent count and resolved feedback struck through', () => {
    const { host } = renderSection({
      feedbackItems: [
        makeFeedback({ id: 'fb-1', text: '待改的问题', status: 'open' }),
        makeFeedback({
          id: 'fb-2',
          text: '已改的问题',
          status: 'resolved',
          resolvedAt: '2026-07-31T08:00:00.000Z',
        }),
      ],
    });

    expect(host.textContent).toContain('1 条待处理');
    expect(host.textContent).toContain('待处理');
    expect(host.textContent).toContain('已解决');
    expect(host.textContent).toContain('解决于');

    const resolvedText = [...host.querySelectorAll('div')].find(
      (el) => el.textContent === '已改的问题'
    );
    expect(resolvedText?.className).toContain('line-through');
  });

  it('shows 全部已解决 when no open feedback remains', () => {
    const { host } = renderSection({
      feedbackItems: [makeFeedback({ status: 'resolved', resolvedAt: '2026-07-31T08:00:00.000Z' })],
    });
    expect(host.textContent).toContain('全部已解决');
    expect(host.textContent).not.toContain('条待处理');
  });

  it('renders a quote anchor with the quoted text', () => {
    const { host } = renderSection({
      feedbackItems: [
        makeFeedback({
          anchor: { kind: 'quote', quote: 'return null;' },
        }),
      ],
    });
    expect(host.textContent).toContain('引用');
    expect(host.textContent).toContain('return null;');
  });

  it('renders a hunk anchor with file and hunk number, and clicking it opens review', () => {
    const onOpenHunk = vi.fn();
    const { host } = renderSection({
      feedbackItems: [
        makeFeedback({
          anchor: { kind: 'hunk', changeKey: 'path:src/foo.ts', hunkIndex: 2 },
        }),
      ],
      onOpenHunk,
    });

    expect(host.textContent).toContain('src/foo.ts · 第 3 个 hunk');

    const chip = [...host.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('第 3 个 hunk')
    );
    expect(chip).toBeDefined();
    act(() => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenHunk).toHaveBeenCalledWith('path:src/foo.ts');
  });

  it('renders hunk anchor as static text when onOpenHunk is not provided', () => {
    const { host } = renderSection({
      feedbackItems: [
        makeFeedback({
          anchor: { kind: 'hunk', changeKey: 'src/bar.ts', hunkIndex: 0 },
        }),
      ],
    });
    expect(host.textContent).toContain('src/bar.ts · 第 1 个 hunk');
    expect(host.querySelector('button')).toBeNull();
  });
});
