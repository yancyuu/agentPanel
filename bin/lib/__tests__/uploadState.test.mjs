// uploadState.test.mjs — pure helpers that decide how the 消息上报 (conversation
// upload) toggle is displayed. Two concerns, both extracted from hermit.mjs so
// they can be unit-tested without hermit.mjs's import-time side effects:
//
//   1. resolveConversationUploadEnabled(telemetry) — reconciles the persisted
//      telemetry object into ONE canonical boolean. Must agree with the worker
//      gate (UsageTelemetryService / ConversationMessageUploadService), where
//      the canonical field wins and the nested legacy field is only a fallback.
//      The top-level `uploadEnabled` is a legacy dead field (written but never read
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

  it('canonical opt-out wins over stale legacy opt-in', () => {
    expect(
      resolveConversationUploadEnabled({
        conversationUploadEnabled: false,
        conversations: { uploadEnabled: true },
      })
    ).toBe(false);
    expect(
      resolveConversationUploadEnabled({
        conversationUploadEnabled: true,
        conversations: { uploadEnabled: false },
      })
    ).toBe(true);
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
  it('disabled → 上报已关闭（即使 worker 仍存活也不显示运行中）', () => {
    const d = describeUploadToggle({ enabled: false, running: true });
    expect(d.badge).toBe('已关闭');
    expect(d.rowLabel).toBe('上报已关闭');
    expect(d.rowState).toBe('off');
    expect(d.badgeState).toBe('error');
  });

  it('enabled + running → 上报已开启（badge 运行中作附属信息）', () => {
    const d = describeUploadToggle({ enabled: true, running: true });
    expect(d.badge).toBe('运行中');
    expect(d.rowLabel).toBe('上报已开启');
    expect(d.rowState).toBe('ok');
    expect(d.badgeState).toBe('ok');
  });

  it('enabled + NOT running → 开启但后台未运行（warn 变体）', () => {
    const d = describeUploadToggle({ enabled: true, running: false });
    expect(d.rowLabel).toContain('未运行');
    expect(d.badge).toBe('未运行');
    expect(d.rowState).toBe('warn');
    expect(d.badgeState).toBe('warn');
  });
});
