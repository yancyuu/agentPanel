import { describe, expect, it } from 'vitest';

import {
  findReferencedTask,
  getAgentActivityItems,
  getGlobalTaskKey,
  getTaskInboxActivityItems,
  projectInboxTaskMessages,
  projectInboxTasks,
} from '../../../src/features/collaborative-workbench/renderer/utils/inboxProjection';

import type { GlobalTask } from '../../../src/shared/types/team';

function task(overrides: Partial<GlobalTask> & Pick<GlobalTask, 'id'>): GlobalTask {
  const { id, ...rest } = overrides;
  return {
    id,
    subject: overrides.subject ?? id,
    status: overrides.status ?? 'pending',
    teamName: overrides.teamName ?? 'team-a',
    teamDisplayName: overrides.teamDisplayName ?? '团队 A',
    ...rest,
  };
}

describe('projectInboxTaskMessages', () => {
  it('builds inbox activity from deliveries and feedback items (comments are gone)', () => {
    const t = task({
      id: 'with-delivery',
      owner: 'alice',
      deliveries: [
        {
          version: 1,
          result: '成果全文',
          summary: '初版调研',
          deliveredAt: '2026-01-01T00:00:00Z',
        },
      ],
      feedbackItems: [
        {
          id: 'fb-1',
          text: '请补充数据来源',
          status: 'open',
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
    });

    expect(getTaskInboxActivityItems(t).map((item) => item.id)).toEqual(['delivery:1', 'fb-1']);
    expect(getTaskInboxActivityItems(t)[0]).toEqual(
      expect.objectContaining({ author: 'alice', text: '交付 第 1 版：初版调研' })
    );
    // 未读只算 agent 侧动态（交付），用户自己的反馈不算
    expect(getAgentActivityItems(t).map((item) => item.id)).toEqual(['delivery:1']);
  });

  it('projects deliveries as inbox messages and ignores tasks without activity', () => {
    const tasks = [
      task({
        id: 'agent-message',
        owner: 'alice',
        feedbackItems: [
          {
            id: 'fb-1',
            text: '补充说明',
            status: 'open',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        deliveries: [
          {
            version: 1,
            result: '成果全文',
            summary: '请确认目标市场',
            deliveredAt: '2026-01-02T00:00:00Z',
          },
        ],
      }),
      task({ id: 'no-activity' }),
    ];

    expect(
      projectInboxTaskMessages({
        tasks,
        unreadCountByTask: { 'team-a:agent-message': 1 },
      })
    ).toEqual([
      expect.objectContaining({
        key: 'team-a:agent-message',
        unreadCount: 1,
        latestMessage: expect.objectContaining({
          author: 'alice',
          text: '交付 第 1 版：请确认目标市场',
        }),
      }),
    ]);
  });
});

describe('projectInboxTasks', () => {
  it('projects tasks into running, review, and completed views', () => {
    const tasks = [
      task({ id: 'pending', status: 'pending' }),
      task({ id: 'running', status: 'in_progress' }),
      task({ id: 'review', status: 'completed', reviewState: 'review' }),
      task({ id: 'done', status: 'completed' }),
      task({ id: 'deleted', status: 'deleted' }),
      task({ id: 'team-deleted', teamDeleted: true }),
    ];

    expect(projectInboxTasks({ tasks, view: 'in_progress' }).map((entry) => entry.task.id)).toEqual(
      ['pending', 'running']
    );
    expect(projectInboxTasks({ tasks, view: 'review' }).map((entry) => entry.task.id)).toEqual([
      'review',
    ]);
    expect(projectInboxTasks({ tasks, view: 'completed' }).map((entry) => entry.task.id)).toEqual([
      'done',
    ]);
  });

  it('orders active work by clarification, unread, review, unassigned, then recency', () => {
    const tasks = [
      task({ id: 'recent', owner: 'alice', updatedAt: '2026-01-06T00:00:00Z' }),
      task({ id: 'unassigned', updatedAt: '2026-01-05T00:00:00Z' }),
      task({ id: 'review', owner: 'alice', reviewState: 'needsFix' }),
      task({ id: 'unread', owner: 'alice' }),
      task({ id: 'clarification', owner: 'alice', needsClarification: 'user' }),
    ];
    const unreadKey = getGlobalTaskKey(tasks[3]);

    expect(
      projectInboxTasks({
        tasks,
        view: 'in_progress',
        unreadCountByTask: { [unreadKey]: 2 },
      }).map((entry) => [entry.task.id, entry.attention])
    ).toEqual([
      ['clarification', 'clarification'],
      ['unread', 'unread'],
      ['review', 'review'],
      ['unassigned', 'unassigned'],
      ['recent', 'recent'],
    ]);
  });

  it('preserves composite identity when duplicate task IDs exist across teams', () => {
    const tasks = [
      task({ id: 'shared-id', teamName: 'team-a', teamDisplayName: '团队 A' }),
      task({ id: 'shared-id', teamName: 'team-b', teamDisplayName: '团队 B' }),
      task({ id: 'unique-id', teamName: 'team-c', teamDisplayName: '团队 C' }),
    ];

    expect(findReferencedTask(tasks, { taskId: 'shared-id', teamName: 'team-b' })?.teamName).toBe(
      'team-b'
    );
    expect(findReferencedTask(tasks, { taskId: 'shared-id' })).toBeUndefined();
    expect(findReferencedTask(tasks, { taskId: 'unique-id' })?.teamName).toBe('team-c');
    expect(getGlobalTaskKey(tasks[0])).not.toBe(getGlobalTaskKey(tasks[1]));
  });

  it('applies search, team, and owner filters with deterministic recent sorting', () => {
    const tasks = [
      task({
        id: 'older',
        subject: '修复登录',
        owner: 'alice',
        teamName: 'team-a',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
      task({
        id: 'newer',
        subject: '修复登录页面',
        owner: 'alice',
        teamName: 'team-a',
        updatedAt: '2026-01-02T00:00:00Z',
      }),
      task({ id: 'other', subject: '修复登录', owner: 'bob', teamName: 'team-b' }),
    ];

    expect(
      projectInboxTasks({
        tasks,
        view: 'in_progress',
        query: '登录',
        teamName: 'team-a',
        owner: 'alice',
      }).map((entry) => entry.task.id)
    ).toEqual(['newer', 'older']);
  });
});
