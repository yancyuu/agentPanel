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
    id: 'delivery:1',
    author: 'alice',
    text: '交付 第 1 版：需要补充目标站点。',
    createdAt: '2026-01-01T00:00:00.000Z',
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

  it('按任务状态映射行内状态标签，仅 review 态显示「待你评审」', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const make = (
      id: string,
      status: 'pending' | 'in_progress' | 'completed',
      reviewState?: 'review' | 'needsFix' | 'approved'
    ): InboxTaskMessageProjection => ({
      key: `team-a:${id}`,
      task: {
        id,
        displayId: id,
        subject: id,
        status,
        reviewState,
        teamName: 'team-a',
        teamDisplayName: '测试',
        owner: 'alice',
      },
      latestMessage: {
        id: `delivery:${id}`,
        author: 'alice',
        text: '交付',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      unreadCount: 0,
      updatedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <InboxTaskMessageList
          messages={[
            make('rework', 'in_progress', 'needsFix'),
            make('awaiting-review', 'completed', 'review'),
            make('done-task', 'completed', 'approved'),
            make('todo-task', 'pending'),
          ]}
          selectedKey={null}
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

    // needsFix（返工中）归入「进行中」，不再显示「需纠正」
    expect(host.textContent).toContain('进行中');
    expect(host.textContent).not.toContain('需纠正');
    // 等用户评审是行动项，优先于任务状态
    expect(host.textContent).toContain('待你评审');
    expect(host.textContent).toContain('已完成');
    expect(host.textContent).toContain('待处理');

    // 进行中为橙橘色系
    const reworkRow = [...host.querySelectorAll('[role="option"]')].find((el) =>
      el.textContent?.includes('rework')
    );
    const chip = [...(reworkRow?.querySelectorAll('span') ?? [])].find(
      (el) => el.textContent?.trim() === '进行中'
    );
    expect(chip?.className).toContain('orange');

    act(() => root.unmount());
  });

  it('字段 review 但最新事件是 needsFix 时按派生显示「进行中」（historyEvents 单一事实源）', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const inconsistent: InboxTaskMessageProjection = {
      key: 'team-a:task-inconsistent',
      task: {
        id: 'task-inconsistent',
        displayId: 'task-inconsistent',
        subject: '不一致任务',
        status: 'completed',
        reviewState: 'review',
        historyEvents: [
          {
            id: 'e1',
            type: 'review_requested',
            from: 'none',
            to: 'review',
            timestamp: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'e2',
            type: 'review_changes_requested',
            from: 'review',
            to: 'needsFix',
            timestamp: '2026-01-01T01:00:00.000Z',
          },
        ],
        teamName: 'team-a',
        teamDisplayName: '测试',
        owner: 'alice',
      },
      latestMessage: {
        id: 'delivery:2',
        author: 'alice',
        text: '交付 第 2 版',
        createdAt: '2026-01-01T02:00:00.000Z',
      },
      unreadCount: 0,
      updatedAtMs: Date.parse('2026-01-01T02:00:00.000Z'),
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InboxTaskMessageList
          messages={[inconsistent]}
          selectedKey={null}
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

    // 派生为 needsFix 而非字段的 review：绝不显示「待你评审」
    expect(host.textContent).not.toContain('待你评审');
    expect(host.textContent).toContain('已完成');
    act(() => root.unmount());
  });

  it('waitingForAgent 显示「等待智能体上线」（amber），优先级高于待评审/待补充', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const waiting: InboxTaskMessageProjection = {
      key: 'team-a:task-waiting',
      task: {
        id: 'task-waiting',
        displayId: 'task-waiting',
        subject: '离线任务',
        status: 'completed',
        reviewState: 'review',
        needsClarification: 'user',
        waitingForAgent: true,
        teamName: 'team-a',
        teamDisplayName: '测试',
        owner: 'alice',
      },
      latestMessage: {
        id: 'delivery:waiting',
        author: 'alice',
        text: '交付 第 1 版',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      unreadCount: 0,
      updatedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InboxTaskMessageList
          messages={[waiting]}
          selectedKey={null}
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

    // 最高优先级：即使同时是 review + needsClarification，也只显示等待上线
    expect(host.textContent).toContain('等待智能体上线');
    expect(host.textContent).not.toContain('待你评审');
    expect(host.textContent).not.toContain('待你补充');
    const chip = [...host.querySelectorAll('span')].find(
      (el) => el.textContent?.trim() === '等待智能体上线'
    );
    expect(chip?.className).toContain('amber');

    act(() => root.unmount());
  });
});
