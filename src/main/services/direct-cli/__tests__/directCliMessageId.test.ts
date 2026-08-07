import { describe, expect, it } from 'vitest';

import { buildDirectReplyMessageId } from '../directCliMessageId';

describe('buildDirectReplyMessageId', () => {
  it('produces a direct- prefixed id tagged with the session key', () => {
    const id = buildDirectReplyMessageId('team-3ond:member:爬虫');
    expect(id.startsWith('direct-team-3ond:member:爬虫-')).toBe(true);
  });

  it('never equals a client optimistic user-message id', () => {
    const userMessageId = 'optimistic-1781365581655-r5h82f';
    const replyId = buildDirectReplyMessageId('team-3ond:member:爬虫');
    // Regression guard for the team-3ond "回复的没了" bug, where the member-DM
    // route reused the user message id as the reply id and the reply vanished.
    expect(replyId).not.toBe(userMessageId);
  });

  it('produces distinct ids across calls (no same-ms collision)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(buildDirectReplyMessageId('team-x:lead'));
    }
    expect(ids.size).toBe(50);
  });

  it('never collides with an arbitrary user message id passed by the client', () => {
    const arbitraryUserIds = [
      'optimistic-1-abc',
      'msg-123',
      'user-abc-def',
      '330ce38a-2787-4f37-8882-bfe671d5dd0a',
    ];
    for (const userId of arbitraryUserIds) {
      const replyId = buildDirectReplyMessageId('team:member:x');
      expect(replyId).not.toBe(userId);
      expect(replyId.startsWith('direct-')).toBe(true);
    }
  });
});
