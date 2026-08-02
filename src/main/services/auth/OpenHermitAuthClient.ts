/**
 * OpenHermitAuthClient — token read/refresh/probe for the worker + upload path.
 *
 * The CLI login flow (bin/lib/auth.mjs, EJS) owns OAuth/device-code login and
 * writes ~/.hermit/auth/openhermit.json. This TS client owns the read/refresh
 * side that the background telemetry worker needs: it must keep uploading across
 * access-token expiry without a human re-running `auth login`.
 *
 * Semantics deliberately mirror bin/lib/auth.mjs so the on-disk store stays
 * compatible across both writers:
 *   - refresh POSTs { refresh_token } to <store.issuer>/api/v1/auth/refresh
 *     (the auth broker; falls back to the upload base when issuer is absent).
 *   - token patch/merge/expiry normalization match normalizeAccessTokenPayload /
 *     mergeAuthToken / normalizeExpiry / isAuthTokenExpired in auth.mjs.
 *
 * All network ops are best-effort: a failed refresh returns the store unchanged
 * so callers degrade to "等待登录" instead of throwing.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const AUTH_STORE_SCHEMA_VERSION = 1;
const REFRESH_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 8_000;
// Proactive refresh lead time. Must exceed the longest operation that ships the
// token without re-checking — a full-upload batch POST (UPLOAD_TIMEOUT_MS = 60s
// in ConversationMessageUploadService). With a 30s buffer a batch could start
// at 31s-before-expiry and the token dies mid-POST → a permission error mid-run
// ("抱着抱着报权限错"); 90s guarantees a ≥30s margin after the POST. Mirrors the
// semantics bin/lib/auth.mjs isAuthTokenExpired uses for the CLI read path.
const EXPIRY_BUFFER_MS = 90_000;
const REQUIRED_UPLOAD_SCOPES = ['upload:read', 'upload:write'];

export interface AuthToken {
  accessToken?: string;
  refreshToken?: string | null;
  tokenType?: string;
  scope?: string | null;
  scopes?: string[] | null;
  expiresAt?: string | null;
  refreshExpiresAt?: string | null;
}

export interface AuthStore {
  schemaVersion?: number;
  provider?: string;
  issuer?: string | null;
  clientId?: string;
  account?: unknown;
  token?: AuthToken;
  updatedAt?: string;
  [key: string]: unknown;
}

function authStorePath(home: string): string {
  return path.join(home, 'auth', 'openhermit.json');
}

export async function readAuthStore(home: string): Promise<AuthStore | null> {
  try {
    const raw = await readFile(authStorePath(home), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as AuthStore) : null;
  } catch {
    return null;
  }
}

async function writeAuthStore(home: string, store: AuthStore): Promise<void> {
  await mkdir(path.dirname(authStorePath(home)), { recursive: true });
  await writeFile(authStorePath(home), JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
}

function normalizeExpiry(expiresIn: unknown, expiresAt: unknown): string | null {
  if (typeof expiresAt === 'string' && !Number.isNaN(Date.parse(expiresAt))) {
    return new Date(expiresAt).toISOString();
  }
  const seconds = Number(expiresIn);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  return null;
}

function normalizeScopes(payload: Record<string, unknown>): string[] | null {
  if (Array.isArray(payload.scopes)) {
    return payload.scopes.filter(
      (scope): scope is string => typeof scope === 'string' && Boolean(scope)
    );
  }
  if (typeof payload.scope === 'string') {
    return payload.scope.split(/\s+/u).filter(Boolean);
  }
  return null;
}

interface TokenPatch {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scope: string | null;
  scopes: string[] | null;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
}

function normalizeAccessTokenPayload(payload: unknown): TokenPatch | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const accessToken = p.access_token;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  const scopes = normalizeScopes(p);
  return {
    accessToken,
    refreshToken: typeof p.refresh_token === 'string' ? p.refresh_token : null,
    tokenType: typeof p.token_type === 'string' ? p.token_type : 'Bearer',
    scope: typeof p.scope === 'string' ? p.scope : (scopes?.join(' ') ?? null),
    scopes,
    expiresAt: normalizeExpiry(p.access_expires_in, p.access_expires_at),
    refreshExpiresAt: normalizeExpiry(p.refresh_expires_in, p.refresh_expires_at),
  };
}

function mergeAuthToken(existing: AuthToken, patch: TokenPatch): AuthToken {
  return {
    ...existing,
    accessToken: patch.accessToken,
    refreshToken: patch.refreshToken || existing.refreshToken || null,
    tokenType: patch.tokenType || existing.tokenType || 'Bearer',
    scope: patch.scope || existing.scope || null,
    scopes: patch.scopes || existing.scopes || null,
    expiresAt: patch.expiresAt || null,
    refreshExpiresAt: patch.refreshExpiresAt || existing.refreshExpiresAt || null,
  };
}

export function isTokenExpired(store: AuthStore | null): boolean {
  const expiresAt = store?.token?.expiresAt;
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) return true;
  return timestamp <= Date.now() + EXPIRY_BUFFER_MS;
}

function refreshUrlFor(store: AuthStore | null, fallbackBase: string): string | null {
  const base = (store?.issuer && String(store.issuer)) || fallbackBase;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/api/v1/auth/refresh`;
}

/**
 * Refresh the access token via the auth broker. Never throws — on any failure
 * returns the (unchanged) store so callers can surface "等待登录".
 */
