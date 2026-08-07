import { describe, expect, it } from 'vitest';

import { BUSY_WINDOW_MS, detectImWorkers, IDLE_WINDOW_MS } from '../detectImWorkers';

import type {
  ParsedHermitBridgeSession,
  ParsedHermitBridgeStore,
} from '../hermitBridgeSessionStore';
import type { HermitBridgeSessionMessage } from '@shared/types/hermitBridge';

const NOW = Date.parse('2026-06-21T13:00:00+08:00');

function session(
  agentSessionId: string,
  opts: {
    lastHistoryAt?: string;
    updatedAt?: string;
    lastRole?: 'user' | 'assistant';
    userText?: string;
  } = {}
): ParsedHermitBridgeSession {
  const role = opts.lastRole ?? 'user';
  const history: HermitBridgeSessionMessage[] =
    opts.lastHistoryAt === undefined
      ? []
      : [
          { role: 'assistant', content: 'earlier', timestamp: '2026-06-01T00:00:00+08:00' },
          ...(role === 'user'
            ? ([
                {
                  role: 'user',
                  content: opts.userText ?? 'do the thing',
                  timestamp: opts.lastHistoryAt,
                },
              ] as const)
            : ([{ role: 'assistant', content: 'done', timestamp: opts.lastHistoryAt }] as const)),
        ];
  return {
    agentSessionId,
    history,
    updatedAt: opts.updatedAt,
    pastAgentSessionIds: [],
  };
}

function store(opts: {
  project?: string;
  compositeKey?: string;
  provider?: string;
  chatId?: string;
  chatName?: string;
  senderId?: string;
  agentSessionIds?: string[];
  sessions?: ParsedHermitBridgeSession[];
}): ParsedHermitBridgeStore {
  const key = opts.compositeKey ?? 'feishu:oc_CHAT:ou_SENDER';
  const sessions = new Map((opts.sessions ?? []).map((s) => [s.agentSessionId, s]));
  const composites = new Map([
    [
      key,
      {
        envelope: {
          provider: opts.provider ?? 'feishu',
          chatId: opts.chatId ?? 'oc_CHAT',
          chatName: opts.chatName ?? '产品群',
          chatType: 'group',
          senderId: opts.senderId ?? 'ou_SENDER',
        },
        agentSessionIds: new Set(
          opts.agentSessionIds ?? (opts.sessions ?? []).map((s) => s.agentSessionId)
        ),
      },
    ],
  ]);
  return { project: opts.project ?? 'hermit开发', composites, sessions };
}

