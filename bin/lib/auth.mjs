// auth.mjs — openHermit OAuth + device-authorization login, token store
// (~/.hermit/auth/openhermit.json), status/logout, dev unlock, and the
// command-entry auth gate. Exposes resolveConversationUploadBaseUrl + the
// upload base URL const for the usage pipeline.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { rethrowIfExitSentinel } from './exitGuard.mjs';

import {
  repoRoot,
  hermitHome,
  jsonRequested,
  commandArgs,
  args,
  port,
  daemonRequested,
} from './env.mjs';
import { BRAND, brandCommand, brandLogPrefix } from '../branding.mjs';
import { isInteractiveCli, printCliRows, printJson } from './terminal.mjs';
import { atomicWriteFile, chmodBestEffort, safeReadJson, readHermitSettings } from './settings.mjs';
// Single source for the cloud host/port default — change it in
// src/shared/constants/cloudConfig.mjs only (read by both the MJS CLI and the
// TS worker/upload service via the matching .d.mts).
import {
  DEFAULT_OPENHERMIT_CLOUD_BASE_URL,
  migrateLegacyCloudBaseUrl,
} from '../../src/shared/constants/cloudConfig.mjs';

const AUTH_CALLBACK_PATH = '/oauth/openhermit/callback';
const AUTH_STORE_SCHEMA_VERSION = 1;

function getAuthStorePath() {
  return process.env.OPENHERMIT_AUTH_STORE_PATH || path.join(hermitHome, 'auth', 'openhermit.json');
}

function ensureAuthStoreDir() {
  const dir = path.dirname(getAuthStorePath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodBestEffort(dir, 0o700);
  return dir;
}

function normalizeExpiry(expiresIn, expiresAt) {
  if (expiresAt && !Number.isNaN(Date.parse(expiresAt))) return new Date(expiresAt).toISOString();
  const seconds = Number(expiresIn);
  if (Number.isFinite(seconds) && seconds > 0)
    return new Date(Date.now() + seconds * 1000).toISOString();
  return null;
}

// Access tokens whose expiry the server omits must not be treated as expired
// forever. isAuthTokenExpired() treats an absent OR past expiresAt as expired (to
// force a /me probe before trusting the token), so when the server declines to
// send an expiry we synthesize a short probe horizon: long enough to ride out a
// transient /me blip, short enough that the next probe re-checks. A past existing
// expiry is NOT preserved — if /me just succeeded the token is provably alive, so
// keeping a stale dead timestamp would leave authorized=false forever (the
// "明明已登录却显示未登录" regression: /me returns authenticated:true but the local
// expiry guess is old and there is no refresh token to renew with).
const UNKNOWN_ACCESS_EXPIRY_HORIZON_MS = 5 * 60 * 1000;

function resolveAccessTokenExpiry(payload, existingExpiresAt = null) {
  const normalized = normalizeExpiry(
    payload?.access_expires_in ??
      payload?.accessExpiresIn ??
      payload?.expires_in ??
      payload?.expiresIn,
    payload?.access_expires_at ||
      payload?.accessExpiresAt ||
      payload?.expires_at ||
      payload?.expiresAt
  );
  if (normalized) return normalized;
  if (existingExpiresAt && Date.parse(existingExpiresAt) > Date.now()) return existingExpiresAt;
  return new Date(Date.now() + UNKNOWN_ACCESS_EXPIRY_HORIZON_MS).toISOString();
}

function readOpenHermitAuthStore() {
  const filePath = getAuthStorePath();
  if (!existsSync(filePath)) return { store: null, warning: null };
  const { value, error } = safeReadJson(filePath);
  if (error || !value || typeof value !== 'object') {
    return { store: null, warning: error || 'Invalid auth store' };
  }
  return { store: value, warning: null };
}

function isAuthTokenExpired(store) {
  const expiresAt = store?.token?.expiresAt;
  // null/undefined means "we don't know — the token was stored before we tracked expiry,
  // or the server didn't tell us". Treat it as expired so we always probe /auth/me
  // before trusting the token.  This prevents "已登录" when the access token is
  // actually dead but we have no refresh token to save us.
  if (!expiresAt) return true;
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) return true;
  return timestamp <= Date.now() + 30_000;
}

function authStatusFromStore(store, warning = null) {
  if (store?.provider === 'openhermit-dev' && !store?.developerMode) {
    return {
      authorized: false,
      method: null,
      account: null,
      expiresAt: null,
      refreshable: false,
      expired: false,
      warning: warning || 'Dev unlock is disabled',
    };
  }
  const token = store?.token || {};
  const hasAccessToken = typeof token.accessToken === 'string' && token.accessToken.length > 0;
  const expired = hasAccessToken ? isAuthTokenExpired(store) : false;
  return {
    authorized: Boolean(hasAccessToken && !expired),
    method: hasAccessToken ? 'oauth' : null,
    account: store?.account && typeof store.account === 'object' ? store.account : null,
    expiresAt: token.expiresAt || null,
    refreshable: Boolean(token.refreshToken),
    expired,
    warning,
    scope: typeof token.scope === 'string' ? token.scope : null,
    scopes: Array.isArray(token.scopes) ? token.scopes : normalizeScopes({ scope: token.scope }),
    developerMode: Boolean(store?.developerMode),
  };
}

function normalizeScopes(payload) {
  if (Array.isArray(payload?.scopes))
    return payload.scopes.filter((scope) => typeof scope === 'string' && scope);
  if (typeof payload?.scope === 'string') return payload.scope.split(/\s+/u).filter(Boolean);
  return null;
}

function normalizeAccessTokenPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const accessToken = payload.access_token || payload.accessToken;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  const scopes = normalizeScopes(payload);
  return {
    accessToken,
    refreshToken: payload.refresh_token || payload.refreshToken || null,
    tokenType: payload.token_type || payload.tokenType || 'Bearer',
    scope: typeof payload.scope === 'string' ? payload.scope : scopes?.join(' '),
    scopes,
    expiresAt: resolveAccessTokenExpiry(payload),
    refreshExpiresAt: normalizeExpiry(
      payload.refresh_expires_in ?? payload.refreshExpiresIn,
      payload.refresh_expires_at || payload.refreshExpiresAt
    ),
  };
}

