// featureState.mjs — the menu/CLI "feature state" aggregator + web-running state.
//
// Extracted from hermit.mjs so currentFeatureStates() (and the optimistic
// web-running flag + the refresh it pairs with) are importable / unit-testable
// without hermit.mjs's import-time side effects. hermit.mjs re-imports these
// under the same names, so every caller there is unchanged.
//
// currentFeatureStates() is a READ-ONLY aggregator: it pulls auth / daemon /
// telemetry-worker-pid / settings / upload / aikey / feishu-bridge state from
// the bin/lib module that owns each subsystem. The only mutable thing here is
// the in-process optimistic-web-running flag — a 10-min hint used between a
// start request and the daemon actually answering readiness.
//
// Auth is the one exception: we always want the latest server-confirmed auth
// state (not just the local cache), so auth uses an in-process TTL cache of
// the async refresh result.  Every call to currentFeatureStates() kicks off a
// background probe if the cache is stale (>30s), so the menu always eventually
// reflects "access_expired" / "需重新登录".  Callers that need the absolute
// freshest value immediately (usage report / scan paths) should call
// refreshOpenHermitAuthStatus() directly before reading auth.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { hermitHome, telemetryWorkerPidPath } from './env.mjs';
import { readOpenHermitAuthStatus, refreshOpenHermitAuthStatus } from './auth.mjs';
import { readPidFile, readDaemonPid, isPidRunning, refreshDaemonPidFromReadyServer } from './daemon.mjs';
import { readHermitSettings } from './settings.mjs';
import { normalizeUploadProviders } from './usageRemote.mjs';
import { resolveConversationUploadEnabled } from './uploadState.mjs';
import { parseActiveEnv } from './aikey.mjs';
import { checkExistingOpenHermitServer } from './runtime.mjs';

// 30-second TTL for the background auth probe result cached in-process.
const AUTH_PROBE_TTL_MS = 30_000;
let _authProbeCache = { result: null, timestamp: 0 };

export function invalidateAuthCache() {
  _authProbeCache = { result: null, timestamp: 0 };
}

// Hit /api/v1/auth/me directly and update the in-process cache with the
// server-confirmed state. /me is the source of truth for "is the user logged
// in right now" — the local store can lag (token refresh, server-side revocation,
// a login write that hasn't landed yet), which is why the menu showed 未登录
// right after login. Awaited at menu entry and after login/logout/dev-login so
// the menu reflects the real state without waiting for the 30s TTL.
//
// Non-clobbering + non-throwing: it never wipes a fresh cache mid-flight (the
// old version invalidated first, leaving a stale window where currentFeatureStates
// fell back to the local store), and on /me failure it KEEPS a fresh cache if one
// exists — only seeding from the local store when the cache is empty/stale. So a
// transient /me blip can never flip 已登录→未登录, and callers can fire-and-forget
// it after every action without clobbering a known-good value.
export async function refreshAuthCacheFromServer() {
  try {
    const result = await refreshOpenHermitAuthStatus();
    _authProbeCache = { result, timestamp: Date.now() };
    return result;
  } catch {
    // /me unreachable (e.g. local web daemon not running): keep any fresh cache
    // rather than overwriting it with a local snapshot; only seed from the local
    // store when we have nothing better. Marked fresh so the 30s background probe
    // doesn't immediately hammer /me again.
    if (_authProbeCache.result === null || Date.now() - _authProbeCache.timestamp > AUTH_PROBE_TTL_MS) {
      _authProbeCache = { result: readOpenHermitAuthStatus(), timestamp: Date.now() };
    }
    return _authProbeCache.result;
  }
}

// Fires a background refresh (no await) so the next currentFeatureStates()
// call picks up the updated value.  Idempotent — concurrent calls all write
// to the same cache slot.
function _maybeRefreshAuth() {
  const now = Date.now();
  if (_authProbeCache.result === null || now - _authProbeCache.timestamp > AUTH_PROBE_TTL_MS) {
    refreshOpenHermitAuthStatus().then((result) => {
      _authProbeCache = { result, timestamp: Date.now() };
    }).catch(() => {
      // Best-effort: on network errors, keep the stale cache rather than
      // discarding auth state entirely.
    });
  }
}

