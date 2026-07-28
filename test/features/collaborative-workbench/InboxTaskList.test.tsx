import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InboxTaskList } from '../../../src/features/collaborative-workbench/renderer/ui/InboxTaskList';

import type { InboxTaskProjection } from '../../../src/features/collaborative-workbench/renderer/utils/inboxProjection';

const entry: InboxTaskProjection = {
  key: 'team-a:task-1',
  task: {
    id: 'task-1',
    displayId: 'TASK-1',
    subject: '修复登录页面',
    status: 'pending',
    teamName: 'team-a',
    teamDisplayName: '团队 A',
    owner: 'alice',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  attention: 'unread',
  attentionRank: 1,
  unreadCount: 2,
  updatedAtMs: Date.parse('2026-01-01T00:00:00Z'),
};

function buttonByText(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('InboxTaskList', () => {
  it('renders segments, filters, attention metadata, and selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onViewChange = vi.fn();
    const onSelect = vi.fn();
    const onQueryChange = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <InboxTaskList
          view="inbox"
          onViewChange={onViewChange}
          query=""
          onQueryChange={onQueryChange}
          teamFilter="all"
          onTeamFilterChange={vi.fn()}
          ownerFilter="all"
          onOwnerFilterChange={vi.fn()}
          teamOptions={[['team-a', '团队 A']]}
          ownerOptions={['alice']}
          tasks={[entry]}
          selectedKey={entry.key}
          onSelect={onSelect}
          onRefresh={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('修复登录页面');
    expect(host.textContent).toContain('2 条未读评论');
    expect(host.querySelector('[aria-label="筛选团队"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="筛选负责人"]')).not.toBeNull();
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    expect(buttonByText(host, '收件箱').getAttribute('aria-selected')).toBe('true');
    expect(buttonByText(host, '进行中').getAttribute('role')).toBe('tab');

    await act(async () => {
      buttonByText(host, '进行中').click();
      buttonByText(host, '修复登录页面').click();
      const input = host.querySelector<HTMLInputElement>('[aria-label="搜索任务"]');
      if (!input) throw new Error('Search input not found');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '登录');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onViewChange).toHaveBeenCalledWith('in_progress');
    expect(onSelect).toHaveBeenCalledWith(entry.key);
    expect(onQueryChange).toHaveBeenCalledWith('登录');

    act(() => root.unmount());
  });

  it('renders a Chinese empty state without removing refresh and filters', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onRefresh = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <InboxTaskList
          view="completed"
          onViewChange={vi.fn()}
          query=""
          onQueryChange={vi.fn()}
          teamFilter="all"
          onTeamFilterChange={vi.fn()}
          ownerFilter="all"
          onOwnerFilterChange={vi.fn()}
          teamOptions={[]}
          ownerOptions={[]}
          tasks={[]}
          selectedKey={null}
          onSelect={vi.fn()}
          onRefresh={onRefresh}
        />
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('当前视图没有任务');
    const refresh = host.querySelector<HTMLButtonElement>('[aria-label="刷新任务"]');
    if (!refresh) throw new Error('Refresh button not found');
    act(() => refresh.click());
    expect(onRefresh).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });
});
