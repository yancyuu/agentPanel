import { describe, expect, it } from 'vitest';

import { buildInboxThreads } from './inboxThreadProjection';

import type { InboxMessage, TeamSummary } from '@shared/types';

const team: TeamSummary = {
  teamName: 'team-a',
  displayName: '产品团队',
  description: '',
  memberCount: 1,
  taskCount: 0,
  lastActivity: null,
};

function message(overrides: Partial<InboxMessage>): InboxMessage {
  return {
    from: 'alice',
    to: 'user',
    text: '你好',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: true,
    ...overrides,
  };
}

describe('inbox thread projection', () => {
  it('groups durable replies into one mail thread and preserves the real sender', () => {
    const threads = buildInboxThreads({
      teams: [team],
      messagesByTeam: {
        'team-a': [
          message({
            from: 'user',
            to: 'alice',
            text: '请检查登录流程',
            conversationId: 'conversation-1',
          }),
          message({
            text: '已经检查完成',
            timestamp: '2026-01-01T00:01:00.000Z',
            conversationId: 'conversation-1',
          }),
        ],
      },
      readAtByThread: {},
    });

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      key: 'team-a:conversation-1',
      participant: 'alice',
      subject: '请检查登录流程',
      preview: '已经检查完成',
      unread: true,
    });
    expect(threads[0].messages.map((entry) => entry.from)).toEqual(['user', 'alice']);
  });

  it('treats each conversation id as a separate mail and honors read watermarks', () => {
    const threads = buildInboxThreads({
      teams: [team],
      messagesByTeam: {
        'team-a': [
          message({ conversationId: 'conversation-1' }),
          message({
            conversationId: 'conversation-2',
            text: '第二封邮件',
            timestamp: '2026-01-02T00:00:00.000Z',
          }),
        ],
      },
      readAtByThread: { 'team-a:conversation-2': Date.parse('2026-01-02T00:00:00.000Z') },
    });

    expect(threads.map((thread) => thread.conversationId)).toEqual([
      'conversation-2',
      'conversation-1',
    ]);
    expect(threads[0].unread).toBe(false);
    expect(threads[1].unread).toBe(true);
  });

  it('adds a new draft as its own mail item', () => {
    const threads = buildInboxThreads({
      teams: [team],
      messagesByTeam: {},
      readAtByThread: {},
      draft: {
        teamName: 'team-a',
        memberName: 'alice',
        conversationId: 'conversation-new',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    });

    expect(threads).toEqual([
      expect.objectContaining({
        key: 'team-a:conversation-new',
        participant: 'alice',
        preview: '新私信',
        draft: true,
        unread: false,
      }),
    ]);
  });
});
