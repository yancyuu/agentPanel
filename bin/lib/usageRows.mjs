// usageRows.mjs — pure render helpers for usage report rows. Extracted from
// hermit.mjs so they are importable / unit-testable (hermit.mjs has import-time
// side effects and cannot be imported in tests).
//
// The display answers one question: 我本机有多少 / 服务端收到多少。
//   本地    — local jsonl message/token volume from the daemon.
//   服务端  — server `/report/usage` message/token ledger.
//   待上报  — cursor-derived upload backlog from telemetry.conversationUpload.pending.
//
// Do NOT derive 待上报 by subtracting server totals from local totals. That is a
// coarse ledger gap, not an upload backlog.
//
// Contract for `authoritative`:
//   undefined       =>  /report/usage not read this run (localOnly) → no 服务端 row.
//   { ok: false }   =>  fetch ran and really failed → 服务端 error row.
//   { ok: true }    =>  render 服务端 row.

export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function hasField(object, field) {
  return (
    object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, field)
  );
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function providerParts(metrics) {
  if (!metrics || typeof metrics !== 'object') return [];
  const msg = finiteNumber(metrics.messages);
  const tok = finiteNumber(metrics.tokensTotal);
  const parts = [];
  if (Number.isFinite(msg)) parts.push(`消息 ${formatNumber(msg)}`);
  if (Number.isFinite(tok)) parts.push(`Token ${formatNumber(tok)}`);
  return parts;
}

export function cursorPendingRows(upload) {
  if (!upload || typeof upload !== 'object') return [];
  const lastError = typeof upload.lastError === 'string' ? upload.lastError.trim() : '';
  const hasPending =
    hasField(upload, 'pending') && upload.pending !== undefined && upload.pending !== null;
  const pending = hasPending ? Number(upload.pending) : NaN;
  if (lastError && (!hasPending || !Number.isFinite(pending) || pending <= 0)) {
    const message = /HTTP\s*(401|403)|授权不可用/u.test(lastError)
      ? '登录已过期，请重新登录'
      : `扫描失败：${lastError}`;
    return [['待上报', message, 'error']];
  }
  if (!hasPending || !Number.isFinite(pending)) return [];
  if (pending <= 0) return [['待上报', '无', 'info']];
  // Express the backlog in tokens — its real cost — when the scan reported
  // per-message usage. Falls back to a message count for channels / legacy
  // data that carry no usage, so the row never goes empty.
  const hasTok =
    hasField(upload, 'pendingTokens') &&
    upload.pendingTokens !== undefined &&
    upload.pendingTokens !== null;
  const pendingTokens = hasTok ? Number(upload.pendingTokens) : NaN;
  if (Number.isFinite(pendingTokens) && pendingTokens > 0) {
    return [['待上报', `Token ${formatNumber(pendingTokens)}`, 'warn']];
  }
  return [['待上报', `消息 ${formatNumber(pending)}`, 'warn']];
}

const LOCAL_PROVIDER_LABELS = [
  ['claudecode', 'Claude Code'],
  ['codex', 'Codex'],
  ['pi', 'Pi'],
];

function localUsageRow(telemetry) {
  const local = telemetry && typeof telemetry === 'object' ? telemetry : {};
  const allMessages = hasField(local, 'messages') ? finiteNumber(local.messages) : NaN;
  const allTokens = hasField(local, 'totalTokens') ? finiteNumber(local.totalTokens) : NaN;
  const recentMessages = hasField(local, 'recentMessages')
    ? finiteNumber(local.recentMessages)
    : NaN;
  const recentTokens = hasField(local, 'recentTokensTotal')
    ? finiteNumber(local.recentTokensTotal)
    : NaN;
  const useRecent = Number.isFinite(recentMessages) || Number.isFinite(recentTokens);
  const label = useRecent ? '本地（最近 7 天）' : '本地';
  const providerMetrics = useRecent ? local.recentByProvider : local.byProvider;
  const segments = LOCAL_PROVIDER_LABELS.flatMap(([provider, providerLabel]) => {
    const parts = providerParts(providerMetrics?.[provider]);
    return parts.length ? [`${providerLabel} ${parts.join(' · ')}`] : [];
  });
  if (segments.length) return [label, segments.join(' ｜ '), 'info'];

  const messages = useRecent ? recentMessages : allMessages;
  const tokens = useRecent ? recentTokens : allTokens;
  const parts = [];
  if (Number.isFinite(messages)) parts.push(`消息 ${formatNumber(messages)}`);
  if (Number.isFinite(tokens)) parts.push(`Token ${formatNumber(tokens)}`);
  return parts.length ? [label, parts.join(' · '), 'info'] : null;
}

