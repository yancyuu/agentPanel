import { describe, expect, it } from 'vitest';

import { buildReplyBlock, parseMessageReply } from './agentMessageFormatting';

describe('message reply block (parse/build)', () => {
  it('round-trips ASCII agent names', () => {
    const block = buildReplyBlock('alice', 'original text', 'my reply');
    const parsed = parseMessageReply(block);
    expect(parsed).not.toBeNull();
    expect(parsed!.agentName).toBe('alice');
    expect(parsed!.originalText).toBe('original text');
    expect(parsed!.replyText).toBe('my reply');
  });

  it('supports CJK member names (project requires Chinese names)', () => {
    // Regression: the old `[\\w.-]+` regex only matched ASCII, so structured
    // replies for Chinese-named members silently fell back to plain text.
    const block = buildReplyBlock('产品经理', '原文内容', '回复内容');
    const parsed = parseMessageReply(block);
    expect(parsed).not.toBeNull();
    expect(parsed!.agentName).toBe('产品经理');
    expect(parsed!.originalText).toBe('原文内容');
    expect(parsed!.replyText).toBe('回复内容');
  });

  it('tolerates CRLF line endings', () => {
    const block = buildReplyBlock('alice', 'orig', 'reply').replace(/\n/g, '\r\n');
    const parsed = parseMessageReply(block);
    expect(parsed).not.toBeNull();
    expect(parsed!.agentName).toBe('alice');
    expect(parsed!.originalText).toBe('orig');
    expect(parsed!.replyText).toBe('reply');
  });

  it('returns null when no reply block is present', () => {
    expect(parseMessageReply('just some plain text')).toBeNull();
  });

  it('round-trips content containing escaped quotes', () => {
    const block = buildReplyBlock('alice', 'he said "hi"', 'ok "sure"');
    const parsed = parseMessageReply(block);
    expect(parsed).not.toBeNull();
    expect(parsed!.originalText).toBe('he said "hi"');
    expect(parsed!.replyText).toBe('ok "sure"');
  });
});
