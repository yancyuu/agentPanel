/**
 * Codex token_count usage normalization — single source of truth shared by the
 * local usage parser and the conversation upload collector.
 *
 * A Codex `token_count` record carries usage under `payload.info`, either as:
 *   - `last_token_usage`: a PER-TURN delta (the increment for this turn), or
 *   - `total_token_usage`: a CUMULATIVE running total across the whole session.
 *
 * Summing per-turn deltas is correct. Summing cumulative snapshots is NOT — it
 * double-counts every prior turn. When only `total_token_usage` is present we
 * therefore convert each cumulative snapshot into a per-turn delta
 * (current − previous, clamped to >= 0) so both the local aggregate and each
 * uploaded message represent exactly one turn.
 *
 * Both code paths feed records through `CodexUsageAccumulator` so the
 * delta/cumulative decision lives in one place and the local total matches the
 * server-reported total.
 */
import { resolveUsageTotalTokens, tokenNumber } from './tokenUsageTotals';

export interface CodexUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function isCodexTokenCountRecord(obj: Record<string, unknown>): boolean {
  const payload = objectRecord(obj.payload);
  return String(payload?.type ?? '') === 'token_count';
}

function normalizeUsage(source: Record<string, unknown>): CodexUsage {
  const inputTokens = tokenNumber(
    source.input_tokens ??
      source.inputTokens ??
      source.input ??
      source.prompt_tokens ??
      source.promptTokens
  );
  const cacheReadTokens = tokenNumber(
    source.cached_input_tokens ??
      source.cache_read_input_tokens ??
      source.cacheReadTokens ??
      source.cachedInputTokens
  );
  const rawOutput = tokenNumber(
    source.output_tokens ??
      source.outputTokens ??
      source.output ??
      source.completion_tokens ??
      source.completionTokens
  );
  const reasoning = tokenNumber(
    source.reasoning_output_tokens ?? source.reasoningTokens ?? source.reasoning_tokens
  );
  // Codex invariant (verified against real ~/.codex logs): total_tokens ==
  // input_tokens + output_tokens. cached_input_tokens is a SUBSET of
  // input_tokens (not additive), and reasoning is already included in
  // output_tokens. So when `total_tokens` is absent we construct it as
  // input + output only — adding cacheRead and/or reasoning here would
  // double-count and inflate the per-message total the server sums.
  const totalTokens = resolveUsageTotalTokens(source, {
    inputTokens,
    outputTokens: rawOutput,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  });
  return {
    inputTokens,
    outputTokens: rawOutput + reasoning,
    cacheReadTokens,
    cacheCreationTokens: 0,
    totalTokens,
  };
}

interface CumulativeTotals {
  input: number;
  output: number;
  cached: number;
  total: number;
}

function snapshotTotals(usage: CodexUsage): CumulativeTotals {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cached: usage.cacheReadTokens,
    total: usage.totalTokens,
  };
}

function clampDelta(cur: number, prev: number): number {
  return Math.max(0, cur - prev);
}

/**
 * Stateful, per-session accumulator. Feed it each `token_count` record in file
 * order; `consume()` returns the per-turn usage delta to attribute to that
 * record, or `null` when the record carries no usable usage (e.g. `info: null`).
 *
 * `assumeStartsFromZero` governs the very first cumulative-only record: a fresh
 * full-file scan (offset 0) may treat the first cumulative snapshot as the
 * first turn's delta (sessions start at 0); an incremental continuation
 * (offset > 0) cannot, so it skips that record rather than risk a false delta.
 */
export class CodexUsageAccumulator {
  private prevTotals: CumulativeTotals | null = null;
  private readonly assumeStartsFromZero: boolean;

  constructor(opts: { assumeStartsFromZero?: boolean } = {}) {
    this.assumeStartsFromZero = opts.assumeStartsFromZero ?? true;
  }

  consume(obj: Record<string, unknown>): CodexUsage | null {
    const payload = objectRecord(obj.payload);
    const info = objectRecord(payload?.info);
    if (!info) return null;
    const lastSrc = objectRecord(info.last_token_usage);
    const totalSrc = objectRecord(info.total_token_usage);
    if (!lastSrc && !totalSrc) return null;

    const last = lastSrc ? normalizeUsage(lastSrc) : null;
    const tot = totalSrc ? normalizeUsage(totalSrc) : null;

    // Capture the previous cumulative snapshot BEFORE this record advances it.
    const prev = this.prevTotals;

    let delta: CodexUsage | null;
    if (last) {
      // Per-turn delta — use directly.
      delta = last;
    } else if (tot) {
      // Cumulative-only — derive the per-turn delta from the previous snapshot.
      if (prev) {
        delta = {
          inputTokens: clampDelta(tot.inputTokens, prev.input),
          outputTokens: clampDelta(tot.outputTokens, prev.output),
          cacheReadTokens: clampDelta(tot.cacheReadTokens, prev.cached),
          cacheCreationTokens: 0,
          totalTokens: clampDelta(tot.totalTokens, prev.total),
        };
      } else if (this.assumeStartsFromZero) {
        // Fresh scan: the session started at 0, so the first cumulative snapshot
        // equals this turn's delta.
        delta = tot;
      } else {
        // Incremental continuation with no prior context: cannot derive a safe
        // delta, so skip this record rather than over-count.
        delta = null;
      }
    } else {
      delta = null;
    }

    // Advance the cumulative cursor from this record's cumulative snapshot so
    // the next cumulative-only record can delta against it. This stays in sync
    // even while `last_token_usage` (delta) is the attributed usage, because the
    // sibling `total_token_usage` reflects the running total after this turn.
    if (tot) {
      this.prevTotals = snapshotTotals(tot);
    }

    return delta;
  }
}

/**
 * Resolves the occurred-at timestamp for a Codex `token_count` record. Kept
 * here so both consumers pick the same field order, but it is purely a value
 * selector (no state).
 */
export function codexEventTimestamp(obj: Record<string, unknown>, fallback: string): string {
  const payload = objectRecord(obj.payload);
  const info = objectRecord(payload?.info);
  const ts =
    (typeof obj.timestamp === 'string' && obj.timestamp) ||
    (typeof payload?.timestamp === 'string' && payload.timestamp) ||
    (typeof info?.timestamp === 'string' && info.timestamp) ||
    '';
  return ts || fallback;
}