// 10-minute optimistic hint that the web console is coming up, used between the
// start request and the daemon actually answering. Cleared the moment
// refreshWebRunningState() confirms a real running pid or a ready server.
let optimisticWebRunningUntil = 0;

export function markWebRunningOptimistic() {
  optimisticWebRunningUntil = Date.now() + 10 * 60_000;
}

export function clearWebRunningOptimistic() {
  optimisticWebRunningUntil = 0;
}

// Pure-ish leaf: aikey is "claimed" when ~/.hermit/aikey.env parses to a label or
// holds any *_API_KEY export. Read on every menu repaint (cheap; same pattern as
// the pid files) so the AI 密钥 row reflects the real 认领 state. `home` defaults
// to hermitHome but is injectable so the parse logic is unit-testable in a temp
// dir (mirrors readMockBundle's { home } param in aikey.mjs).
export function readAikeyClaimed(home = hermitHome) {
  try {
    const content = readFileSync(path.join(home, 'aikey.env'), 'utf-8');
    const { label, vars } = parseActiveEnv(content);
    return Boolean(label) || Object.keys(vars).some((name) => name.endsWith('_API_KEY'));
  } catch {
    return false;
  }
}

// 缓存最近一次成功的 web-server probe 结果（pidfile 丢失但服务在跑时也能反映）
let _webServerCache = { running: false, timestamp: 0 };

export function invalidateWebServerCache() {
  _webServerCache = { running: false, timestamp: 0 };
}

export function currentFeatureStates() {
  // Use cached auth result if available and fresh; fall back to synchronous local
  // read so the function stays synchronous for all callers.
  const auth =
    _authProbeCache.result !== null && Date.now() - _authProbeCache.timestamp <= AUTH_PROBE_TTL_MS
      ? _authProbeCache.result
      : readOpenHermitAuthStatus();
  // Kick off background probe so the next currentFeatureStates() call (up to 30s
  // from now) picks up server-confirmed state including access_expired.
  _maybeRefreshAuth();
  const webPid = readDaemonPid();
  const usagePid = readPidFile(telemetryWorkerPidPath);
  const settings = readHermitSettings();
  const telemetry = settings.taskBus?.telemetry && typeof settings.taskBus.telemetry === 'object'
    ? settings.taskBus.telemetry
    : {};
  const uploadProviders = normalizeUploadProviders(
    telemetry.uploadProviders || telemetry.platform || ['claudecode', 'codex', 'pi']
  );
  const aikeyClaimed = readAikeyClaimed();
  const pidRunning = Boolean(webPid && isPidRunning(webPid));
  // 如果最近 5s 内成功探测到 server 在跑，认为 web 正在运行（即使 pidfile 缺失）
  const serverRunning = _webServerCache.running
    && Date.now() - _webServerCache.timestamp <= 5000;
  return {
    auth,
    webPid,
    usagePid,
    webRunning: pidRunning || serverRunning,
    usageRunning: Boolean(usagePid && isPidRunning(usagePid)),
    conversationUploadEnabled: resolveConversationUploadEnabled(telemetry),
    uploadProviders,
    aikeyClaimed,
  };
}

export async function refreshWebRunningState(expectedPid = null) {
  const pid = expectedPid || readDaemonPid();
  const server = await checkExistingOpenHermitServer();
  if (server.running) {
    refreshDaemonPidFromReadyServer(pid || expectedPid);
    clearWebRunningOptimistic();
    _webServerCache = { running: true, timestamp: Date.now() };
    return true;
  }
  if (pid && isPidRunning(pid)) {
    clearWebRunningOptimistic();
    _webServerCache = { running: true, timestamp: Date.now() };
    return true;
  }
  clearWebRunningOptimistic();
  _webServerCache = { running: false, timestamp: Date.now() };
  return false;
}
