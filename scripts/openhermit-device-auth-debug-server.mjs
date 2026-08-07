#!/usr/bin/env node
import crypto from 'node:crypto';
import { createServer } from 'node:http';

const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '3001', 10);
const autoApprove = process.env.OPENHERMIT_AUTH_DEBUG_AUTO_APPROVE === '1';
const feishuAppId = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || '';
const feishuAuthMode = process.env.FEISHU_AUTH_TOKEN_MODE || 'v2';
const sessions = new Map();

function getFeishuAppSecret() {
  return process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || '';
}

function isRealFeishuEnabled() {
  return Boolean(feishuAppId && getFeishuAppSecret());
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    return {};
  }
}

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function buildLoginCommand(origin) {
  return [
    `openhermit auth login --control-url ${origin}`,
    '',
    'Equivalent env form:',
    `OPENHERMIT_AUTH_BASE_URL="${origin}" \\`,
    'openhermit auth login',
    '',
    'Real Feishu debug mode: set FEISHU_APP_ID and FEISHU_APP_SECRET on this server process.',
    'Do not write app secrets into code, tests, docs, or shell history you plan to share.',
    '',
    'For automated mock smoke tests only, restart this server with OPENHERMIT_AUTH_DEBUG_AUTO_APPROVE=1, then run:',
    `OPENHERMIT_AUTH_OPEN_BROWSER=fetch openhermit auth login --control-url ${origin}`,
  ].join('\n');
}

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f8fa; color: #1f2329; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(520px, calc(100vw - 32px)); background: #fff; border: 1px solid #dee0e3; border-radius: 16px; padding: 28px; box-shadow: 0 18px 60px rgb(31 35 41 / 10%); }
    h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.25; }
    p { margin: 10px 0; color: #4e5969; }
    code { background: #f2f3f5; padding: 2px 6px; border-radius: 6px; }
    .row { display: flex; justify-content: space-between; gap: 16px; border-top: 1px solid #eff0f1; padding-top: 12px; margin-top: 12px; }
    .label { color: #86909c; }
    .value { color: #1f2329; font-weight: 600; word-break: break-all; text-align: right; }
    .actions { display: flex; gap: 10px; margin-top: 22px; }
    a, button { appearance: none; border: 0; border-radius: 10px; padding: 10px 14px; background: #1456f0; color: #fff; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
    a.secondary { background: #eff0f1; color: #1f2329; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function encodeFeishuState(session, deviceCode) {
  return `${session.state}.${deviceCode}`;
}

function parseFeishuState(value) {
  const index = String(value || '').lastIndexOf('.');
  if (index === -1) return { state: value || '', deviceCode: '' };
  return {
    state: value.slice(0, index),
    deviceCode: value.slice(index + 1),
  };
}

function buildFeishuAuthorizeUrl(origin, session, deviceCode) {
  const state = encodeFeishuState(session, deviceCode);
  const redirectUri = `${origin}/api/feishu/oauth/callback`;

  if (isRealFeishuEnabled()) {
    const url = new URL(process.env.FEISHU_AUTHORIZE_URL || 'https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    url.searchParams.set('app_id', feishuAppId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    const scope = process.env.FEISHU_OAUTH_SCOPE || '';
    if (scope) url.searchParams.set('scope', scope);
    return url;
  }

  const url = new URL(`${origin}/mock-feishu/oauth/authorize`);
  url.searchParams.set('app_id', 'cli_a_openhermit_debug');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'contact:user.id:readonly offline_access');
  url.searchParams.set('state', state);
  return url;
}

async function getFeishuAppAccessToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
    body: JSON.stringify({ app_id: feishuAppId, app_secret: getFeishuAppSecret() }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readJsonResponse(res);
  const appAccessToken = payload?.app_access_token || payload?.tenant_access_token;
  if (!res.ok || !appAccessToken) throw new Error(`Feishu app_access_token failed (HTTP ${res.status})`);
  return appAccessToken;
}

async function exchangeFeishuCodeV1(code) {
  const appAccessToken = await getFeishuAppAccessToken();
  const res = await fetch('https://open.feishu.cn/open-apis/authen/v1/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      Authorization: `Bearer ${appAccessToken}`,
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readJsonResponse(res);
  if (!res.ok || !payload?.data?.access_token) throw new Error(`Feishu user_access_token v1 failed (HTTP ${res.status})`);
  return payload.data;
}

async function exchangeFeishuCodeV2(code, redirectUri) {
  const res = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: feishuAppId,
      client_secret: getFeishuAppSecret(),
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readJsonResponse(res);
  const data = payload?.data || payload;
  if (!res.ok || !data?.access_token) throw new Error(`Feishu user_access_token v2 failed (HTTP ${res.status})`);
  return data;
}

async function fetchFeishuUserInfo(userAccessToken) {
  if (!userAccessToken) return null;
  const res = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${userAccessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const payload = await readJsonResponse(res);
  return payload?.data || payload || null;
}

function normalizeFeishuAccount(tokenPayload, userInfo) {
  const source = { ...(tokenPayload || {}), ...(userInfo || {}) };
  return {
    id: source.union_id || source.open_id || source.user_id || 'feishu-user',
    openId: source.open_id || null,
    userId: source.user_id || null,
    tenantKey: source.tenant_key || null,
    email: source.email || null,
    name: source.name || source.en_name || source.display_name || 'Feishu User',
  };
}

async function exchangeRealFeishuCode(code, redirectUri) {
  const tokenPayload = feishuAuthMode === 'v1'
    ? await exchangeFeishuCodeV1(code)
    : await exchangeFeishuCodeV2(code, redirectUri);
  const userInfo = await fetchFeishuUserInfo(tokenPayload.access_token).catch(() => null);
  return normalizeFeishuAccount(tokenPayload, userInfo);
}

function mockFeishuAccount() {
  return {
    id: 'debug-feishu-union-id-001',
    openId: 'debug-feishu-open-id-001',
    email: 'debug-feishu@openhermit.local',
    name: '飞书 Debug 用户',
  };
}

const server = createServer(async (req, res) => {
  const origin = `http://${host}:${port}`;
  const url = new URL(req.url || '/', origin);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`openHermit device auth debug server is running.\nMode: ${isRealFeishuEnabled() ? `real Feishu (${feishuAppId})` : 'mock Feishu'}\n\nRun:\n${buildLoginCommand(origin)}\n`);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/cli-auth/start') {
      await readJson(req);
      const deviceCode = crypto.randomBytes(18).toString('hex');
      const userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      const state = crypto.randomBytes(16).toString('hex');
      sessions.set(deviceCode, {
        approved: false,
        userCode,
        state,
        expiresAt: Date.now() + 10 * 60 * 1000,
        account: null,
      });
      sendJson(res, 200, {
        deviceCode,
        userCode,
        verificationUrl: `${origin}/cli-login`,
        verificationUriComplete: `${origin}/cli-login?code=${userCode}&device=${deviceCode}`,
        expiresIn: 600,
        interval: 1,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/cli-login') {
      const deviceCode = url.searchParams.get('device') || '';
      const userCode = url.searchParams.get('code') || '';
      const session = sessions.get(deviceCode);
      if (!session || session.userCode !== userCode) {
        sendHtml(res, 404, htmlPage('openHermit 登录会话不存在', '<h1>登录会话不存在</h1><p>请回到终端重新运行 <code>openhermit auth login</code>。</p>'));
        return;
      }
      const authorizeUrl = buildFeishuAuthorizeUrl(origin, session, deviceCode);
      if (autoApprove || isRealFeishuEnabled()) {
        res.writeHead(302, { Location: authorizeUrl.toString() });
        res.end();
        return;
      }
      sendHtml(res, 200, htmlPage('openHermit 飞书授权登录', `
        <h1>openHermit 飞书授权登录</h1>
        <p>这是本地 debug broker。点击下面按钮后，会跳转到模拟飞书 OAuth 授权页。</p>
        <div class="row"><span class="label">授权码</span><span class="value">${escapeHtml(session.userCode)}</span></div>
        <div class="row"><span class="label">Device Code</span><span class="value">${escapeHtml(deviceCode)}</span></div>
        <div class="actions"><a href="${escapeHtml(authorizeUrl.toString())}">继续到模拟飞书授权</a></div>
      `));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/mock-feishu/oauth/authorize') {
      const { state, deviceCode } = parseFeishuState(url.searchParams.get('state') || '');
      const session = sessions.get(deviceCode);
      if (!session || session.state !== state) {
        sendHtml(res, 400, htmlPage('飞书授权失败', '<h1>飞书授权失败</h1><p>state 或 device 不匹配。</p>'));
        return;
      }
      const callbackUrl = new URL(url.searchParams.get('redirect_uri') || `${origin}/api/feishu/oauth/callback`);
      callbackUrl.searchParams.set('code', `debug-feishu-code-${crypto.randomBytes(8).toString('hex')}`);
      callbackUrl.searchParams.set('state', encodeFeishuState(session, deviceCode));
      if (autoApprove) {
        res.writeHead(302, { Location: callbackUrl.toString() });
        res.end();
        return;
      }
      sendHtml(res, 200, htmlPage('模拟飞书授权', `
        <h1>模拟飞书授权</h1>
        <p>这是本地模拟的飞书 OAuth 页面，用来验证 openHermit broker 的真实授权跳转和回调链路。</p>
        <div class="row"><span class="label">应用</span><span class="value">openHermit Debug</span></div>
        <div class="row"><span class="label">权限</span><span class="value">读取用户身份 union_id / open_id</span></div>
        <div class="row"><span class="label">回调</span><span class="value">${escapeHtml(`${callbackUrl.origin}${callbackUrl.pathname}`)}</span></div>
        <div class="actions">
          <a href="${escapeHtml(callbackUrl.toString())}">同意授权</a>
          <a class="secondary" href="${origin}/mock-feishu/denied">取消</a>
        </div>
      `));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/feishu/oauth/callback') {
      const { state, deviceCode } = parseFeishuState(url.searchParams.get('state') || '');
      const session = sessions.get(deviceCode);
      const code = url.searchParams.get('code') || '';
      if (!session || session.state !== state || !code) {
        sendHtml(res, 400, htmlPage('openHermit 飞书回调失败', '<h1>openHermit 飞书回调失败</h1><p>授权码或 state 校验失败。</p>'));
        return;
      }
      const redirectUri = `${origin}/api/feishu/oauth/callback`;
      session.account = isRealFeishuEnabled()
        ? await exchangeRealFeishuCode(code, redirectUri)
        : mockFeishuAccount();
      session.approved = true;
      sendHtml(res, 200, htmlPage('openHermit 授权成功', `
        <h1>openHermit 授权成功</h1>
        <p>${isRealFeishuEnabled() ? '真实飞书授权' : '模拟飞书授权'}已回调到 openHermit broker。可以关闭这个页面，回到终端。</p>
        <div class="row"><span class="label">union_id</span><span class="value">${escapeHtml(session.account.id || '')}</span></div>
        <div class="row"><span class="label">open_id</span><span class="value">${escapeHtml(session.account.openId || '')}</span></div>
      `));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/mock-feishu/denied') {
      sendHtml(res, 200, htmlPage('已取消飞书授权', '<h1>已取消飞书授权</h1><p>终端会继续等待，按 Ctrl+C 可取消。</p>'));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/cli-auth/token') {
      const body = await readJson(req);
      const session = sessions.get(body.deviceCode);
      if (!session || Date.now() > session.expiresAt) {
        sendJson(res, 400, { error: 'expired_token' });
        return;
      }
      if (!session.approved) {
        sendJson(res, 428, { error: 'authorization_pending' });
        return;
      }
      sessions.delete(body.deviceCode);
      sendJson(res, 200, {
        accessToken: `debug-openhermit-access-${crypto.randomBytes(12).toString('hex')}`,
        refreshToken: `debug-openhermit-refresh-${crypto.randomBytes(12).toString('hex')}`,
        tokenType: 'Bearer',
        expiresIn: 3600,
        scope: 'openid profile email usage:write',
        account: session.account || mockFeishuAccount(),
      });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendHtml(res, 500, htmlPage('openHermit debug auth failed', `<h1>openHermit debug auth failed</h1><p>${escapeHtml(message)}</p><p>不会输出 Feishu app_secret 或用户 token。</p>`));
  }
});

server.listen(port, host, () => {
  const origin = `http://${host}:${port}`;
  console.log(`openHermit device auth debug server: ${origin}`);
  console.log(`Feishu mode: ${isRealFeishuEnabled() ? `real (${feishuAppId})` : 'mock'}`);
  console.log('Secret loaded:', getFeishuAppSecret() ? 'yes (hidden)' : 'no');
  console.log('Callback URL:', `${origin}/api/feishu/oauth/callback`);
  console.log('');
  console.log('Run this in another terminal for the visible browser flow:');
  console.log(buildLoginCommand(origin));
});
