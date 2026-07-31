import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskCommentAttachmentPicker } from '../../../src/renderer/components/team/dialogs/TaskCommentInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

const mounted: { root: ReturnType<typeof createRoot>; container: HTMLDivElement }[] = [];

function render(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('TaskCommentAttachmentPicker', () => {
  it('hides unsupported attachment controls without adding inline noise', () => {
    const container = render(
      <TaskCommentAttachmentPicker
        capability={{ available: false, unavailableReason: '浏览器模式暂不支持评论附件' }}
        disabled={false}
        onPick={vi.fn()}
      />
    );

    expect(container.textContent).toBe('');
    expect(container.querySelector('button[aria-label="添加评论附件"]')).toBeNull();
  });

  it('keeps attachment controls injectable for a capable native runtime', () => {
    const onPick = vi.fn();
    const container = render(
      <TaskCommentAttachmentPicker
        capability={{ available: true }}
        disabled={false}
        onPick={onPick}
      />
    );
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="添加评论附件"]');

    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(onPick).toHaveBeenCalledOnce();
  });
});