describe('detectImWorkers', () => {
  it('marks a session whose last message is assistant within the busy window as busy', () => {
    const last = new Date(NOW - 10_000).toISOString(); // 10s ago
    const s = store({ sessions: [session('u1', { lastHistoryAt: last, lastRole: 'assistant' })] });
    const [w] = detectImWorkers([s], NOW);
    expect(w.state).toBe('busy');
    expect(w.lastRole).toBe('assistant');
    expect(w.agentSessionId).toBe('u1');
    expect(w.project).toBe('hermit开发');
    expect(w.chatName).toBe('产品群');
  });

  it('marks a session whose last message is user within the busy window as waiting', () => {
    const last = new Date(NOW - 5_000).toISOString();
    const s = store({
      sessions: [session('u1', { lastHistoryAt: last, lastRole: 'user', userText: '帮我跑测试' })],
    });
    const [w] = detectImWorkers([s], NOW);
    expect(w.state).toBe('waiting');
    expect(w.lastRole).toBe('user');
    expect(w.lastUserSnippet).toBe('帮我跑测试');
  });

  it('marks a session active within the idle window but outside the busy window as idle', () => {
    const ago = BUSY_WINDOW_MS + 5_000; // just past busy, still inside idle
    const last = new Date(NOW - ago).toISOString();
    const s = store({ sessions: [session('u1', { lastHistoryAt: last, lastRole: 'assistant' })] });
    const [w] = detectImWorkers([s], NOW);
    expect(w.state).toBe('idle');
  });

  it('drops sessions with no activity within the idle window', () => {
    const last = new Date(NOW - IDLE_WINDOW_MS - 1).toISOString(); // just past idle
    const s = store({ sessions: [session('u1', { lastHistoryAt: last })] });
    expect(detectImWorkers([s], NOW)).toHaveLength(0);
  });

  it('uses the last history timestamp, not a stale updated_at / last_user_activity', () => {
    // History is fresh; updated_at is ancient. History must win → busy.
    const freshHistory = new Date(NOW - 5_000).toISOString();
    const staleUpdated = new Date(NOW - IDLE_WINDOW_MS * 5).toISOString();
    const s = store({
      sessions: [
        session('u1', {
          lastHistoryAt: freshHistory,
          lastRole: 'assistant',
          updatedAt: staleUpdated,
        }),
      ],
    });
    const [w] = detectImWorkers([s], NOW);
    expect(w.state).toBe('busy');
  });

  it('ignores message-keyed composites (only sender conversations become workers)', () => {
    // A message-keyed composite carries messageId, not senderId.
    const last = new Date(NOW - 5_000).toISOString();
    const s = store({
      compositeKey: 'feishu:oc_CHAT:on_MSGID',
      senderId: undefined,
      sessions: [session('u1', { lastHistoryAt: last, lastRole: 'assistant' })],
    });
    // Force the envelope to look message-keyed (no senderId, with messageId).
    const comp = s.composites.get('feishu:oc_CHAT:on_MSGID')!;
    comp.envelope.senderId = undefined;
    comp.envelope.messageId = 'on_MSGID';
    expect(detectImWorkers([s], NOW)).toHaveLength(0);
  });

  it('picks the freshest agent_session_id among a composite session set', () => {
    const stale = new Date(NOW - IDLE_WINDOW_MS * 2).toISOString();
    const fresh = new Date(NOW - 5_000).toISOString();
    const s = store({
      agentSessionIds: ['old', 'cur'],
      sessions: [
        session('old', { lastHistoryAt: stale, lastRole: 'assistant' }),
        session('cur', { lastHistoryAt: fresh, lastRole: 'assistant' }),
      ],
    });
    const [w] = detectImWorkers([s], NOW);
    expect(w.agentSessionId).toBe('cur');
    expect(w.state).toBe('busy');
  });

  it('dedupes the same composite key across stores, keeping the most recent', () => {
    const stale = new Date(NOW - 60_000).toISOString();
    const fresh = new Date(NOW - 5_000).toISOString();
    const a = store({
      project: 'p1',
      sessions: [session('u1', { lastHistoryAt: stale, lastRole: 'assistant' })],
    });
    const b = store({
      project: 'p2',
      sessions: [session('u2', { lastHistoryAt: fresh, lastRole: 'assistant' })],
    });
    const workers = detectImWorkers([a, b], NOW);
    expect(workers).toHaveLength(1);
    expect(workers[0].agentSessionId).toBe('u2'); // fresher won
  });

  it('sorts workers most-recent-first', () => {
    const older = new Date(NOW - 30_000).toISOString();
    const newer = new Date(NOW - 5_000).toISOString();
    const a = store({
      compositeKey: 'feishu:oc_A:ou_A',
      senderId: 'ou_A',
      sessions: [session('u1', { lastHistoryAt: older, lastRole: 'assistant' })],
    });
    const b = store({
      compositeKey: 'feishu:oc_B:ou_B',
      senderId: 'ou_B',
      sessions: [session('u2', { lastHistoryAt: newer, lastRole: 'assistant' })],
    });
    const workers = detectImWorkers([a, b], NOW);
    expect(workers.map((w) => w.agentSessionId)).toEqual(['u2', 'u1']);
  });

  it('skips a composite whose sessions have no resolvable activity timestamp', () => {
    const s = store({ sessions: [{ agentSessionId: 'u1', history: [], pastAgentSessionIds: [] }] });
    expect(detectImWorkers([s], NOW)).toHaveLength(0);
  });
});
