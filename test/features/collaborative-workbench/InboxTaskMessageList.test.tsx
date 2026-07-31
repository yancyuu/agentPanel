import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InboxTaskMessageList } from '../../../src/features/collaborative-workbench/renderer/ui/InboxTaskMessageList';

import type { InboxTaskMessageProjection } from '../../../src/features/collaborative-workbench/renderer/utils/inboxProjection';

const message: InboxTaskMessageProjection = {
  key: 'team-a:task-1',
  task: {
    id: 'task-1',
    displayId: 'TASK-1',
    subject: '调研亚马逊开店流程',
    status: 'in_progress',
    teamName: 'team-a',
    teamDisplayName: '测试',
    owner: 'alice',
  },
  latestMessage: {
    id: 'comment-1',
    author: 'alice',
    text: '需要补充目标站点。',
    createdAt: '2026-01-01T00:00:00.000Z',
    type: 'regular',
  },
  unreadCount: 1,
  updatedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('InboxTaskMessageList', () => {
  it('presents inbox entries as long-running task feedback instead of private messages', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onSelect = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <InboxTaskMessageList
          messages={[message]}
          selectedKey={null}
          query=""
          onQueryChange={vi.fn()}
          teamFilter="all"
          onTeamFilterChange={vi.fn()}
          teamOptions={[]}
          onSelect={onSelect}
          onRefresh={vi.fn()}
          loading={false}
        />
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('任务反馈');
    expect(host.textContent).toContain('长周期任务');
    expect(host.textContent).toContain('进行中');
    expect(host.textContent).toContain('调研亚马逊开店流程');
    expect(host.textContent).toContain('需要补充目标站点');
    expect(host.textContent).not.toContain('私信');
    expect(host.querySelector('[aria-label="任务反馈列表"]')).not.toBeNull();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[role="option"]')?.click();
      await Promise.resolve();
    });
    expect(onSelect).toHaveBeenCalledWith(message.key);

    act(() => root.unmount());
  });

  it('keeps the task red dot visible while an unread task is selected', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <InboxTaskMessageList
          messages={[message]}
          selectedKey={message.key}
          query=""
          onQueryChange={vi.fn()}
          teamFilter="all"
          onTeamFilterChange={vi.fn()}
          teamOptions={[]}
          onSelect={vi.fn()}
          onRefresh={vi.fn()}
          loading={false}
        />
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="未读"]')).not.toBeNull();
    act(() => root.unmount());
  });
});
