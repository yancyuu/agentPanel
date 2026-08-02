// uploadState.mjs — pure helpers for the 消息上报 (conversation upload) toggle.
// Extracted from hermit.mjs so the two decisions that drive the menu display
// are unit-testable and reused (not triplicated) across the status row and the
// two badge call sites (toggle-message-upload + data-sync/local-collection).
//
// These are pure functions: no side effects, no I/O, no hermit.mjs imports.

/**
 * Reconcile a persisted telemetry object into the single canonical boolean that
 * means "conversation upload is on". This MUST agree with the worker gate
 * (UsageTelemetryService / ConversationMessageUploadService). The top-level
 * `uploadEnabled` is a legacy dead field — written by old code paths but never
 * read for upload behavior — so it is deliberately ignored here; honoring it
 * would make the CLI claim "enabled" while the worker refuses to upload.
 *
 * EXPLICIT-OPT-IN semantics: conversation upload is ON only when the user has
 * explicitly enabled the canonical or legacy switch. A fresh install resolves
 * to OFF, because connecting a remote service or granting a broad upload scope
 * must not implicitly authorize message content. The canonical field always
 * wins when present (so a stale `conversations.uploadEnabled: true` cannot
 * resurrect upload after the toggle writes an explicit false); the nested
 * legacy field is only a migration fallback. Resolution rule:
 *   • canonical boolean present → use it
 *   • otherwise → legacy === true
 *   • both absent → OFF (default)
 *
 * @param {unknown} telemetry
 * @returns {boolean}
 */
export function resolveConversationUploadEnabled(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return false;
  const t = /** @type {Record<string, unknown>} */ (telemetry);
  const canonical = t.conversationUploadEnabled;
  const legacy = t.conversations && typeof t.conversations === 'object'
    ? (/** @type {Record<string, unknown>} */ (t.conversations).uploadEnabled)
    : undefined;
  if (typeof canonical === 'boolean') return canonical;
  return legacy === true;
}

/**
 * Map the logical 消息上报 state to the row label + badge shown in the menu.
 *
 * The key invariant: when the toggle is ON but the background worker is NOT
 * running, we surface "未运行" — we never show a bare "已开启", which used to
 * read as "on and working" even though nothing was uploading.
 *
 * @param {{ enabled: boolean, running: boolean }} input
 * @returns {{ badge: string, rowLabel: string, rowState: 'off'|'ok'|'warn', badgeState: 'error'|'ok'|'warn' }}
 */
export function describeUploadToggle({ enabled, running }) {
  if (!enabled) {
    return { badge: '未开启', rowLabel: '上报未开启', rowState: 'off', badgeState: 'error' };
  }
  if (running) {
    return { badge: '运行中', rowLabel: '上报运行中', rowState: 'ok', badgeState: 'ok' };
  }
  return { badge: '未运行', rowLabel: '上报已开启·后台未运行', rowState: 'warn', badgeState: 'warn' };
}