function mergeAuthToken(existingToken = {}, tokenPatch) {
  return {
    ...existingToken,
    accessToken: tokenPatch.accessToken,
    refreshToken: tokenPatch.refreshToken || existingToken.refreshToken || null,
    tokenType: tokenPatch.tokenType || existingToken.tokenType || 'Bearer',
    scope: tokenPatch.scope || existingToken.scope || null,
    scopes: tokenPatch.scopes || existingToken.scopes || null,
    expiresAt: tokenPatch.expiresAt || null,
    refreshExpiresAt: tokenPatch.refreshExpiresAt || existingToken.refreshExpiresAt || null,
  };
}

function readOpenHermitAuthStatus() {
  if (process.env.OPENHERMIT_USAGE_OAUTH_TOKEN) {
    return {
      authorized: true,
      method: 'oauth',
      account: null,
      expiresAt: null,
      refreshable: false,
      expired: false,
      warning: null,
      source: 'env',
    };
  }
  const { store, warning } = readOpenHermitAuthStore();
  return authStatusFromStore(store, warning);
}

function writeOpenHermitAuthStore(store) {
  ensureAuthStoreDir();
  atomicWriteFile(getAuthStorePath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function deleteOpenHermitAuthStore() {
  try {
    unlinkSync(getAuthStorePath());
  } catch {
    // Already logged out.
  }
}

function getOAuthConfig() {
  const authorizeUrl =
    process.env.OPENHERMIT_OAUTH_AUTHORIZE_URL ||
    process.env.OPENHERMIT_USAGE_OAUTH_AUTHORIZE_URL ||
    process.env.OPENHERMIT_USAGE_OAUTH_URL ||
    '';
  const tokenUrl =
    process.env.OPENHERMIT_OAUTH_TOKEN_URL || process.env.OPENHERMIT_USAGE_OAUTH_TOKEN_URL || '';
  return {
    authorizeUrl,
    tokenUrl,
    userInfoUrl:
      process.env.OPENHERMIT_OAUTH_USERINFO_URL ||
      process.env.OPENHERMIT_USAGE_OAUTH_USERINFO_URL ||
      '',
    issuer:
      process.env.OPENHERMIT_OAUTH_ISSUER || (authorizeUrl ? new URL(authorizeUrl).origin : ''),
    clientId:
      process.env.OPENHERMIT_OAUTH_CLIENT_ID ||
      process.env.OPENHERMIT_USAGE_OAUTH_CLIENT_ID ||
      'openhermit-cli',
    scope:
      process.env.OPENHERMIT_OAUTH_SCOPE ||
      process.env.OPENHERMIT_USAGE_OAUTH_SCOPE ||
      'auth:user.id:read upload:read upload:write',
    timeoutMs: Number.parseInt(process.env.OPENHERMIT_OAUTH_TIMEOUT_MS || '120000', 10),
  };
}

function hasRawOAuthConfig() {
  const config = getOAuthConfig();
  return Boolean(config.authorizeUrl || config.tokenUrl || config.userInfoUrl);
}

function normalizeControlUrl(value, optionName = '--control-url') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${optionName} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${optionName} must use http or https`);
  }
  return url.toString().replace(/\/+$/u, '');
}

function normalizeCloudBaseUrl(value, sourceName = 'cloud base URL') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//iu.test(raw)
    ? raw
    : `${new URL(DEFAULT_OPENHERMIT_CLOUD_BASE_URL).protocol}//${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error(`${sourceName} must be a valid URL or host`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${sourceName} must use http or https`);
  }
  return migrateLegacyCloudBaseUrl(url.toString().replace(/\/+$/u, ''));
}

// The complete default cloud URL comes from cloudConfig.mjs. Change that one
// value to repoint every CLI, worker, upload and Lark-report path.