export async function refreshAccessToken(
  home: string,
  fallbackBase = ''
): Promise<AuthStore | null> {
  const store = await readAuthStore(home);
  const refreshToken = store?.token?.refreshToken;
  const url = refreshUrlFor(store, fallbackBase);
  if (!refreshToken || !url) return store ?? null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) return store ?? null;
    const patch = normalizeAccessTokenPayload(payload);
    if (!patch) return store ?? null;
    const refreshed: AuthStore = {
      ...(store ?? {}),
      schemaVersion: store?.schemaVersion ?? AUTH_STORE_SCHEMA_VERSION,
      token: mergeAuthToken(store?.token ?? {}, patch),
      updatedAt: new Date().toISOString(),
    };
    await writeAuthStore(home, refreshed);
    // worker 刷新同样写穿透到 App 默认连接（失败不阻断）
    try {
      const { writeConnectionThrough } = await import('@shared/authSync/index.mjs');
      await writeConnectionThrough({
        connectionsDir: path.join(home, 'connections'),
        store: refreshed as never,
      });
    } catch (error) {
      console.warn(
        '[auth-sync] worker→App 写穿透失败（不影响本次刷新）:',
        error instanceof Error ? error.message : error
      );
    }
    return refreshed;
  } catch {
    return store ?? null;
  }
}

/**
 * Read the bearer token, proactively refreshing first if it is locally expired.
 * Returns null when there is no usable token (caller surfaces "等待登录").
 */
export async function getValidBearerToken(home: string, fallbackBase = ''): Promise<string | null> {
  let store = await readAuthStore(home);
  if (!store?.token?.accessToken) return null;
  if (isTokenExpired(store)) {
    store = await refreshAccessToken(home, fallbackBase);
  }
  return store?.token?.accessToken ?? null;
}

export interface ProbeAuthResult {
  ok: boolean;
  reason: string | null;
  scopes: string[];
}

/** GET /api/v1/auth/me on the upload base; verify auth + upload scopes. */
export async function probeAuth(baseUrl: string, token: string): Promise<ProbeAuthResult> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : `HTTP ${res.status}`;
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  if (!res.ok || body.authenticated === false || status !== 'ok') {
    return { ok: false, reason: `授权不可用：${status}`, scopes };
  }
  const missing = REQUIRED_UPLOAD_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) {
    return { ok: false, reason: `缺少 ${missing.join('/')} 授权，请重新登录`, scopes };
  }
  return { ok: true, reason: null, scopes };
}

export interface AuthedFetchHooks {
  onRefreshAttempt?: (reason: 'unauthorized') => void;
  onRefreshResult?: (ok: boolean) => void;
}

/**
 * fetch() that never throws on transport failure (network/DNS/timeout): a thrown
 * request is turned into a synthetic 599 "offline" Response so callers only ever
 * see a Response object and degrade gracefully (waiting-login / retry-later)
 * instead of crashing the worker. HTTP-level errors (401/500/…) are passed
 * through unchanged.
 */
function fetchErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error || 'fetch failed');
  // undici's TypeError('fetch failed') puts the real reason on `cause`. Prefer
  // the cause's code/errno (ECONNRESET, UND_ERR_CONNECT_TIMEOUT, …) — the most
  // diagnostic piece — then its message first line. Without this a transport
  // fault surfaces as a bare "fetch failed" / HTTP 599 with no clue why. Mirrors
  // explainFetchError in bin/lib/usageRemote.mjs (one shared semantics).
  const cause = (error as { cause?: { code?: string; errno?: string; message?: string } } | null)
    ?.cause;
  const detail =
    cause?.code || cause?.errno || (cause?.message ? String(cause.message).split('\n')[0] : '');
  return (detail ? `${msg} (${detail})` : msg).slice(0, 500);
}

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const message = fetchErrorMessage(error);
    return new Response(JSON.stringify({ status: `HTTP 599 ${message}`, error: message }), {
      status: 599,
      statusText: message.slice(0, 80) || 'fetch failed',
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * fetch() wrapper that, on HTTP 401, refreshes the access token once and retries
 * the request with the new bearer. The on-disk store is the sync point: a
 * successful refresh is written so subsequent calls in the same run pick it up.
 * At most one retry — avoids loops if the broker keeps rejecting. Transport
 * failures never throw (see safeFetch).
 */
export async function authedFetch(
  home: string,
  baseUrl: string,
  url: string,
  init: RequestInit,
  hooks: AuthedFetchHooks = {}
): Promise<Response> {
  const res = await safeFetch(url, init);
  if (res.status !== 401) return res;
  hooks.onRefreshAttempt?.('unauthorized');
  const store = await refreshAccessToken(home, baseUrl);
  const token = store?.token?.accessToken;
  hooks.onRefreshResult?.(Boolean(token));
  if (!token) return res;
  const headers = {
    ...(init.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${token}`,
  };
  return safeFetch(url, { ...init, headers });
}
