// uploadState.test.mjs — pure helpers that decide how the 消息上报 (conversation
// upload) toggle is displayed. Two concerns, both extracted from hermit.mjs so
// they can be unit-tested without hermit.mjs's import-time side effects:
//
//   1. resolveConversationUploadEnabled(telemetry) — reconciles the persisted
//      telemetry object into ONE canonical boolean. Must agree with the worker
//      gate (UsageTelemetryService / ConversationMessageUploadService), which
//      ORs `conversationUploadEnabled || conversations.uploadEnabled`. The
//      top-level `uploadEnabled` is a legacy dead field (written but never read
//      for behavior) and must NOT flip the display — otherwise the CLI shows
//      "enabled" while the worker refuses to upload (or vice versa).
//
//   2. describeUploadToggle({ enabled, running }) — maps the logical state to
//      the row label + badge shown in the menu. The bug being guarded against:
//      when the toggle is ON but the background worker is NOT running, the menu
//      used to show "已开启" / "● 已开启", which reads as "on and working" even
//      though nothing is uploading. It must surface that the worker is idle.
import { describe, expect, it } from 'vitest';

import { describeUploadToggle, resolveConversationUploadEnabled } from '../uploadState.mjs';

describe('resolveConversationUploadEnabled — canonical boolean matching the worker gate', () => {
  it('defaults to OFF for empty / missing telemetry (message content requires opt-in)', () => {
    expect(resolveConversationUploadEnabled(undefined)).toBe(false);
    expect(resolveConversationUploadEnabled(null)).toBe(false);
    expect(resolveConversationUploadEnabled({})).toBe(false);
    expect(resolveConversationUploadEnabled('nope')).toBe(false);
  });

  it('reads the canonical conversationUploadEnabled field', () => {
    expect(resolveConversationUploadEnabled({ conversationUploadEnabled: true })).toBe(true);
    // Explicit opt-out must be honored so the toggle's OFF write sticks.
    expect(resolveConversationUploadEnabled({ conversationUploadEnabled: false })).toBe(false);
  });

  it('honors legacy conversations.uploadEnabled (true keeps on, false opts out)', () => {
    expect(resolveConversationUploadEnabled({ conversations: { uploadEnabled: true } })).toBe(true);
    expect(resolveConversationUploadEnabled({ conversations: { uploadEnabled: false } })).toBe(false);
  });

  it('explicit opt-in wins over opt-out (canonical false + legacy true → on)', () => {
    expect(
      resolveConversationUploadEnabled({ conversationUploadEnabled: false, conversations: { uploadEnabled: true } }),
    ).toBe(true);
    // both false → off
    expect(
      resolveConversationUploadEnabled({ conversationUploadEnabled: false, conversations: { uploadEnabled: false } }),
    ).toBe(false);
  });

  it('ignores the dead top-level uploadEnabled field (worker never reads it)', () => {
    // The dead field must not flip the result. Without an explicit conversation
    // upload opt-in, both values remain OFF.
    expect(resolveConversationUploadEnabled({ uploadEnabled: true })).toBe(false);
    expect(resolveConversationUploadEnabled({ uploadEnabled: false })).toBe(false);
    expect(
      resolveConversationUploadEnabled({ uploadEnabled: true, conversationUploadEnabled: false, conversations: {} }),
    ).toBe(false);
  });
});

describe('describeUploadToggle — menu labels for the 消息上报 state', () => {
  it('disabled → 未开启 (off / error)', () => {
    const d = describeUploadToggle({ enabled: false, running: false });
    expect(d.badge).toBe('未开启');
    expect(d.rowLabel).toBe('上报未开启');
    expect(d.rowState).toBe('off');
    expect(d.badgeState).toBe('error');
  });

  it('enabled + running → 运行中 (ok)', () => {
    const d = describeUploadToggle({ enabled: true, running: true });
    expect(d.badge).toBe('运行中');
    expect(d.rowLabel).toBe('上报运行中');
    expect(d.rowState).toBe('ok');
    expect(d.badgeState).toBe('ok');
  });

  it('enabled + NOT running → surfaces idle worker, never claims "已开启"', () => {
    const d = describeUploadToggle({ enabled: true, running: false });
    // The regression: this used to be "已开启" / "上报已开启", which misled users
    // into thinking uploading was active when the worker was actually stopped.
    expect(d.badge).not.toBe('已开启');
    expect(d.rowLabel).not.toBe('上报已开启');
    expect(d.rowLabel).toContain('未运行');
    expect(d.badge).toContain('运行'); // e.g. "未运行"
    expect(d.rowState).toBe('warn');
    expect(d.badgeState).toBe('warn');
  });
});