function cloudBaseUrlFromHost(host) {
  const raw = String(host || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//iu.test(raw)) return normalizeCloudBaseUrl(raw, 'OPENHERMIT_CLOUD_HOST');
  const defaultUrl = new URL(DEFAULT_OPENHERMIT_CLOUD_BASE_URL);
  const defaultPort = defaultUrl.port ? `:${defaultUrl.port}` : '';
  return normalizeCloudBaseUrl(
    `${defaultUrl.protocol}//${raw}${defaultPort}`,
    'OPENHERMIT_CLOUD_HOST'
  );
}

function configuredOpenHermitCloudBaseUrl({ includeDefault = true } = {}) {
  const settings = readHermitSettings();
  const cloud = settings.cloud && typeof settings.cloud === 'object' ? settings.cloud : {};
  const taskBus = settings.taskBus && typeof settings.taskBus === 'object' ? settings.taskBus : {};
  const telemetry =
    taskBus.telemetry && typeof taskBus.telemetry === 'object' ? taskBus.telemetry : {};
  const conversations =
    telemetry.conversations && typeof telemetry.conversations === 'object'
      ? telemetry.conversations
      : {};
  const authStore = readOpenHermitAuthStore().store;
  return (
    normalizeCloudBaseUrl(process.env.OPENHERMIT_CLOUD_BASE_URL, 'OPENHERMIT_CLOUD_BASE_URL') ||
    cloudBaseUrlFromHost(process.env.OPENHERMIT_CLOUD_HOST) ||
    normalizeCloudBaseUrl(cloud.baseUrl, 'settings.cloud.baseUrl') ||
    cloudBaseUrlFromHost(cloud.host) ||
    normalizeCloudBaseUrl(authStore?.baseUrl, 'auth baseUrl') ||
    normalizeCloudBaseUrl(authStore?.issuer, 'auth issuer') ||
    normalizeCloudBaseUrl(
      conversations.baseUrl,
      'settings.taskBus.telemetry.conversations.baseUrl'
    ) ||
    (includeDefault ? DEFAULT_OPENHERMIT_CLOUD_BASE_URL : null)
  );
}

// Per the AI Monitor contract there is a SINGLE base URL (https://<ai-monitor-host>/api/v1):
// auth (/auth/*) and report (/report/*) endpoints live on the SAME host. Configure
// the shared base via env (OPENHERMIT_CLOUD_BASE_URL / OPENHERMIT_CLOUD_HOST) or
// ~/.hermit/settings.json cloud.baseUrl. Split auth/report env overrides remain
// accepted for local debugging only.
const OPENHERMIT_AUTH_BROKER_URL =
  normalizeCloudBaseUrl(process.env.OPENHERMIT_AUTH_BASE_URL, 'OPENHERMIT_AUTH_BASE_URL') ||
  normalizeCloudBaseUrl(
    process.env.OPENHERMIT_USAGE_AUTH_BASE_URL,
    'OPENHERMIT_USAGE_AUTH_BASE_URL'
  ) ||
  normalizeCloudBaseUrl(
    process.env.OPENHERMIT_CLOUD_AUTH_BASE_URL,
    'OPENHERMIT_CLOUD_AUTH_BASE_URL'
  ) ||
  configuredOpenHermitCloudBaseUrl();
const OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL =
  normalizeCloudBaseUrl(
    process.env.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL,
    'OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL'
  ) ||
  normalizeCloudBaseUrl(
    process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL,
    'OPENHERMIT_CLOUD_UPLOAD_BASE_URL'
  ) ||
  configuredOpenHermitCloudBaseUrl();
const DEV_AUTH_UNLOCK_CODE = process.env.OPENHERMIT_DEV_UNLOCK_CODE || '';

function resolveConversationUploadBaseUrl(existingBaseUrl = '') {
  return (
    normalizeCloudBaseUrl(
      process.env.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL,
      'OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL'
    ) ||
    normalizeCloudBaseUrl(
      process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL,
      'OPENHERMIT_CLOUD_UPLOAD_BASE_URL'
    ) ||
    configuredOpenHermitCloudBaseUrl({ includeDefault: false }) ||
    normalizeCloudBaseUrl(existingBaseUrl, 'existing conversation upload base URL') ||
    OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL
  );
}

// Shared authed-fetch context for any server endpoint that needs the logged-in
// bearer (token distribution, ai-key, usage report, …). Resolves the /me-proven
// login state, then lifts the access token + cloud base URL. Returns null when
// not authorized / no token / no base — callers decide whether to degrade (aikey
// falls back to a local mock) or throw (token distribution: "请先登录").
async function resolveAuthedServerContext() {
  const auth = await refreshOpenHermitAuthStatus();
  if (!auth.authorized) return null;
  const baseUrl = resolveConversationUploadBaseUrl();
  const token = readOpenHermitAuthStore().store?.token?.accessToken;
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

function isSourceCheckout() {
  return existsSync(path.join(repoRoot, '.git'));
}

function getDefaultDeviceAuthBaseUrl() {
  return OPENHERMIT_AUTH_BROKER_URL;
}

function getDeviceAuthConfig({ controlUrl = null } = {}) {
  const baseUrl = normalizeControlUrl(
    controlUrl ||
      process.env.OPENHERMIT_AUTH_BASE_URL ||
      process.env.OPENHERMIT_USAGE_AUTH_BASE_URL ||
      getDefaultDeviceAuthBaseUrl(),
    'OPENHERMIT_AUTH_BASE_URL'
  );
  return {
    baseUrl,
    startUrl: process.env.OPENHERMIT_AUTH_START_URL || `${baseUrl}/api/v1/auth/start`,
    startFallbackUrl:
      process.env.OPENHERMIT_AUTH_START_FALLBACK_URL || `${baseUrl}/api/cli-auth/start`,
    pollUrl: process.env.OPENHERMIT_AUTH_POLL_URL || `${baseUrl}/api/v1/auth/poll`,
    refreshUrl: process.env.OPENHERMIT_AUTH_REFRESH_URL || `${baseUrl}/api/v1/auth/refresh`,
    meUrl: process.env.OPENHERMIT_AUTH_ME_URL || `${baseUrl}/api/v1/auth/me`,
    logoutUrl: process.env.OPENHERMIT_AUTH_LOGOUT_URL || `${baseUrl}/api/v1/auth/logout`,
    clientId:
      process.env.OPENHERMIT_OAUTH_CLIENT_ID ||
      process.env.OPENHERMIT_AUTH_CLIENT_ID ||
      'openhermit-cli',
    scope:
      process.env.OPENHERMIT_OAUTH_SCOPE ||
      process.env.OPENHERMIT_AUTH_SCOPE ||
      'auth:user.id:read upload:read upload:write',
    timeoutMs: Number.parseInt(
      process.env.OPENHERMIT_AUTH_TIMEOUT_MS || process.env.OPENHERMIT_OAUTH_TIMEOUT_MS || '600000',
      10
    ),
  };
}

function assertOAuthConfigured(config) {
  const missing = [];
  if (!config.authorizeUrl) missing.push('OPENHERMIT_OAUTH_AUTHORIZE_URL');
  if (!config.tokenUrl) missing.push('OPENHERMIT_OAUTH_TOKEN_URL');
  if (missing.length > 0) {
    throw new Error(`OAuth not configured: missing ${missing.join(', ')}`);
  }
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function randomOAuthValue(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

function buildCodeChallenge(verifier) {
  return base64Url(crypto.createHash('sha256').update(verifier).digest());
}

function buildAuthorizationUrl(config, redirectUri, state, codeChallenge) {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function openExternalUrl(url) {
  const mode =
    process.env.OPENHERMIT_AUTH_OPEN_BROWSER || process.env.OPENHERMIT_OAUTH_OPEN_BROWSER;
  if (mode === '0') return { opened: false, skipped: true };
  if (mode === 'fetch') {
    await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    return { opened: true, mode: 'fetch' };
  }

  const platform = process.platform;
  // explorer.exe opens the URL in the default browser and takes the whole URL
  // as a single argument, so query characters (& ? =) need no shell quoting.
  // The previous powershell `Start-Process -FilePath $args[0]` form exited
  // non-zero and the browser silently never opened on Windows.
  const command =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const commandArgsForPlatform = [url];

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, commandArgsForPlatform, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.once('error', () => settle({ opened: false, skipped: true, mode: command }));
    child.once('spawn', () => {
      child.unref();
      setTimeout(() => settle({ opened: true, mode: command }), 200);
    });
    child.once('exit', (code) => {
      if (code !== 0) settle({ opened: false, skipped: true, mode: command });
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildAuthCallbackHtml({ title, eyebrow, message, tone = 'success' }) {
  const accent = tone === 'success' ? '#16a34a' : tone === 'warn' ? '#d97706' : '#dc2626';
  const glow =
    tone === 'success'
      ? 'rgba(22, 163, 74, 0.22)'
      : tone === 'warn'
        ? 'rgba(217, 119, 6, 0.22)'
        : 'rgba(220, 38, 38, 0.2)';
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      overflow: hidden;
      background:
        radial-gradient(circle at 20% 15%, ${glow}, transparent 34rem),
        radial-gradient(circle at 85% 20%, rgba(59, 130, 246, 0.16), transparent 28rem),
        linear-gradient(135deg, #f8fafc 0%, #eef2f7 46%, #f8fafc 100%);
      color: #111827;
      font: 15px/1.6 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      position: relative;
      width: min(520px, calc(100vw - 32px));
      padding: 34px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 28px;
      background: rgba(255, 255, 255, 0.84);
      box-shadow: 0 24px 80px rgba(15, 23, 42, 0.12);
      backdrop-filter: blur(18px);
    }
    main::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      border-radius: inherit;
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.92), transparent 42%);
    }
    .content { position: relative; }
    .mark {
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      margin-bottom: 22px;
      border-radius: 18px;
      background: color-mix(in srgb, ${accent} 12%, white);
      color: ${accent};
      box-shadow: 0 14px 30px ${glow};
    }
    .mark svg { width: 26px; height: 26px; }
    .eyebrow {
      margin: 0 0 8px;
      color: ${accent};
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    h1 { margin: 0; font-size: clamp(30px, 6vw, 42px); line-height: 1.08; letter-spacing: -0.04em; }
    p { margin: 16px 0 0; color: #475569; }
    .hint {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 26px;
      padding-top: 18px;
      border-top: 1px solid rgba(148, 163, 184, 0.22);
      color: #64748b;
      font-size: 13px;
    }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: ${accent}; box-shadow: 0 0 0 6px ${glow}; }
    @media (prefers-color-scheme: dark) {
      body {
        background:
          radial-gradient(circle at 20% 15%, ${glow}, transparent 34rem),
          radial-gradient(circle at 85% 20%, rgba(59, 130, 246, 0.18), transparent 28rem),
          linear-gradient(135deg, #020617 0%, #111827 48%, #020617 100%);
        color: #f8fafc;
      }
      main { background: rgba(15, 23, 42, 0.78); border-color: rgba(148, 163, 184, 0.18); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.36); }
      main::before { background: linear-gradient(135deg, rgba(255, 255, 255, 0.08), transparent 42%); }
      .mark { background: color-mix(in srgb, ${accent} 18%, #0f172a); }
      p, .hint { color: #94a3b8; }
    }
  </style>
</head>
<body>
  <main>
    <div class="content">
      <div class="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
      </div>
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h1>${safeTitle}</h1>
      <p>${escapeHtml(message)}</p>
      <div class="hint"><span class="dot"></span><span>这个页面可以关闭，${BRAND.productName} 会自动继续。</span></div>
    </div>
  </main>
</body>
</html>`;
}

async function startOAuthCallbackServer(expectedState, timeoutMs) {
  let server;
  let timer;
  let closed = false;
  const closeServer = async () => {
    clearTimeout(timer);
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(() => resolve()));
  };
  const callback = new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== AUTH_CALLBACK_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        const state = requestUrl.searchParams.get('state') || '';
        const code = requestUrl.searchParams.get('code') || '';
        const error = requestUrl.searchParams.get('error') || '';
        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            buildAuthCallbackHtml({
            title: '授权失败',
            eyebrow: `${BRAND.stylizedName} Auth`,
            message: 'state 校验失败，请回到终端重试。',
            tone: 'error',
            })
          );
          reject(new Error('OAuth state mismatch'));
          return;
        }
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            buildAuthCallbackHtml({
            title: '授权已取消',
            eyebrow: `${BRAND.stylizedName} Auth`,
            message: '授权流程已取消，请回到终端查看详情。',
            tone: 'warn',
            })
          );
          reject(new Error(`OAuth provider returned error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            buildAuthCallbackHtml({
            title: '授权失败',
            eyebrow: `${BRAND.stylizedName} Auth`,
            message: '缺少授权码，请回到终端重新发起登录。',
            tone: 'error',
            })
          );
          reject(new Error('OAuth callback missing code'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          buildAuthCallbackHtml({
          title: '授权完成',
          eyebrow: `${BRAND.productName} is ready`,
          message: `你已经成功登录 ${BRAND.authProviderName}，可以回到 ${BRAND.productName} 继续使用。`,
          })
        );
        resolve(code);
      } catch (err) {
        reject(err);
      }
    });
    server.listen(0, '127.0.0.1', () => undefined);
    server.once('error', reject);
    timer = setTimeout(() => reject(new Error('OAuth login timed out')), timeoutMs);
  });

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  return {
    redirectUri: `http://127.0.0.1:${server.address().port}${AUTH_CALLBACK_PATH}`,
    waitForCode: async () => {
      try {
        return await callback;
      } finally {
        await closeServer();
      }
    },
    close: closeServer,
  };
}

async function exchangeAuthorizationCode(config, code, redirectUri, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // Keep provider response private.
  }
  if (!res.ok || !payload?.access_token) {
    throw new Error(`OAuth token exchange failed (HTTP ${res.status})`);
  }
  return payload;
}

async function fetchOAuthUserInfo(config, accessToken) {
  if (!config.userInfoUrl) return null;
  const res = await fetch(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.sub || user.id || user.open_id || user.user_id || null,
    email: user.email || null,
    name: user.name || user.display_name || user.username || null,
  };
}

function buildAuthStoreFromToken(config, tokenPayload, account) {
  const now = new Date().toISOString();
  const normalizedToken = normalizeAccessTokenPayload(tokenPayload);
  if (!normalizedToken) throw new Error('Auth token response did not include an access token');
  return {
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    provider: 'openhermit',
    issuer: config.issuer || config.baseUrl || null,
    baseUrl: config.baseUrl || config.issuer || null,
    clientId: config.clientId,
    account: account || tokenPayload.account || null,
    token: mergeAuthToken({ scope: config.scope }, normalizedToken),
    createdAt: now,
    updatedAt: now,
  };
}

async function performRawOAuthLogin({ quiet = false } = {}) {
  const config = getOAuthConfig();
  assertOAuthConfigured(config);
  const state = randomOAuthValue();
  const codeVerifier = randomOAuthValue(48);
  const codeChallenge = buildCodeChallenge(codeVerifier);
  const server = await startOAuthCallbackServer(state, config.timeoutMs || 120_000);
  const authorizationUrl = buildAuthorizationUrl(config, server.redirectUri, state, codeChallenge);

  try {
    const browser = await openExternalUrl(authorizationUrl);
    if (!quiet && browser.skipped) {
      console.log(`${brandLogPrefix()} 浏览器未自动打开，请复制下面链接完成授权：`);
      console.log(authorizationUrl);
    } else if (!quiet) {
      console.log(`${brandLogPrefix()} 已打开浏览器，请完成 ${BRAND.authProviderName} 授权...`);
    }
    const code = await server.waitForCode();
    const tokenPayload = await exchangeAuthorizationCode(
      config,
      code,
      server.redirectUri,
      codeVerifier
    );
    const account = await fetchOAuthUserInfo(config, tokenPayload.access_token);
    const store = buildAuthStoreFromToken(config, tokenPayload, account);
    writeOpenHermitAuthStore(store);
    return authStatusFromStore(store);
  } catch (err) {
    await server.close().catch(() => undefined);
    throw err;
  }
}

async function startDeviceAuthSession(config) {
  const startUrls = [config.startUrl, config.startFallbackUrl].filter(Boolean);
  let lastStatus = 0;
  let payload = null;
  for (const startUrl of startUrls) {
    const res = await fetch(startUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // client_kind:"cli" tells the broker this is a long-lived CLI session, so it
      // issues a refresh_token on the poll. Without it the poll response omits
      // refresh_token and the access token can't be refreshed (daily re-login).
      body: JSON.stringify({ client_kind: 'cli' }),
      signal: AbortSignal.timeout(30_000),
    });
    lastStatus = res.status;
    payload = await res.json().catch(() => null);
    if (res.ok && payload) break;
    if (res.status !== 404 || startUrl === startUrls[startUrls.length - 1]) {
      throw new Error(`CLI auth start failed (HTTP ${res.status})`);
    }
  }

  if (!payload) {
    throw new Error(`CLI auth start failed (HTTP ${lastStatus || 0})`);
  }

  const flowId = payload.flow_id || payload.deviceCode;
  const pollSecret = payload.poll_secret || payload.pollSecret || flowId;
  const authorizationUrl = payload.authorization_url || payload.verificationUriComplete;
  if (!flowId || !pollSecret || !authorizationUrl) {
    throw new Error(`AgentCLI auth start returned an unsupported response (HTTP ${lastStatus})`);
  }

  return {
    flowId,
    pollSecret,
    authorizationUrl,
    expiresIn: Number(payload.expires_in ?? payload.expiresIn ?? 600),
    interval: Math.max(1, Number(payload.interval || 2)),
  };
}

function normalizeHermitAuthIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return {
    id: identity.id || identity.union_id || identity.open_id || identity.user_id || null,
    email: identity.email || identity.mail || null,
    tenantKey: identity.tenant_key || identity.tenantKey || identity.tenant?.key || null,
    tenantName: identity.tenant_name || identity.tenantName || identity.tenant?.name || null,
    department:
      identity.department ||
      identity.department_name ||
      identity.departmentName ||
      identity.dept ||
      identity.dept_name ||
      null,
    departmentPath: identity.department_path || identity.departmentPath || null,
    openId: identity.open_id || identity.openId || null,
    unionId: identity.union_id || identity.unionId || null,
    userId: identity.user_id || identity.userId || null,
    name: identity.name || identity.display_name || identity.username || null,
  };
}

async function waitForAuthPollInterval(intervalMs, signal) {
  if (signal?.aborted) throw signal.reason || new Error('CLI auth cancelled');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, intervalMs);
    if (!signal) return;
    signal.addEventListener(
      'abort',
      () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('CLI auth cancelled'));
      },
      { once: true }
    );
  });
}

