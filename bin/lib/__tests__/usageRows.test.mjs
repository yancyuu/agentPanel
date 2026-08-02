import { describe, expect, it } from 'vitest';

import { cursorPendingRows, localServerRows, serverUsageUnauthorized } from '../usageRows.mjs';

describe('usageRows', () => {
  it('renders local and server message/token rows without deriving pending from ledger delta', () => {
    expect(
      localServerRows(
        { sessions: 1810, messages: 196107, totalTokens: 9836330316 },
        {
          ok: true,
          totals: {
            sessions: 384,
            messages: 64511,
            totalTokens: 5706241053,
          },
        }
      )
    ).toEqual([
      ['本地', '消息 196.1K · Token 9836.3M', 'info'],
      ['服务端（全量，不限 7 天）', '消息 64.5K · Token 5706.2M', 'info'],
    ]);
  });

  it('renders Pi alongside Claude Code and Codex provider metrics', () => {
    expect(
      localServerRows(
        {
          recentMessages: 6,
          recentTokensTotal: 60,
          recentByProvider: {
            claudecode: { messages: 1, tokensTotal: 10 },
            codex: { messages: 2, tokensTotal: 20 },
            pi: { messages: 3, tokensTotal: 30 },
          },
        },
        undefined
      )
    ).toEqual([
      [
        '本地（最近 7 天）',
        'Claude Code 消息 1 · Token 10 ｜ Codex 消息 2 · Token 20 ｜ Pi 消息 3 · Token 30',
        'info',
      ],
    ]);
  });

  it('renders cursor-derived pending rows from upload scan state', () => {
    expect(cursorPendingRows({ pending: 12 })).toEqual([['待上报', '消息 12', 'warn']]);
    expect(cursorPendingRows({ pending: 0 })).toEqual([['待上报', '无', 'info']]);
    expect(cursorPendingRows({ pending: 0, lastError: 'network down' })).toEqual([
      ['待上报', '扫描失败：network down', 'error'],
    ]);
    expect(cursorPendingRows({ pending: 0, lastError: '授权不可用：HTTP 401' })).toEqual([
      ['待上报', '登录已过期，请重新登录', 'error'],
    ]);
    expect(cursorPendingRows(undefined)).toEqual([]);
  });

  it('prefers pendingTokens (the backlog’s real cost) over a raw message count', () => {
    // Token figure wins when the scan reported per-message usage.
    expect(cursorPendingRows({ pending: 12, pendingTokens: 34000 })).toEqual([
      ['待上报', 'Token 34.0K', 'warn'],
    ]);
    // Messages with no usage (pendingTokens 0) fall back to the message count.
    expect(cursorPendingRows({ pending: 12, pendingTokens: 0 })).toEqual([
      ['待上报', '消息 12', 'warn'],
    ]);
  });

  it('renders pending from upload.pending only and never from local/server token deltas', () => {
    const local = { sessions: 1810, messages: 196107, totalTokens: 9836330316 };
    const server = {
      ok: true,
      totals: {
        sessions: 384,
        messages: 64511,
        totalTokens: 5706241053,
      },
    };

    expect([...localServerRows(local, server), ...cursorPendingRows({ pending: 7 })]).toEqual([
      ['本地', '消息 196.1K · Token 9836.3M', 'info'],
      ['服务端（全量，不限 7 天）', '消息 64.5K · Token 5706.2M', 'info'],
      ['待上报', '消息 7', 'warn'],
    ]);
  });

  it('still supports legacy top-level server counters', () => {
    expect(
      localServerRows(
        { sessions: 10, messages: 20, totalTokens: 30 },
        { ok: true, sessions: 4, messages: 5, totalTokens: 6 }
      )
    ).toEqual([
      ['本地', '消息 20 · Token 30', 'info'],
      ['服务端（全量，不限 7 天）', '消息 5 · Token 6', 'info'],
    ]);
  });

  it('only renders server zero usage when zero is explicitly reported', () => {
    expect(localServerRows({ messages: 0, totalTokens: 0 }, { ok: true, totals: {} })).toEqual([
      ['本地', '消息 0 · Token 0', 'info'],
    ]);
    expect(
      localServerRows({ messages: 0, totalTokens: 0 }, { ok: true, totals: { messages: 0 } })
    ).toEqual([
      ['本地', '消息 0 · Token 0', 'info'],
      ['服务端（全量，不限 7 天）', '消息 0', 'info'],
    ]);
  });

  it('does not invent pending zero when upload pending is missing', () => {
    expect(cursorPendingRows({})).toEqual([]);
    expect(cursorPendingRows({ pending: undefined })).toEqual([]);
  });

  it('shows 本地（最近 7 天）from rolling-7d recent* when the worker ships them', () => {
    expect(
      localServerRows(
        {
          messages: 196107,
          totalTokens: 9836330316,
          recentMessages: 320,
          recentTokensTotal: 4_000_000,
        },
        { ok: true, totals: { messages: 64511, totalTokens: 5706241053 } }
      )
    ).toEqual([
      ['本地（最近 7 天）', '消息 320 · Token 4.0M', 'info'],
      ['服务端（全量，不限 7 天）', '消息 64.5K · Token 5706.2M', 'info'],
    ]);
  });

  it('falls back to all-time 本地 when recent* fields are absent (stale worker status)', () => {
    expect(
      localServerRows({ messages: 196107, totalTokens: 9836330316 }, { ok: true, totals: {} })
    ).toEqual([['本地', '消息 196.1K · Token 9836.3M', 'info']]);
  });
});

describe('serverUsageUnauthorized', () => {
  it('is true when the /report/usage ledger returns 401', () => {
    expect(
      serverUsageUnauthorized({ ok: false, httpStatus: 401, error: 'usage HTTP 401' }, null)
    ).toBe(true);
  });

  it('is true when a /report/usage/status channel returns 403', () => {
    expect(
      serverUsageUnauthorized(null, { errors: [{ platform: 'claudecode', httpStatus: 403 }] })
    ).toBe(true);
  });

  it('is true when 401 only appears inside the channel error text', () => {
    expect(
      serverUsageUnauthorized(null, {
        errors: [{ platform: 'codex', error: 'usage status codex/coding HTTP 401' }],
      })
    ).toBe(true);
  });

  it('is false when the server is reachable and authorized', () => {
    expect(
      serverUsageUnauthorized(
        { ok: true, totals: {} },
        { channels: [{ platform: 'claudecode' }], errors: [] }
      )
    ).toBe(false);
  });

  it('is false for non-auth failures (500 / network)', () => {
    expect(
      serverUsageUnauthorized({ ok: false, httpStatus: 500 }, { errors: [{ httpStatus: 500 }] })
    ).toBe(false);
    expect(
      serverUsageUnauthorized(null, { errors: [{ error: 'fetch failed (ECONNREFUSED)' }] })
    ).toBe(false);
  });

  it('is false when nothing was fetched', () => {
    expect(serverUsageUnauthorized(undefined, undefined)).toBe(false);
    expect(serverUsageUnauthorized(null, null)).toBe(false);
  });
});
