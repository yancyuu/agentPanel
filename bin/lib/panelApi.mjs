// panelApi.mjs — authenticated loopback client for CLI commands backed by the
// local AgentPanel Workbench. It intentionally never falls back to mutating
// ~/.hermit files directly: the Workbench API is the source of truth.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { args, port } from './env.mjs';

function unwrapApiResponse(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload) return payload.data;
  return payload;
}

export function readDesktopRuntimeMetadata({ env = process.env, readFile = readFileSync } = {}) {
  try {
    const hermitHome = env.HERMIT_HOME || path.join(homedir(), '.hermit');
    const parsed = JSON.parse(readFile(path.join(hermitHome, 'desktop-runtime.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function resolvePanelBaseUrl({
  cliArgs = args,
  defaultPort = port,
  env = process.env,
  metadata = readDesktopRuntimeMetadata({ env }),
} = {}) {
  if (cliArgs.includes('--port')) return `http://127.0.0.1:${defaultPort}`;
  if (env.HERMIT_WORKBENCH_URL) return String(env.HERMIT_WORKBENCH_URL).replace(/\/$/u, '');
  return String(metadata?.origin || `http://127.0.0.1:${defaultPort}`).replace(/\/$/u, '');
}

export function createPanelApiClient({
  baseUrl = resolvePanelBaseUrl(),
  sessionToken = process.env.AGENTPANEL_DESKTOP_SESSION_TOKEN ||
    readDesktopRuntimeMetadata()?.sessionToken,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  const normalizedBaseUrl = String(baseUrl).replace(/\/$/u, '');

  const requestResponse = async (pathname, { method = 'GET', body } = {}) => {
    const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
    if (sessionToken) headers['x-agentpanel-desktop-token'] = String(sessionToken);
    try {
      return await fetchImpl(`${normalizedBaseUrl}${pathname}`, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `AgentPanel 工作台未启动或不可达（${normalizedBaseUrl}）：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  return {
    baseUrl: normalizedBaseUrl,
    async request(pathname, options) {
      const response = await requestResponse(pathname, options);
      const text = await response.text();
      let payload = {};
      if (text.trim()) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error(`AgentPanel 工作台返回了无效响应（HTTP ${response.status}）`);
        }
      }
      const result = unwrapApiResponse(payload);
      if (!response.ok || result?.ok === false) {
        throw new Error(result?.error || payload?.error || `HTTP ${response.status}`);
      }
      return result;
    },
    async requestBinary(pathname, options) {
      const response = await requestResponse(pathname, options);
      if (!response.ok) {
        const text = await response.text();
        try {
          const payload = JSON.parse(text);
          throw new Error(
            unwrapApiResponse(payload)?.error || payload?.error || `HTTP ${response.status}`
          );
        } catch (error) {
          if (error instanceof Error && error.message !== text) throw error;
          throw new Error(`HTTP ${response.status}`);
        }
      }
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
