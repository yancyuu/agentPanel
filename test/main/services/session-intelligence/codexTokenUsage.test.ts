import { describe, expect, it } from 'vitest';

import { CodexUsageAccumulator } from '@main/services/session-intelligence/codexTokenUsage';

/**
 * Builds a Codex `token_count` record mirroring the real `~/.codex/sessions`
 * JSONL shape: a top-level `event_msg` whose `payload.info` carries usage under
 * `last_token_usage` (per-turn delta) and/or `total_token_usage` (cumulative).
 */
function tokenCountRecord(args: {
  timestamp?: string;
  turnId?: string;
  last?: Record<string, number> | null;
  total?: Record<string, number> | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = { type: 'token_count' };
  if (args.turnId !== undefined) payload.turn_id = args.turnId;
  const info: Record<string, unknown> = {};
  if (args.last !== undefined) info.last_token_usage = args.last;
  if (args.total !== undefined) info.total_token_usage = args.total;
  payload.info = info;
  return { timestamp: args.timestamp ?? '2026-07-02T00:16:30.000Z', type: 'event_msg', payload };
}

describe('CodexUsageAccumulator', () => {
  it('uses last_token_usage (per-turn delta) directly when present', () => {
    const acc = new CodexUsageAccumulator();
    const u = acc.consume(
      tokenCountRecord({
        last: {
          input_tokens: 11,
          cached_input_tokens: 2,
          output_tokens: 4,
          reasoning_output_tokens: 1,
          total_tokens: 18,
        },
        total: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 3, total_tokens: 35 },
      })
    );
    expect(u).toMatchObject({
      inputTokens: 11,
      outputTokens: 5, // output + reasoning
      cacheReadTokens: 2,
      cacheCreationTokens: 0,
      totalTokens: 18,
    });
  });

  it('skips records with info: null (no usable usage)', () => {
    const acc = new CodexUsageAccumulator();
    const obj = { timestamp: '2026-07-02T00:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } };
    expect(acc.consume(obj as Record<string, unknown>)).toBeNull();
  });

  it('does NOT sum cumulative total_token_usage — converts snapshots to per-turn deltas', () => {
    // A session with 3 turns; only cumulative `total_token_usage` is present.
    // Snapshots: 100 -> 200 -> 300 (real per-turn deltas are 100 each).
    // Summing the snapshots directly would yield 600 (double the real 300).
    const acc = new CodexUsageAccumulator({ assumeStartsFromZero: true });
    const deltas: number[] = [];
    for (const totalTokens of [100, 200, 300]) {
      const u = acc.consume(
        tokenCountRecord({
          last: null,
          total: { input_tokens: totalTokens, output_tokens: 0, total_tokens: totalTokens },
        })
      );
      deltas.push(u!.totalTokens);
    }
    expect(deltas).toEqual([100, 100, 100]);
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(300);
  });

  it('clamps negative deltas to zero (non-monotonic cumulative snapshots do not subtract)', () => {
    const acc = new CodexUsageAccumulator({ assumeStartsFromZero: true });
    const u1 = acc.consume(tokenCountRecord({ last: null, total: { total_tokens: 300, input_tokens: 300 } }))!;
    const u2 = acc.consume(tokenCountRecord({ last: null, total: { total_tokens: 250, input_tokens: 250 } }))!;
    expect(u1.totalTokens).toBe(300); // first snapshot, session starts at 0
    expect(u2.totalTokens).toBe(0); // 250 - 300 clamped to 0
  });

  it('on an incremental continuation, skips the first cumulative-only record (no safe delta)', () => {
    const acc = new CodexUsageAccumulator({ assumeStartsFromZero: false });
    const first = acc.consume(tokenCountRecord({ last: null, total: { total_tokens: 100, input_tokens: 100 } }));
    expect(first).toBeNull();
    const second = acc.consume(tokenCountRecord({ last: null, total: { total_tokens: 180, input_tokens: 180 } }));
    expect(second!.totalTokens).toBe(80);
  });

  it('keeps cumulative tracking in sync when last_token_usage (delta) and total_token_usage coexist', () => {
    // Turn 1 carries both last (delta=100) and total (cumulative=100).
    // Turn 2 carries ONLY cumulative=180 (last absent) — must delta to 80, not 180.
    const acc = new CodexUsageAccumulator({ assumeStartsFromZero: true });
    const u1 = acc.consume(
      tokenCountRecord({
        last: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
        total: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
      })
    )!;
    const u2 = acc.consume(
      tokenCountRecord({ last: null, total: { input_tokens: 180, output_tokens: 0, total_tokens: 180 } })
    )!;
    expect(u1.totalTokens).toBe(100);
    expect(u2.totalTokens).toBe(80);
  });
});
