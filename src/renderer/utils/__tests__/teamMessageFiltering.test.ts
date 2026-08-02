import { describe, expect, it } from 'vitest';

import { filterTeamMessages, type TeamMessagesFilter } from '../teamMessageFiltering';

import type { InboxMessage } from '@shared/types';

const defaultFilter: TeamMessagesFilter = { from: new Set(), to: new Set(), showNoise: true };

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

describe('filterTeamMessages', () => {
  // ── Basic filtering ──────────────────────────────────────────

  it('returns all messages with empty filter', () => {
    const msgs = [makeMessage(), makeMessage({ messageId: 'b' })];
    const result = filterTeamMessages(msgs, { filter: defaultFilter, searchQuery: '' });
    expect(result).toHaveLength(2);
  });

  it('filters by "from" field', () => {
    const msgs = [
      makeMessage({ from: 'user', messageId: 'a' }),
      makeMessage({ from: 'agent', messageId: 'b' }),
    ];
    const result = filterTeamMessages(msgs, {
      filter: { ...defaultFilter, from: new Set(['user']) },
      searchQuery: '',
    });
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe('user');
  });

  it('filters by "to" field', () => {
    const msgs = [
      makeMessage({ to: 'team-a', messageId: 'a' }),
      makeMessage({ to: 'team-b', messageId: 'b' }),
    ];
    const result = filterTeamMessages(msgs, {
      filter: { ...defaultFilter, to: new Set(['team-a']) },
      searchQuery: '',
    });
    expect(result).toHaveLength(1);
    expect(result[0].to).toBe('team-a');
  });

  // ── relayOfMessageId dedup ───────────────────────────────────

  it('hides relay copy when original is visible', () => {
    const original = makeMessage({ messageId: 'msg-1', from: 'user', to: 'lead' });
    const relay = makeMessage({
      messageId: 'msg-2',
      from: 'user',
      to: 'bridge',
      relayOfMessageId: 'msg-1',
    });
    const result = filterTeamMessages([original, relay], {
      filter: defaultFilter,
      searchQuery: '',
    });
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg-1');
  });

  it('keeps relay copy when original is NOT visible (filtered out)', () => {
    const relay = makeMessage({
      messageId: 'msg-2',
      from: 'other-user',
      to: 'bridge',
      relayOfMessageId: 'msg-1',
    });
    // msg-1 is not in the list at all
    const result = filterTeamMessages([relay], { filter: defaultFilter, searchQuery: '' });
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg-2');
  });

  it('keeps relay copy when original is filtered by "from" filter', () => {
    const original = makeMessage({ messageId: 'msg-1', from: 'user', to: 'lead' });
    const relay = makeMessage({
      messageId: 'msg-2',
      from: 'bridge',
      to: 'lead',
      relayOfMessageId: 'msg-1',
    });
    // Filter only shows messages from 'bridge', so original is hidden
    const result = filterTeamMessages([original, relay], {
      filter: { ...defaultFilter, from: new Set(['bridge']) },
      searchQuery: '',
    });
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg-2');
  });

  it('handles message that is its own relay (relayOfMessageId === messageId)', () => {
    const msg = makeMessage({
      messageId: 'msg-1',
      relayOfMessageId: 'msg-1',
    });
    const result = filterTeamMessages([msg], { filter: defaultFilter, searchQuery: '' });
    expect(result).toHaveLength(1);
  });

  // ── Bug: duplicate slash command messages ─────────────────────

  it('BUG CASE: two messages without relayOfMessageId both show (no dedup)', () => {
    // This is the current bug: both the direct message and the bridge copy
    // lack relayOfMessageId, so both pass through the filter
    const direct = makeMessage({
      messageId: 'direct-1',
      from: 'user',
      to: 'hermit-dev',
      text: '/hermit:daily-folder-hygiene',
    });
    const bridgeCopy = makeMessage({
      messageId: 'bridge-1',
      from: 'user',
      to: 'bridge',
      text: '/hermit:daily-folder-hygiene',
    });
    const result = filterTeamMessages([direct, bridgeCopy], {
      filter: defaultFilter,
      searchQuery: '',
    });
    // BUG: both appear because neither has relayOfMessageId
    expect(result).toHaveLength(2);
  });

  it('duplicate slash commands are deduped when relayOfMessageId is set correctly', () => {
    const direct = makeMessage({
      messageId: 'direct-1',
      from: 'user',
      to: 'hermit-dev',
      text: '/hermit:daily-folder-hygiene',
    });
    const bridgeCopy = makeMessage({
      messageId: 'bridge-1',
      from: 'user',
      to: 'bridge',
      text: '/hermit:daily-folder-hygiene',
      relayOfMessageId: 'direct-1', // FIX: server should set this
    });
    const result = filterTeamMessages([direct, bridgeCopy], {
      filter: defaultFilter,
      searchQuery: '',
    });
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('direct-1');
  });

  // ── Search query ─────────────────────────────────────────────

  it('filters by search query in text', () => {
    const msgs = [
      makeMessage({ text: 'hello world', messageId: 'a' }),
      makeMessage({ text: 'foo bar', messageId: 'b' }),
    ];
    const result = filterTeamMessages(msgs, { filter: defaultFilter, searchQuery: 'hello' });
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('a');
  });

  it('filters by search query in from/to', () => {
    const msgs = [
      makeMessage({ from: 'alice', messageId: 'a' }),
      makeMessage({ from: 'bob', messageId: 'b' }),
    ];
    const result = filterTeamMessages(msgs, { filter: defaultFilter, searchQuery: 'alice' });
    expect(result).toHaveLength(1);
  });

  // ── task_activity_notification exclusion ───────────────────────

  it('excludes task_activity_notification messages', () => {
    const msgs = [
      makeMessage({ messageId: 'a' }),
      makeMessage({
        messageId: 'b',
        messageKind: 'task_activity_notification' as InboxMessage['messageKind'],
      }),
    ];
    const result = filterTeamMessages(msgs, { filter: defaultFilter, searchQuery: '' });
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('a');
  });

  // ── Time window ──────────────────────────────────────────────

  it('filters by time window', () => {
    const msgs = [
      makeMessage({ messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z' }),
      makeMessage({ messageId: 'b', timestamp: '2026-06-13T01:00:00.000Z' }),
    ];
    const result = filterTeamMessages(msgs, {
      filter: defaultFilter,
      searchQuery: '',
      timeWindow: {
        start: new Date('2026-06-01').getTime(),
        end: new Date('2026-07-01').getTime(),
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('b');
  });
});