function serverFailureSuffix(authoritative) {
  if (!authoritative.httpStatus) return authoritative.error || '无响应';
  let suffix = `HTTP ${authoritative.httpStatus}`;
  if (authoritative.body) suffix += ` · ${authoritative.body}`;
  return suffix;
}

function serverUsageRows(authoritative) {
  if (!authoritative || typeof authoritative !== 'object') return [];
  if (!authoritative.ok) {
    return [
      ['服务端（全量）', `读取 /report/usage 失败：${serverFailureSuffix(authoritative)}`, 'error'],
    ];
  }

  const totals =
    authoritative.totals && typeof authoritative.totals === 'object' ? authoritative.totals : {};
  const rows = [];
  const parts = [];
  const hasMessages = hasField(totals, 'messages') || hasField(authoritative, 'messages');
  const hasTokens =
    hasField(totals, 'totalTokens') ||
    hasField(totals, 'tokens') ||
    hasField(authoritative, 'totalTokens') ||
    hasField(authoritative, 'tokensTotal');
  const messages = hasMessages ? finiteNumber(totals.messages ?? authoritative.messages) : NaN;
  const tokens = hasTokens
    ? finiteNumber(
        totals.totalTokens ??
          totals.tokens ??
          authoritative.totalTokens ??
          authoritative.tokensTotal
      )
    : NaN;
  if (Number.isFinite(messages)) parts.push(`消息 ${formatNumber(messages)}`);
  if (Number.isFinite(tokens)) parts.push(`Token ${formatNumber(tokens)}`);
  if (parts.length) rows.push(['服务端（全量，不限 7 天）', parts.join(' · '), 'info']);

  const hasRejected = hasField(totals, 'rejected') || hasField(authoritative, 'rejected');
  const rejected = hasRejected ? finiteNumber(totals.rejected ?? authoritative.rejected) : NaN;
  if (Number.isFinite(rejected) && rejected > 0) {
    rows.push(['服务端拒绝', formatNumber(rejected), 'error']);
  }
  return rows;
}

/**
 * 本地 / 服务端 comparison rows. Drops the noise (dedup / batches / inserted /
 * source-of-truth) — those aren't what "how much do I have vs how much did the
 * server receive" needs. Cursor backlog is rendered separately.
 */
export function localServerRows(telemetry, authoritative) {
  const localRow = localUsageRow(telemetry);
  return [...(localRow ? [localRow] : []), ...serverUsageRows(authoritative)];
}

/**
 * True when the server response itself reports an auth failure (401/403) — from
 * either the /report/usage ledger or any /report/usage/status channel. When this
 * holds, the 服务端 / 服务端状态 / per-channel rows are noise; callers collapse
 * them into a single login-guidance row instead of dumping a wall of HTTP 401.
 *
 * Pure: operates only on the fetch-result shapes from usageRemote.mjs
 * (authoritativeUsage: {ok,httpStatus,error,body}; remoteUsage: {errors[]}).
 */
export function serverUsageUnauthorized(authoritativeUsage, remoteUsage) {
  if (authoritativeUsage?.httpStatus === 401 || authoritativeUsage?.httpStatus === 403) return true;
  const remoteErrors = Array.isArray(remoteUsage?.errors) ? remoteUsage.errors : [];
  if (remoteErrors.some((error) => error?.httpStatus === 401 || error?.httpStatus === 403))
    return true;
  // Fallback: some transports surface the status only inside the error/body text.
  const texts = [
    authoritativeUsage?.error,
    authoritativeUsage?.body,
    ...remoteErrors.map((error) => `${error?.error || ''} ${error?.body || ''}`),
  ];
  return texts.some((text) => /HTTP\s*(401|403)/u.test(String(text || '')));
}
