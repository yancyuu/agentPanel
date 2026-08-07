import { describe, expect, it } from 'vitest';

import { toMessageKey } from '../teamMessageKey';

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

describe('toMessageKey', () => {
  it('uses messageId when present', () => {
    const msg = makeMessage({ messageId: 'msg-123' });
    expect(toMessageKey(msg)).toBe('msg-123');
  });

  it('ignores whitespace-only messageId and falls back to composite key', () => {
    const msg = makeMessage({ messageId: '   ' });
    const key = toMessageKey(msg);
    expect(key).toContain('2026-01-01T00:00:00.000Z');
    expect(key).toContain('user');
    expect(key).toContain('hello');
  });

  it('ignores empty messageId and falls back to composite key', () => {
    const msg = makeMessage({ messageId: '' });
    const key = toMessageKey(msg);
    expect(key).toContain('2026-01-01T00:00:00.000Z');
  });

  it('builds composite key from timestamp-from-text when no messageId', () => {
    const msg = makeMessage({
      from: 'agent',
      text: 'world',
      timestamp: '2026-06-13T01:00:00.000Z',
    });
    const key = toMessageKey(msg);
    expect(key).toBe('2026-06-13T01:00:00.000Z-agent-world');
  });

  it('truncates text to 80 chars in composite key', () => {
    const longText = 'x'.repeat(200);
    const msg = makeMessage({ text: longText });
    const key = toMessageKey(msg);
    // Composite key format: timestamp-from-text[:80]
    // Key length = timestamp(24) + '-' + from(4) + '-' + text(80) = 109
    expect(key.length).toBeLessThanOrEqual(24 + 1 + 4 + 1 + 80);
  });

  it('handles missing text gracefully', () => {
    const msg = makeMessage({ text: undefined as unknown as string });
    const key = toMessageKey(msg);
    expect(key).toBeDefined();
    expect(key).toContain('2026-01-01');
  });

  it('produces same key for messages with same messageId', () => {
    const a = makeMessage({ messageId: 'shared-id', from: 'user', text: 'hello' });
    const b = makeMessage({ messageId: 'shared-id', from: 'agent', text: 'world' });
    expect(toMessageKey(a)).toBe(toMessageKey(b));
  });

  it('produces different keys for messages without messageId but different content', () => {
    const a = makeMessage({ from: 'user', text: 'hello' });
    const b = makeMessage({ from: 'user', text: 'world' });
    expect(toMessageKey(a)).not.toBe(toMessageKey(b));
  });
});
