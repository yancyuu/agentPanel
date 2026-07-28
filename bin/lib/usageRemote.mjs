// usageRemote.mjs — server-side (AI Monitor) usage reads for the CLI.
//
// Extracted from hermit.mjs so the remote status read lives in one importable
// module instead of inline. All calls are READ-ONLY GETs against the single
// ai-monitor base (per the API contract): they never upload and never write a
// cursor. Token refresh is delegated to auth.mjs (refreshOpenHermitAuthStatus).
//
// Endpoints (all under <base>/api/v1):
//   GET  /report/usage/status?client=&scene=  — per-channel cursor / in-flight
//   GET  /report/usage                         — authoritative ledger totals
import { BRAND } from '../branding.mjs';
import {
  readOpenHermitAuthStore,
  refreshOpenHermitAuthStatus,
  resolveConversationUploadBaseUrl,
} from './auth.mjs';

export const USAGE_UPLOAD_PROVIDER_OPTIONS = [
  {
    id: 'claudecode',
    label: 'Claude Code',
    description: `扫描本机 Claude Code 会话 usage，并按 ${BRAND.authProviderName} 消息上报协议分批增量上传`,
  },
  {
    id: 'codex',
    label: 'Codex',
    description: `扫描本机 Codex 会话 usage，并按 ${BRAND.authProviderName} 消息上报协议分批增量上传`,
  },
  {
    id: 'pi',
    label: 'Pi',
    description: `扫描本机 Pi 会话 usage，并按 ${BRAND.authProviderName} 消息上报协议分批增量上传`,
  },
];

export function normalizeUploadProviders(value) {
  let rawItems = [];
  if (Array.isArray(value)) rawItems = value;
  else if (typeof value === 'string') rawItems = [value];
  const items = rawItems.flatMap((item) => String(item).split(/[,+，、\s]+/u));
  const normalized = items
    .map((item) => String(item).trim())
    .filter((item) => USAGE_UPLOAD_PROVIDER_OPTIONS.some((option) => option.id === item));
  return Array.from(new Set(normalized));
}

export function uploadProviderLabel(provider) {
  return USAGE_UPLOAD_PROVIDER_OPTIONS.find((option) => option.id === provider)?.label || provider;
}

export function formatUploadProviders(providers) {
  const normalized = normalizeUploadProviders(providers);
  return normalized.length ? normalized.map(uploadProviderLabel).join(' + ') : '未选择';
}

function parseJsonText(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function responseBodyPreview(text) {
  return String(text || '')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[hidden]')
    .slice(0, 300);
}

/**
 * Surface the real reason a fetch failed. Node's undici throws
 * `TypeError('fetch failed')` for any network-layer failure — the message is
 * always that exact string and the actual cause (ECONNRESET,
 * UND_ERR_CONNECT_TIMEOUT, ECONNREFUSED, TLS error, ...) lives on `err.cause`.
 * Without this the panel reads a meaningless "fetch failed" and ops can't tell
 * a dead server from a bad host. Returns `"<message> (<cause detail>)"`.
 */
function explainFetchError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err && typeof err === 'object' ? err.cause : undefined;
  const code = cause?.code || cause?.errno;
  const detail = code || (cause?.message ? String(cause.message).split('\n')[0] : '') || '';
  return detail ? `${msg} (${detail})` : msg;
}

/**
 * Read-only preview of /report/usage/status channels. `providers` lets the caller pass
 * the configured upload providers (hermit.mjs currentFeatureStates). Defaults to
 * all supported local coding sources. Parallelized across providers so one slow
 * channel doesn't block the others.
 */
export async function fetchRemoteUsageStatus(providers = ['claudecode', 'codex', 'pi']) {
  const auth = await refreshOpenHermitAuthStatus();
  if (!auth.authorized) {
    return {
      authorized: false,
      channels: [],
      errors: [{ error: auth.expired ? '登录已失效，请重新登录' : '等待登录' }],
    };
  }
  const baseUrl = resolveConversationUploadBaseUrl();
  const token = readOpenHermitAuthStore().store?.token?.accessToken;
  if (!token) return { authorized: false, channels: [], errors: [{ error: '等待登录' }] };
  const platforms = normalizeUploadProviders(providers);
  // 新协议通道维度 = reporter + client + scene；IM 归属是每条消息的 im 块，不再是独立
  // scene/mode 维度。本机上报只写 scene=coding，故按 provider 各查一次 coding。
  const targets = (platforms.length ? platforms : ['claudecode']).map((platform) => ({ platform }));
  const results = await Promise.all(
    targets.map(async ({ platform }) => {
      const scene = 'coding';
      const url = `${baseUrl}/api/v1/report/usage/status?client=${encodeURIComponent(platform)}&scene=${encodeURIComponent(scene)}`;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
        });
        const text = await res.text().catch(() => '');
        if (!res.ok) {
          return {
            platform,
            scene,
            error: `usage status ${platform}/${scene} HTTP ${res.status}`,
            httpStatus: res.status,
            body: responseBodyPreview(text),
          };
        }
        const body = parseJsonText(text);
        // 新协议响应通道维度为 reporter + client + scene（无 platform/mode/source）。
        const channel =
          (Array.isArray(body?.channels) ? body.channels : []).find(
            (c) => c && c.client === platform && c.scene === scene
          ) || null;
        const cursor = channel?.currentCursor || null;
        const attemptedCursor = channel?.lastAttemptedCursor || null;
        return {
          platform,
          scene,
          checkedAt: body?.checkedAt || null,
          status: channel?.status || 'unknown',
          cursorHash: cursor?.targetCursorHash || null,
          cursorMessageCount: typeof cursor?.messageCount === 'number' ? cursor.messageCount : null,
          cursorFileCount: typeof cursor?.fileCount === 'number' ? cursor.fileCount : null,
          cursorGeneratedAt: cursor?.generatedAt || null,
          attemptedCursorHash: attemptedCursor?.targetCursorHash || null,
          attemptedCursorMessageCount:
            typeof attemptedCursor?.messageCount === 'number' ? attemptedCursor.messageCount : null,
          hasCursor: Boolean(cursor),
          inFlight: Number(channel?.inFlight?.count ?? 0),
          lastUploadId: channel?.lastUploadId || null,
        };
      } catch (err) {
        return { platform, scene, error: explainFetchError(err) };
      }
    })
  );
  const channels = [];
  const errors = [];
  for (const result of results) {
    if (result.error) {
      errors.push(result);
      continue;
    }
    channels.push(result);
  }
  return { authorized: true, channels, errors };
}

/**
 * GET /api/v1/report/usage — server-side authoritative ledger (tokens / messages
 * / batches / dedup). Best-effort: returns null when unauthorized or on any
 * failure so the CLI degrades instead of crashing.
 */
export async function fetchAuthoritativeUsage() {
  const auth = await refreshOpenHermitAuthStatus();
  if (!auth.authorized)
    return { ok: false, error: auth.expired ? '登录已失效，请重新登录' : '等待登录' };
  const baseUrl = resolveConversationUploadBaseUrl();
  const token = readOpenHermitAuthStore().store?.token?.accessToken;
  if (!token) return { ok: false, error: '等待登录' };
  try {
    const res = await fetch(`${baseUrl}/api/v1/report/usage`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return {
        ok: false,
        error: `usage HTTP ${res.status}`,
        httpStatus: res.status,
        body: responseBodyPreview(text),
      };
    }
    return { ok: true, ...(parseJsonText(text) || {}) };
  } catch (err) {
    return { ok: false, error: explainFetchError(err) };
  }
}
