#!/usr/bin/env node
import crypto from 'node:crypto';
import { createServer } from 'node:http';

const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const codes = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function buildCodeChallenge(verifier) {
  return base64Url(crypto.createHash('sha256').update(verifier).digest());
}

async function readForm(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

function buildEnvCommand(origin) {
  return [
    `OPENHERMIT_OAUTH_AUTHORIZE_URL="${origin}/oauth/authorize" \\`,
    `OPENHERMIT_OAUTH_TOKEN_URL="${origin}/oauth/token" \\`,
    `OPENHERMIT_OAUTH_USERINFO_URL="${origin}/oauth/userinfo" \\`,
    'OPENHERMIT_OAUTH_CLIENT_ID="openhermit-cli" \\',
    'OPENHERMIT_OAUTH_OPEN_BROWSER=fetch \\',
    'openhermit auth login',
  ].join('\n');
}

const server = createServer(async (req, res) => {
  const origin = `http://${host}:${port}`;
  const url = new URL(req.url || '/', origin);

  if (req.method === 'GET' && url.pathname === '/') {
    sendText(res, 200, `openHermit OAuth debug server is running.\n\nRun:\n${buildEnvCommand(origin)}\n`);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') || '';
    const clientId = url.searchParams.get('client_id') || '';
    const codeChallenge = url.searchParams.get('code_challenge') || '';
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') || '';

    if (!redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
      sendJson(res, 400, { error: 'invalid_request', message: 'redirect_uri and PKCE S256 are required' });
      return;
    }

    const code = crypto.randomBytes(24).toString('hex');
    codes.set(code, {
      clientId,
      codeChallenge,
      redirectUri,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', state);
    res.writeHead(302, { Location: callback.toString() });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    const form = await readForm(req);
    const code = form.get('code') || '';
    const verifier = form.get('code_verifier') || '';
    const redirectUri = form.get('redirect_uri') || '';
    const clientId = form.get('client_id') || '';
    const grantType = form.get('grant_type') || '';
    const record = codes.get(code);

    if (grantType !== 'authorization_code' || !record) {
      sendJson(res, 400, { error: 'invalid_grant' });
      return;
    }
    if (Date.now() > record.expiresAt) {
      codes.delete(code);
      sendJson(res, 400, { error: 'expired_code' });
      return;
    }
    if (record.redirectUri !== redirectUri || record.clientId !== clientId) {
      sendJson(res, 400, { error: 'invalid_client_or_redirect_uri' });
      return;
    }
    if (buildCodeChallenge(verifier) !== record.codeChallenge) {
      sendJson(res, 400, { error: 'invalid_pkce' });
      return;
    }

    codes.delete(code);
    sendJson(res, 200, {
      access_token: `debug-access-${crypto.randomBytes(12).toString('hex')}`,
      refresh_token: `debug-refresh-${crypto.randomBytes(12).toString('hex')}`,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid profile email usage:write',
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/oauth/userinfo') {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer debug-access-')) {
      sendJson(res, 401, { error: 'invalid_token' });
      return;
    }
    sendJson(res, 200, {
      sub: 'debug-user-001',
      email: 'debug-user@openhermit.local',
      name: 'openHermit Debug User',
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
});

server.listen(port, host, () => {
  const origin = `http://${host}:${port}`;
  console.log(`openHermit OAuth debug server: ${origin}`);
  console.log('');
  console.log('Run this in another terminal:');
  console.log(buildEnvCommand(origin));
});