async function pollDeviceAuthToken(config, session, { signal = null } = {}) {
  const startedAt = Date.now();
  const timeoutAt = startedAt + Math.min(config.timeoutMs, session.expiresIn * 1000);
  let intervalMs = session.interval * 1000;

  while (Date.now() < timeoutAt) {
    if (signal?.aborted) throw signal.reason || new Error('CLI auth cancelled');
    const fetchSignal = AbortSignal.timeout(30_000);
    const isLegacyCliAuthToken = new URL(config.pollUrl).pathname === '/api/cli-auth/token';
    const res = isLegacyCliAuthToken
      ? await fetch(config.pollUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ deviceCode: session.flowId, pollSecret: session.pollSecret }),
          signal: fetchSignal,
        })
      : await fetch(
          `${config.pollUrl}?flow_id=${encodeURIComponent(session.flowId)}&poll_secret=${encodeURIComponent(session.pollSecret)}`,
          {
          headers: { Accept: 'application/json' },
          signal: fetchSignal,
          }
        );
    const payload = await res.json().catch(() => null);
    if (res.ok && normalizeAccessTokenPayload(payload)) return payload;
    const status = payload?.status || '';
    const error = payload?.error || status;
    if (error === 'authorization_pending') {
      await waitForAuthPollInterval(intervalMs, signal);
      continue;
    }
    if (error === 'slow_down') {
      intervalMs += 1000;
      await waitForAuthPollInterval(intervalMs, signal);
      continue;
    }
    throw new Error(error || `CLI auth token failed (HTTP ${res.status})`);
  }
  throw new Error('CLI auth timed out');
}

