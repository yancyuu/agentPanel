import { describe, expect, it } from 'vitest';

import {
  lastUserMessage,
  type ParsedHermitBridgeStore,
  parseHermitBridgeSessions,
  projectFromFileName,
  sessionLastActivityAt,
} from '../hermitBridgeSessionStore';

/** Minimal raw store fixture matching hermit-bridge's on-disk shape. */
function sampleRaw(overrides: Record<string, unknown> = {}): unknown {
  return {
    sessions: {
      s1: {
        id: 's1',
        name: 's1',
        agent_session_id: 'claude-uuid-1',
        agent_type: 'claudecode',
        history: [
          { role: 'user', content: 'hello', timestamp: '2026-06-21T13:00:00+08:00' },
          { role: 'assistant', content: 'hey', timestamp: '2026-06-21T13:01:00+08:00' },
        ],
        created_at: '2026-06-16T19:58:16+08:00',
        updated_at: '2026-06-21T00:26:50+08:00',
        last_user_activity: '0001-01-01T00:00:00Z',
      },
    },
    active_session: { 'feishu:oc_CHAT:ou_SENDER': 'claude-uuid-1' },
    user_sessions: {
      'feishu:oc_CHAT:ou_SENDER': ['claude-uuid-1'],
      'feishu:oc_CHAT:on_MSG': ['claude-uuid-1'],
    },
    user_meta: {
      'feishu:oc_CHAT:ou_SENDER': { chat_name: '产品群', user_name: 'Alice' },
      'feishu:oc_CHAT:on_MSG': { chat_name: '产品群' },
    },
    counter: {},
    version: 1,
    ...overrides,
  };
}

describe('projectFromFileName', () => {
  it('strips the trailing _<hex hash> suffix', () => {
    expect(projectFromFileName('hermit开发_dd28a0d3.json')).toBe('hermit开发');
    expect(projectFromFileName('hermit-agent-1cce_99f353ab.json')).toBe('hermit-agent-1cce');
  });

  it('falls back to the whole stem when there is no hash suffix', () => {
    expect(projectFromFileName('plain.json')).toBe('plain');
    expect(projectFromFileName('a_b_c.json')).toBe('a_b_c');
  });
});

describe('parseHermitBridgeSessions', () => {
  it('returns null for non-object input', () => {
    expect(parseHermitBridgeSessions(null, 'p_abc.json')).toBeNull();
    expect(parseHermitBridgeSessions('nope', 'p_abc.json')).toBeNull();
  });

  it('decodes the project from the file name', () => {
    const store = parseHermitBridgeSessions(sampleRaw(), 'hermit开发_dd28a0d3.json')!;
    expect(store.project).toBe('hermit开发');
  });

  it('keys sessions by agent_session_id and preserves history + metadata', () => {
    const store = parseHermitBridgeSessions(sampleRaw(), 'hermit开发_dd28a0d3.json')!;
    expect(store.sessions.size).toBe(1);
    const sess = store.sessions.get('claude-uuid-1')!;
    expect(sess.agentSessionId).toBe('claude-uuid-1');
    expect(sess.agentType).toBe('claudecode');
    expect(sess.history).toHaveLength(2);
    expect(sess.updatedAt).toBe('2026-06-21T00:26:50+08:00');
    expect(sess.createdAt).toBe('2026-06-16T19:58:16+08:00');
  });

  it('skips session entries without an agent_session_id', () => {
    const raw = sampleRaw({
      sessions: {
        s1: { id: 's1', agent_session_id: 'claude-uuid-1', history: [], updated_at: 'x' },
        s2: { id: 's2', history: [] }, // no agent_session_id → dropped
      },
    });
    const store = parseHermitBridgeSessions(raw, 'p_abc.json')!;
    expect([...store.sessions.keys()]).toEqual(['claude-uuid-1']);
  });

  it('decodes sender-keyed and message-keyed composites with merged display names', () => {
    const store = parseHermitBridgeSessions(sampleRaw(), 'p_abc.json')!;
    // Both the ou_-keyed and on_-keyed composites are indexed.
    expect(store.composites.size).toBe(2);

    const sender = store.composites.get('feishu:oc_CHAT:ou_SENDER')!;
    expect(sender.envelope).toMatchObject({
      provider: 'feishu',
      chatId: 'oc_CHAT',
      chatType: 'group',
      senderId: 'ou_SENDER',
      senderName: 'Alice',
      chatName: '产品群',
    });
    expect([...sender.agentSessionIds]).toEqual(['claude-uuid-1']);

    const msg = store.composites.get('feishu:oc_CHAT:on_MSG')!;
    expect(msg.envelope.messageId).toBe('on_MSG');
    expect(msg.envelope.chatName).toBe('产品群');
  });

  it('collects agent_session_ids from both user_sessions and active_session', () => {
    const raw = sampleRaw({
      active_session: { 'feishu:oc_CHAT:ou_SENDER': 'claude-uuid-1' },
      user_sessions: { 'feishu:oc_CHAT:ou_SENDER': ['claude-uuid-1', 'claude-old'] },
    });
    const store = parseHermitBridgeSessions(raw, 'p_abc.json')!;
    const composite = store.composites.get('feishu:oc_CHAT:ou_SENDER')!;
    expect([...composite.agentSessionIds].sort()).toEqual(['claude-old', 'claude-uuid-1']);
  });

  it('resolves bridge internal ids in composites to their agent_session_id (current + past)', () => {
    // Real hermit-bridge files key `sessions` by internal ids like "s12" and store
    // the Claude agent_session_id (the .jsonl filename) as a field. The composite
    // maps reference the internal id, so the parser must resolve through it —
    // otherwise composite envelopes are keyed by "s12" and never match a Claude
    // session (the bug that emptied the IM upload payload in production).
    const raw = sampleRaw({
      sessions: {
        s12: {
          id: 's12',
          agent_session_id: 'claude-cur',
          past_agent_session_ids: ['claude-past'],
        },
      },
      active_session: { 'feishu:oc_CHAT:on_MSG': 's12' },
      user_sessions: { 'feishu:oc_CHAT:ou_SENDER': ['s12'] },
      user_meta: {},
    });
    const store = parseHermitBridgeSessions(raw, 'p_abc.json')!;
    const sender = store.composites.get('feishu:oc_CHAT:ou_SENDER')!;
    expect([...sender.agentSessionIds].sort()).toEqual(['claude-cur', 'claude-past']);
    const msg = store.composites.get('feishu:oc_CHAT:on_MSG')!;
    expect([...msg.agentSessionIds].sort()).toEqual(['claude-cur', 'claude-past']);
  });

  it('preserves past_agent_session_ids on the session record for legacy attribution', () => {
    const raw = sampleRaw({
      sessions: {
        s1: {
          id: 's1',
          agent_session_id: 'claude-uuid-1',
          past_agent_session_ids: ['claude-old-a', 'claude-old-b'],
          history: [],
          updated_at: 'x',
        },
      },
    });
    const store = parseHermitBridgeSessions(raw, 'p_abc.json')!;
    expect(store.sessions.get('claude-uuid-1')!.pastAgentSessionIds).toEqual([
      'claude-old-a',
      'claude-old-b',
    ]);
  });

  it('ignores composites whose provider is unknown', () => {
    const raw = sampleRaw({
      user_sessions: { 'unknownplatform:oc_CHAT:ou_X': ['claude-uuid-1'] },
      user_meta: {},
    });
    const store = parseHermitBridgeSessions(raw, 'p_abc.json')!;
    expect(store.composites.has('unknownplatform:oc_CHAT:ou_X')).toBe(false);
  });

  it('returns an empty (but valid) store when no maps are present', () => {
    const store = parseHermitBridgeSessions({ version: 1 }, 'p_abc.json')!;
    // Non-hash underscores are preserved (only trailing _<hex> is stripped).
    expect(store.project).toBe('p_abc');
    expect(store.composites.size).toBe(0);
    expect(store.sessions.size).toBe(0);
  });
});

