import { describe, expect, it } from 'vitest';

import { mergeTeamMessages } from '../mergeTeamMessages';

import type { InboxMessage } from '@shared/types';

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'user',
    to: 'team',
    text: 'hello',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: true,
    ...overrides,
  };
}

describe('mergeTeamMessages', () => {
  it('returns empty array for no inputs', () => {
    expect(mergeTeamMessages()).toEqual([]);
  });

  it('returns single list unchanged', () => {
    const msgs = [makeMessage({ messageId: 'a' }), makeMessage({ messageId: 'b' })];
    const result = mergeTeamMessages(msgs);
    expect(result).toHaveLength(2);
  });

  it('deduplicates by messageId', () => {
    const listA = [makeMessage({ messageId: 'msg-1', text: 'original' })];
    const listB = [makeMessage({ messageId: 'msg-1', text: 'updated' })];
    const result = mergeTeamMessages(listA, listB);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('updated'); // later array wins
  });

  it('deduplicates by composite key when no messageId', () => {
    const base = { from: 'user', timestamp: '2026-06-13T01:00:00.000Z' };
    const listA = [makeMessage({ ...base, text: 'original' })];
    const listB = [makeMessage({ ...base, text: 'updated' })];
    // Same from + timestamp + text prefix → same composite key
    // BUT different text → different key, so both appear
    // To test dedup, use same text:
    const listC = [makeMessage({ ...base, text: 'same' })];
    const listD = [makeMessage({ ...base, text: 'same' })];
    const result = mergeTeamMessages(listC, listD);
    expect(result).toHaveLength(1);
  });

  it('merges messages from multiple lists, newest first', () => {
    const listA = [makeMessage({ messageId: 'old', timestamp: '2026-01-01T00:00:00.000Z' })];
    const listB = [makeMessage({ messageId: 'new', timestamp: '2026-06-13T01:00:00.000Z' })];
    const result = mergeTeamMessages(listA, listB);
    expect(result).toHaveLength(2);
    expect(result[0].messageId).toBe('new');
    expect(result[1].messageId).toBe('old');
  });

  it('replaces optimistic message with server message by messageId', () => {
    const optimistic = makeMessage({
      messageId: 'optimistic-123',
      text: '/hermit:loop-scan',
      source: 'user_sent',
    });
    const server = makeMessage({
      messageId: 'optimistic-123',
      text: '/hermit:loop-scan',
      source: 'runtime_delivery',
    });
    const result = mergeTeamMessages([optimistic], [server]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('runtime_delivery');
  });

  it('keeps messages with different messageIds', () => {
    const msgA = makeMessage({ messageId: 'msg-a', text: 'command' });
    const msgB = makeMessage({ messageId: 'msg-b', text: 'command' });
    const result = mergeTeamMessages([msgA], [msgB]);
    expect(result).toHaveLength(2);
  });
});
