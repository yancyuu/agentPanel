import { runFixedRateWorkerScheduler } from '@main/telemetry/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const INTERVAL_MS = 5 * 60 * 1000;

function timerWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('fixed-rate telemetry worker scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts usage and Lark on fixed 0/5/10 minute boundaries', async () => {
    const usageStarts: number[] = [];
    const larkStarts: number[] = [];
    let stopping = false;

    const scheduler = runFixedRateWorkerScheduler({
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      now: () => Date.now(),
      wait: timerWait,
      shouldStop: () => stopping,
      scanUsage: async () => {
        usageStarts.push(Date.now());
      },
      scanLark: async () => {
        larkStarts.push(Date.now());
        if (larkStarts.length === 3) stopping = true;
      },
    });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await scheduler;

    expect(usageStarts).toEqual([0, INTERVAL_MS, INTERVAL_MS * 2]);
    expect(larkStarts).toEqual([0, INTERVAL_MS, INTERVAL_MS * 2]);
  });

  it('skips only a busy usage task while Lark continues every five minutes', async () => {
    const usageStarts: number[] = [];
    const larkStarts: number[] = [];
    let stopping = false;
    const neverFinishes = new Promise<void>(() => {});

    const scheduler = runFixedRateWorkerScheduler({
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      now: () => Date.now(),
      wait: timerWait,
      shouldStop: () => stopping,
      scanUsage: () => {
        usageStarts.push(Date.now());
        return neverFinishes;
      },
      scanLark: async () => {
        larkStarts.push(Date.now());
        if (larkStarts.length === 3) stopping = true;
      },
    });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await scheduler;

    expect(usageStarts).toEqual([0]);
    expect(larkStarts).toEqual([0, INTERVAL_MS, INTERVAL_MS * 2]);
  });

  it('skips only a busy Lark task while usage continues every five minutes', async () => {
    const usageStarts: number[] = [];
    const larkStarts: number[] = [];
    let stopping = false;
    const neverFinishes = new Promise<void>(() => {});

    const scheduler = runFixedRateWorkerScheduler({
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      now: () => Date.now(),
      wait: timerWait,
      shouldStop: () => stopping,
      scanUsage: async () => {
        usageStarts.push(Date.now());
        if (usageStarts.length === 3) stopping = true;
      },
      scanLark: () => {
        larkStarts.push(Date.now());
        return neverFinishes;
      },
    });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await scheduler;

    expect(usageStarts).toEqual([0, INTERVAL_MS, INTERVAL_MS * 2]);
    expect(larkStarts).toEqual([0]);
  });

  it('isolates failures and continues future ticks', async () => {
    const usageStarts: number[] = [];
    const larkStarts: number[] = [];
    let stopping = false;

    const scheduler = runFixedRateWorkerScheduler({
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      now: () => Date.now(),
      wait: timerWait,
      shouldStop: () => stopping,
      scanUsage: async () => {
        usageStarts.push(Date.now());
        throw new Error('usage failed');
      },
      scanLark: async () => {
        larkStarts.push(Date.now());
        if (larkStarts.length === 2) stopping = true;
        throw new Error('lark failed');
      },
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await scheduler;

    expect(usageStarts).toEqual([0, INTERVAL_MS]);
    expect(larkStarts).toEqual([0, INTERVAL_MS]);
  });

  it('uses the exact initial delay and then stays on five-minute boundaries', async () => {
    const starts: number[] = [];
    let stopping = false;

    const scheduler = runFixedRateWorkerScheduler({
      intervalMs: INTERVAL_MS,
      initialDelayMs: 3 * 60 * 1000,
      now: () => Date.now(),
      wait: timerWait,
      shouldStop: () => stopping,
      scanUsage: async () => {
        starts.push(Date.now());
      },
      scanLark: async () => {
        if (starts.length === 2) stopping = true;
      },
    });

    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
    await scheduler;

    expect(starts).toEqual([3 * 60 * 1000, 8 * 60 * 1000]);
  });
});