describe('session activity helpers', () => {
  it('sessionLastActivityAt uses the last history timestamp (not last_user_activity, not updated_at)', () => {
    const store = parseHermitBridgeSessions(sampleRaw(), 'p_abc.json')!;
    const sess = store.sessions.get('claude-uuid-1')!;
    // Last history entry (13:01) is later than updated_at (00:26); that must win.
    expect(sessionLastActivityAt(sess)).toBe('2026-06-21T13:01:00+08:00');
  });

  it('falls back to updated_at when history is empty, then createdAt', () => {
    const raw = sampleRaw({
      sessions: {
        s1: {
          id: 's1',
          agent_session_id: 'u1',
          history: [],
          updated_at: '2026-06-21T00:26:50+08:00',
          created_at: '2026-06-16T19:58:16+08:00',
        },
      },
    });
    const sess = parseHermitBridgeSessions(raw, 'p.json')!.sessions.get('u1')!;
    expect(sessionLastActivityAt(sess)).toBe('2026-06-21T00:26:50+08:00');

    const raw2 = sampleRaw({
      sessions: {
        s1: {
          id: 's1',
          agent_session_id: 'u1',
          history: [],
          created_at: '2026-06-16T19:58:16+08:00',
        },
      },
    });
    const sess2 = parseHermitBridgeSessions(raw2, 'p.json')!.sessions.get('u1')!;
    expect(sessionLastActivityAt(sess2)).toBe('2026-06-16T19:58:16+08:00');
  });

  it('lastUserMessage returns the most recent user-role entry', () => {
    const store = parseHermitBridgeSessions(sampleRaw(), 'p_abc.json')!;
    const sess = store.sessions.get('claude-uuid-1')!;
    const last = lastUserMessage(sess);
    expect(last?.content).toBe('hello');
  });

  it('lastUserMessage returns null when no user entry exists', () => {
    const raw = sampleRaw({
      sessions: {
        s1: {
          id: 's1',
          agent_session_id: 'u1',
          history: [{ role: 'assistant', content: 'hi', timestamp: 't' }],
        },
      },
    });
    const sess = parseHermitBridgeSessions(raw, 'p.json')!.sessions.get('u1')!;
    expect(lastUserMessage(sess)).toBeNull();
  });
});