async function performDeviceAuthLogin({ quiet = false, controlUrl = null } = {}) {
  const config = getDeviceAuthConfig({ controlUrl });
  const abortController = new AbortController();
  const cancelAuth = () => abortController.abort(new Error('已取消飞书授权登录'));
  const interactiveCancel = !quiet && process.stdin.isTTY;
  let previousRawMode = false;
  const onCancelKey = (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    // Cancel on Ctrl+C (\x03), bare Esc (\x1b), or left-arrow (\x1b[D) — the same
    // keys the nav menu treats as exit/back. Inlined so auth.mjs does not depend
    // on hermit.mjs's parseMenuKeys (which was left behind when this module was
    // extracted, causing ReferenceError on the login cancel handler).
    if (text.includes('\x03') || text === '\x1b' || text.startsWith('\x1b[D')) cancelAuth();
  };

  if (interactiveCancel) {
    previousRawMode = Boolean(process.stdin.isRaw);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onCancelKey);
    process.stdout.write('\x1b[?25l');
  }

  try {
    if (!quiet) {
      printCliRows(
        '飞书授权登录',
        [
        ['状态', `正在连接 ${BRAND.authProviderName} 授权服务`, 'warn'],
        ['服务', config.baseUrl, 'info'],
        ],
        '如果这里超过 30 秒，说明授权服务不可达或网络被拦截；Esc/Ctrl+C 可取消。'
      );
    }

    const session = await startDeviceAuthSession(config);
    if (abortController.signal.aborted) throw abortController.signal.reason;
    const loginUrl = session.authorizationUrl;
    const browser = await openExternalUrl(loginUrl);

    if (!quiet) {
      printCliRows(
        '飞书授权登录',
        [
          [
            '状态',
            browser.skipped
              ? '请复制下面的地址到浏览器完成飞书授权'
              : '已打开浏览器，等待飞书授权确认',
          ],
        ['安全', `CLI 只保存 ${BRAND.authProviderName} 授权状态`],
        ],
        '浏览器完成授权后，CLI 会自动继续；Esc/Ctrl+C 可取消。'
      );
      // Print the full URL on its own line(s). The status panel truncates long
      // values, so the URL must be emitted directly to stay visible + copyable.
      console.log('');
      console.log('授权地址（若浏览器未自动打开，复制此行到浏览器）：');
      console.log(loginUrl);
    }

    const tokenPayload = await pollDeviceAuthToken(config, session, {
      signal: abortController.signal,
    });
    const account =
      normalizeHermitAuthIdentity(tokenPayload.identity) || tokenPayload.account || null;
    const store = buildAuthStoreFromToken(config, tokenPayload, account);
    writeOpenHermitAuthStore(store);
    return authStatusFromStore(store);
  } finally {
    if (interactiveCancel) {
      process.stdin.off('data', onCancelKey);
      process.stdin.setRawMode(previousRawMode);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');
    }
  }
}

