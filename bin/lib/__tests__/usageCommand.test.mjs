// Regression: the 消息上报 menu toggle called enableConversationUploadWithProvider,
// which only persisted the enabled flag but never launched the telemetry worker.
// The menu then showed no checkmark + "未运行" because usageRunning stayed false
// even though the toggle was on. The fix mirrors `usage start`: actually start
// the worker. This test pins that the toggle path writes a worker pidfile +
// persists enabled settings, using OPENHERMIT_USAGE_WORKER_MODE=test so
// startTelemetryWorker writes a fake pid instead of spawning a real process.
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Neutralize node:child_process so collectRunningUsageWorkerPids() (ps via
// execSync) returns [] and no real process is spawned or signalled. Same
// interop shape as daemon.test.mjs (CJS default export required).
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => {
  const mocked = {
    spawn: mocks.spawn,
    execSync: () => '',
    exec: () => undefined,
    fork: () => undefined,
  };
  return { ...mocked, default: mocked };
});

describe('enableConversationUploadWithProvider — toggle ON starts the worker', () => {
  let tmpHome;
  let enableConversationUploadWithProvider;

  beforeAll(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-upload-'));
    // env.mjs captures HERMIT_HOME at import time → set it before the one
    // dynamic import (after resetModules) so pid/settings files land in tmpHome.
    process.env.HERMIT_HOME = tmpHome;
    process.env.OPENHERMIT_USAGE_WORKER_MODE = 'test';
    vi.resetModules();
    ({ enableConversationUploadWithProvider } = await import('../usageCommand.mjs'));
  });

  afterAll(async () => {
    delete process.env.HERMIT_HOME;
    delete process.env.OPENHERMIT_USAGE_WORKER_MODE;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('writes a worker pidfile + persists enabled settings (usageRunning must become true)', async () => {
    const result = await enableConversationUploadWithProvider();
    expect(result.started).toBe(true);
    expect(result.worker?.running).toBe(true);
    // The background worker actually launched → its pidfile exists in the
    // isolated home. Before the fix this file was never written on the toggle path.
    expect(existsSync(path.join(tmpHome, 'telemetry', 'worker.pid'))).toBe(true);
    // The enabled flag persisted so the worker gate (telemetry.enabled) is on.
    const settings = JSON.parse(readFileSync(path.join(tmpHome, 'settings.json'), 'utf-8'));
    expect(settings.taskBus.telemetry.enabled).toBe(true);
    expect(settings.taskBus.telemetry.conversationUploadEnabled).toBe(true);
    expect(settings.taskBus.telemetry.uploadProviders).toEqual(['claudecode', 'codex', 'pi']);
  });
});

describe('cursorStatusText — disambiguates the cursor batch count from a running total', () => {
  let cursorStatusText;

  beforeAll(async () => {
    // Pure function — no env dependency. Dynamic import matches the file's pattern
    // (the earlier describe mutates module state via resetModules).
    ({ cursorStatusText } = await import('../usageCommand.mjs'));
  });

  it('labels the committed-cursor message count as 本批 (per-batch), not a bare total', () => {
    const text = cursorStatusText({
      hasCursor: true,
      cursorHash: 'claudecode-coding-abc123def456',
      cursorMessageCount: 25,
      cursorGeneratedAt: '2026-07-10T06:20:05.000Z',
    });
    // The 25 is payload.messages.length of the last batch, far smaller than the
    // cumulative server total. It must read 本批 25 msg, not bare "25 msg" that
    // reads like "total uploaded = 25" and contradicts the 服务端（全量） row.
    expect(text).toContain('本批 25 msg');
    expect(text).not.toContain('· 25 msg');
    expect(text).toContain('cursor claudecode-');
  });

  it('omits the count entirely when cursorMessageCount is missing', () => {
    const text = cursorStatusText({ hasCursor: true, cursorHash: 'h123' });
    expect(text).not.toContain('msg');
  });

  it('labels the attempted-cursor batch count the same way', () => {
    const text = cursorStatusText({
      hasCursor: false,
      status: 'never_reported',
      attemptedCursorHash: 'attabc123def',
      attemptedCursorMessageCount: 7,
    });
    expect(text).toContain('本批 7 msg');
  });
});
