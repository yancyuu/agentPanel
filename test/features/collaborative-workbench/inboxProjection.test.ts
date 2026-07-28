import { describe, expect, it } from 'vitest';

import {
  getGlobalTaskKey,
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

describe('projectInboxTasks', () => {
  it('filters deleted teams/tasks and segments pending, running, and completed work', () => {
    const tasks = [
      task({ id: 'pending', status: 'pending' }),
      task({ id: 'running', status: 'in_progress' }),
      task({ id: 'done', status: 'completed' }),
      task({ id: 'deleted', status: 'deleted' }),
      task({ id: 'team-deleted', teamDeleted: true }),
    ];

    expect(projectInboxTasks({ tasks, view: 'inbox' }).map((entry) => entry.task.id)).toEqual([
      'pending',
      'running',
    ]);
    expect(projectInboxTasks({ tasks, view: 'in_progress' }).map((entry) => entry.task.id)).toEqual(
      ['running']
    );
    expect(projectInboxTasks({ tasks, view: 'completed' }).map((entry) => entry.task.id)).toEqual([
      'done',
    ]);
  });

  it('orders inbox attention by clarification, unread, review, unassigned, then recency', () => {
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
        view: 'inbox',
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
        view: 'inbox',
        query: '登录',
        teamName: 'team-a',
        owner: 'alice',
      }).map((entry) => entry.task.id)
    ).toEqual(['newer', 'older']);
  });
});