async function performOpenHermitLogin(options = {}) {
  if (!options.controlUrl && hasRawOAuthConfig()) return performRawOAuthLogin(options);
  return performDeviceAuthLogin(options);
}

async function refreshExpiredOpenHermitToken(store) {
  const refreshToken = store?.token?.refreshToken;
  if (!refreshToken || !store?.issuer) return store;
  try {
    const config = getDeviceAuthConfig({ controlUrl: store.issuer });
    const res = await fetch(config.refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) return store;
    const tokenPatch = normalizeAccessTokenPayload(payload);
    if (!tokenPatch) return store;
    const account =
      normalizeHermitAuthIdentity(payload?.identity) ||
      normalizeHermitAuthIdentity(payload?.account) ||
      normalizeHermitAuthIdentity(payload?.user) ||
      payload?.account ||
      store.account ||
      null;
    const refreshedStore = {
      ...store,
      clientId: store.clientId || config.clientId,
      account,
      token: mergeAuthToken(store.token, tokenPatch),
      updatedAt: new Date().toISOString(),
    };
    writeOpenHermitAuthStore(refreshedStore);
    return refreshedStore;
  } catch {
    // Refresh is best-effort. Keep the local store private and unchanged on network failures.
    return store;
  }
}

async function refreshOpenHermitAuthStatus() {
  const { store: initialStore } = readOpenHermitAuthStore();
  let store = initialStore;
  if (isAuthTokenExpired(store)) store = await refreshExpiredOpenHermitToken(store);
  let accessToken = store?.token?.accessToken;
  if (!accessToken || !store?.issuer) return readOpenHermitAuthStatus();
  try {
    const config = getDeviceAuthConfig({ controlUrl: store.issuer });
    let res = await fetch(config.meUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    let payload = await res.json().catch(() => null);

    // Any signal that the access token is bad — HTTP 401/403, or a 200 body
    // flagging expiry — refreshes once and retries /me. This is the "本地 token
    // 一定要及时刷新" contract: a server rejection must not leave the local store
    // showing 已登录. 5xx / network errors are transient and keep the local token.
    const accessRejected = res.status === 401 || res.status === 403;
    const bodyFlaggedExpiry =
      res.ok && (payload?.access_expired === true || payload?.status === 'access_expired');
    if ((accessRejected || bodyFlaggedExpiry) && store?.token?.refreshToken) {
      store = await refreshExpiredOpenHermitToken({
        ...store,
        token: { ...store.token, expiresAt: '2000-01-01T00:00:00.000Z' },
      });
      accessToken = store?.token?.accessToken;
      if (accessToken) {
        res = await fetch(config.meUrl, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        payload = await res.json().catch(() => null);
      }
    } else if (accessRejected || bodyFlaggedExpiry) {
      // No refresh token: the token is dead and unrecoverable.  Mark it expired
      // immediately so `auth status` stops showing 已登录.  No point retrying /me —
      // it will keep returning access_expired forever.
      writeOpenHermitAuthStore({
        ...store,
        token: { ...store.token, expiresAt: '2000-01-01T00:00:00.000Z' },
        updatedAt: new Date().toISOString(),
        lastMeStatus: payload?.status || (accessRejected ? 'unauthenticated' : 'access_expired'),
      });
      return readOpenHermitAuthStatus();
    }

    // Persistent rejection after a refresh attempt = the token is truly dead
    // (revoked / refresh token expired). Expire it locally so `auth status` stops
    // reporting 已登录 after a server-side logout. Transient 5xx / network errors
    // fall through to the local-status return below unchanged.
    const retryBodyFlaggedExpiry =
      res.ok && (payload?.access_expired === true || payload?.status === 'access_expired');
    if (res.status === 401 || res.status === 403 || retryBodyFlaggedExpiry) {
      writeOpenHermitAuthStore({
        ...store,
        token: { ...store.token, expiresAt: '2000-01-01T00:00:00.000Z' },
        updatedAt: new Date().toISOString(),
        lastMeStatus:
          payload?.status || (retryBodyFlaggedExpiry ? 'access_expired' : 'unauthenticated'),
      });
      return readOpenHermitAuthStatus();
    }
    if (!res.ok) return readOpenHermitAuthStatus();
    const responseScopes = normalizeScopes(payload);
    if (
      payload?.authenticated === false ||
      payload?.refresh_expired === true ||
      payload?.revoked_at
    ) {
      writeOpenHermitAuthStore({
        ...store,
        token: {
          ...store.token,
          expiresAt: '2000-01-01T00:00:00.000Z',
        },
        updatedAt: new Date().toISOString(),
        lastMeStatus: payload?.status || 'unauthenticated',
      });
      return readOpenHermitAuthStatus();
    }
    const account =
      normalizeHermitAuthIdentity(payload?.identity) ||
      normalizeHermitAuthIdentity(payload?.account) ||
      normalizeHermitAuthIdentity(payload?.user) ||
      payload?.account ||
      store.account ||
      null;
    const nextExpiresAt = resolveAccessTokenExpiry(payload, store.token?.expiresAt);
    writeOpenHermitAuthStore({
      ...store,
      account,
      token: {
        ...store.token,
        scope:
          typeof payload?.scope === 'string'
            ? payload.scope
            : responseScopes?.join(' ') || store.token?.scope,
        scopes: responseScopes || store.token?.scopes || null,
        expiresAt: nextExpiresAt,
      },
      updatedAt: new Date().toISOString(),
      lastMeStatus: payload?.status || 'ok',
      lastMeAuthenticatedAt: new Date().toISOString(),
    });
  } catch {
    // Broker ping is best-effort. Keep the local token state if the service is unreachable.
  }
  return readOpenHermitAuthStatus();
}

function authStatusPayload(command = 'auth status') {
  return { ok: true, command, hermitHome, auth: readOpenHermitAuthStatus() };
}

function failAuthRequired(command) {
  const result = {
    ok: false,
    command,
    error: `${BRAND.stylizedName} login required`,
    auth: readOpenHermitAuthStatus(),
  };
  if (jsonRequested) printJson(result, 1);
  console.error(`${brandLogPrefix()} 请先登录：${brandCommand('auth login')}`);
  console.error(
    `${brandLogPrefix()} 本地数字员工工作台、Usage 采集和团队协作可免登录；云端授权、托管服务或显式上传需要 ${BRAND.authAccountLabel}。`
  );
  process.exit(1);
}

function requireOpenHermitAuthForCommand(command) {
  if (!readOpenHermitAuthStatus().authorized) failAuthRequired(command);
}

function isAuthCommandAllowedWithoutLogin() {
  if (commandArgs[0] !== 'auth') return false;
  return ['login', 'status', 'logout', 'dev-login'].includes(commandArgs[1]);
}

function isLocalCommandAllowedWithoutLogin() {
  // Local lifecycle commands (self-update, restart, init, web server) never
  // need cloud auth — they only touch this machine. Per the login-free policy
  // for local surfaces. ('lark-credentials' removed: command deleted.)
  if (
    ['status', 'doctor', 'services', 'stop', 'update', 'restart', 'init', 'web'].includes(
      commandArgs[0]
    )
  )
    return true;
  if (commandArgs[0] === 'usage')
    return ['status', 'today', 'report', 'start', 'stop', 'autostart'].includes(commandArgs[1]);
  if (commandArgs[0] === 'collaboration' && commandArgs[1] === 'start') return true;
  if (commandArgs[0] === 'teams') return ['list', 'create'].includes(commandArgs[1]);
  if (commandArgs[0] === 'tasks')
    return ['list', 'create', 'claim', 'comment', 'clarify', 'complete'].includes(commandArgs[1]);
  return false;
}

async function requireOpenHermitAuthForEntry() {
  if (
    commandArgs.length === 0 ||
    isAuthCommandAllowedWithoutLogin() ||
    isLocalCommandAllowedWithoutLogin()
  )
    return;
  if (commandArgs[0] === 'auth') return;
  if (commandArgs[0] === '__telemetry-worker') return;
  if (readOpenHermitAuthStatus().authorized) return;

  const isInteractiveEntry =
    commandArgs.length === 0 && !daemonChild && !daemonRequested && !jsonRequested;
  if (isInteractiveEntry) {
    const login = await runAuthLogin({ exitOnDone: false, interactiveMenu: true, quiet: false });
    if (login?.auth?.authorized || readOpenHermitAuthStatus().authorized) return;
  }

  failAuthRequired(commandArgs.join(' ') || 'openhermit');
}

function parseAuthLoginOptions() {
  const index = args.indexOf('--control-url');
  if (index === -1) return { controlUrl: null };
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error('Missing required value for --control-url');
  }
  return { controlUrl: normalizeControlUrl(value) };
}

function buildDevAuthStore() {
  const now = new Date().toISOString();
  return {
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    provider: 'openhermit-dev',
    developerMode: true,
    debugLogging: true,
    issuer: 'local-dev-unlock',
    clientId: 'openhermit-cli-dev',
    account: {
      id: 'local-dev-unlock',
      email: 'dev@openhermit.local',
      name: `${BRAND.stylizedName} Dev Unlock`,
    },
    token: {
      accessToken: `dev-unlock-${crypto.randomBytes(16).toString('hex')}`,
      refreshToken: null,
      tokenType: 'Bearer',
      scope: 'auth:user.id:read upload:read upload:write dev:local',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function promptDevUnlockCode() {
  const wasRaw = Boolean(process.stdin.isRaw);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.resume();
  const rl = createPromptInterface();
  try {
    return await askRequired(rl, '开发口令');
  } finally {
    rl.close();
    if (process.stdin.isTTY && wasRaw) process.stdin.setRawMode(true);
  }
}

async function runAuthDevLogin({ exitOnDone = true, requireCode = true, quiet = false } = {}) {
  let code = commandArgs[2] || '';
  if (requireCode && !code && isInteractiveCli() && !jsonRequested) {
    code = await promptDevUnlockCode();
  }
  if (!isSourceCheckout()) {
    const result = {
      ok: false,
      command: 'auth dev-login',
      hermitHome,
      error: 'dev-login is only available from a source checkout',
    };
    if (jsonRequested) printJson(result, 1);
    console.error(`${brandLogPrefix()} dev-login 仅允许源码开发模式使用。`);
    if (exitOnDone) process.exit(1);
    return result;
  }
  if (requireCode && (!DEV_AUTH_UNLOCK_CODE || code !== DEV_AUTH_UNLOCK_CODE)) {
    const result = {
      ok: false,
      command: 'auth dev-login',
      hermitHome,
      error: 'Invalid dev unlock code',
    };
    if (jsonRequested) printJson(result, 1);
    console.error(`${brandLogPrefix()} 开发解锁口令无效。`);
    if (exitOnDone) process.exit(1);
    return result;
  }
  const store = buildDevAuthStore();
  writeOpenHermitAuthStore(store);
  const auth = authStatusFromStore(store);
  const result = { ok: true, command: 'auth dev-login', hermitHome, auth };
  if (!quiet && jsonRequested) printJson(result);
  if (!quiet) {
    printCliRows(
      '开发模式已解锁',
      [
      ['账号', auth.account?.email || auth.account?.id || 'local dev'],
      ['有效期', auth.expiresAt || '本地会话'],
      ['调试日志', '开启'],
      ['Web 日志', daemonLogPath],
      ['同步日志', telemetryWorkerLogPath],
      ['范围', '仅源码 checkout，本地调试使用'],
      ],
      `退出开发登录可运行：${brandCommand('auth logout')}`
    );
  }
  if (exitOnDone) process.exit(0);
  return result;
}

async function printAuthStatus({ exitOnDone = true } = {}) {
  await refreshOpenHermitAuthStatus();
  const result = authStatusPayload();
  if (jsonRequested) printJson(result);
  if (result.auth.authorized) {
    const accountInfo = result.auth.account || {};
    const account =
      accountInfo.email ||
      accountInfo.name ||
      accountInfo.id ||
      `${BRAND.authProviderName} account`;
    const rows = [
      ['状态', '已登录'],
      ['账号', account],
    ];
    if (accountInfo.department || accountInfo.departmentPath)
      rows.push(['部门', accountInfo.departmentPath || accountInfo.department]);
    if (accountInfo.tenantName || accountInfo.tenantKey)
      rows.push(['租户', accountInfo.tenantName || accountInfo.tenantKey]);
    if (accountInfo.email && accountInfo.email !== account) rows.push(['邮箱', accountInfo.email]);
    if (accountInfo.userId) rows.push(['User ID', accountInfo.userId]);
    if (accountInfo.openId) rows.push(['Open ID', accountInfo.openId]);
    if (accountInfo.unionId) rows.push(['Union ID', accountInfo.unionId]);
    rows.push(['授权', `${BRAND.authProviderName} 飞书授权已确认，云端授权和托管服务可用`]);
    printCliRows(BRAND.authAccountLabel, rows, `退出登录可运行：${brandCommand('auth logout')}`);
  } else {
    printCliRows(
      BRAND.authAccountLabel,
      [
      ['状态', '未登录'],
        [
          '影响',
          `本地使用和本地 usage 统计无需登录；云端授权、托管服务和显式上传需要 ${BRAND.authProviderName} 飞书授权`,
        ],
      ],
      `需要云端/上传能力时运行：${brandCommand('auth login')}`
    );
  }
  if (result.auth.warning)
    console.error(`${brandLogPrefix()} Auth store warning: ${result.auth.warning}`);
  if (exitOnDone) process.exit(0);
  return result;
}

async function runAuthLogout({ exitOnDone = true } = {}) {
  const { store } = readOpenHermitAuthStore();
  const accessToken = store?.token?.accessToken;
  if (accessToken && store?.issuer) {
    try {
      const config = getDeviceAuthConfig({ controlUrl: store.issuer });
      await fetch(config.logoutUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Local logout should still clear the token if the broker is unreachable.
    }
  }
  deleteOpenHermitAuthStore();
  const result = { ok: true, command: 'auth logout', hermitHome };
  if (jsonRequested) printJson(result);
  console.log(
    `${brandLogPrefix()} 已退出 ${BRAND.authAccountLabel}；再次进入菜单、Web、Usage 采集或团队协作前需要重新登录。`
  );
  if (exitOnDone) process.exit(0);
  return result;
}

async function runAuthLogin({
  exitOnDone = true,
  interactiveMenu = false,
  quiet = jsonRequested,
} = {}) {
  try {
    const loginOptions = parseAuthLoginOptions();
    const auth = await performOpenHermitLogin({ quiet, ...loginOptions });
    const result = { ok: true, command: 'auth login', hermitHome, auth };
    if (jsonRequested) printJson(result);
    printCliRows(
      '登录成功',
      [
        [
          '账号',
          auth.account?.email ||
            auth.account?.name ||
            auth.account?.id ||
            `${BRAND.authProviderName} account`,
        ],
      ['授权', `飞书授权已通过 ${BRAND.authProviderName} 确认，云端授权和托管服务已可用`],
        [
          '安全',
          `CLI 只保存 ${BRAND.authProviderName} 授权状态，不会保存飞书 app secret、飞书 token 或 Claude Code 凭证`,
        ],
      ],
      `继续运行 ${BRAND.cliCommand} 进入终端导航。`
    );
    if (exitOnDone) process.exit(0);
    return result;
  } catch (err) {
    rethrowIfExitSentinel(err);
    const message = err instanceof Error ? err.message : String(err);
    const result = { ok: false, command: 'auth login', hermitHome, error: message };
    if (jsonRequested) printJson(result, 1);
    printCliRows(
      '登录失败',
      [
      ['原因', message],
      ['默认', `通过 ${BRAND.authProviderName} 打开飞书授权，可用 --control-url 指定控制台地址`],
      ['协议', '/api/v1/auth/start + poll'],
      ['安全', 'CLI 不保存飞书 app secret、飞书 token 或 Claude Code 凭证，也不会打印 token'],
      ],
      '请确认授权服务已按最新 AgentCLI API 返回 flow_id / poll_secret / authorization_url。'
    );
    if (exitOnDone && !interactiveMenu) process.exit(1);
    return result;
  }
}

export {
getAuthStorePath,
ensureAuthStoreDir,
normalizeExpiry,
readOpenHermitAuthStore,
isAuthTokenExpired,
authStatusFromStore,
normalizeScopes,
normalizeAccessTokenPayload,
mergeAuthToken,
readOpenHermitAuthStatus,
writeOpenHermitAuthStore,
deleteOpenHermitAuthStore,
getOAuthConfig,
hasRawOAuthConfig,
normalizeControlUrl,
resolveConversationUploadBaseUrl,
isSourceCheckout,
getDefaultDeviceAuthBaseUrl,
getDeviceAuthConfig,
assertOAuthConfigured,
base64Url,
randomOAuthValue,
buildCodeChallenge,
buildAuthorizationUrl,
openExternalUrl,
escapeHtml,
buildAuthCallbackHtml,
startOAuthCallbackServer,
exchangeAuthorizationCode,
fetchOAuthUserInfo,
buildAuthStoreFromToken,
performRawOAuthLogin,
startDeviceAuthSession,
normalizeHermitAuthIdentity,
waitForAuthPollInterval,
pollDeviceAuthToken,
performDeviceAuthLogin,
performOpenHermitLogin,
refreshExpiredOpenHermitToken,
refreshOpenHermitAuthStatus,
authStatusPayload,
failAuthRequired,
requireOpenHermitAuthForCommand,
isAuthCommandAllowedWithoutLogin,
isLocalCommandAllowedWithoutLogin,
requireOpenHermitAuthForEntry,
parseAuthLoginOptions,
buildDevAuthStore,
promptDevUnlockCode,
runAuthDevLogin,
printAuthStatus,
runAuthLogout,
runAuthLogin,
AUTH_CALLBACK_PATH,
AUTH_STORE_SCHEMA_VERSION,
DEFAULT_OPENHERMIT_CLOUD_BASE_URL,
OPENHERMIT_AUTH_BROKER_URL,
OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL,
DEV_AUTH_UNLOCK_CODE,
resolveAuthedServerContext,
};
