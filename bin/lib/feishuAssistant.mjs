// feishuAssistant.mjs — create a Feishu personal assistant project via cc-connect.
//
// Bridges the CLI layer (hermit.mjs) to cc-connect's `create feishu-assistant`
// subcommand. cc-connect is the bundled optionalDependency that ships the channel
// binding runtime. This module follows the same conventions as the other bin/lib CLI helpers:
// no import-time side effects, structured results, never throws.
//
// Usage in hermit.mjs:
//
//   hermit create-feishu-assistant --name <name> [--ai-key <key>] [--description <desc>]
//
// Workflow:
//   1. Resolve the cc-connect binary (bundled package or global PATH).
//   2. Spawn `cc-connect create feishu-assistant --name <name> [--ai-key …] [--description …]`.
//   3. cc-connect creates a project with a Feishu engine + embedded AI credentials,
//      writes ~/.hermit/teams/<name>/manifest.json, and prints the team slug on success.
//   4. Return the parsed result (ok, teamSlug, message, detail) to the caller.
//
// cc-connect must be installed and its management API reachable. If the API is down
// the command will fail with a clear error.
//
// The Feishu personal assistant uses a Claude Code engine with a single-user Feishu bot
// that sends/receives in personal 1:1 chats. The user provides their own Feishu app
// credentials (App ID + App Secret) via environment variables or the --app-id / --app-secret
// flags; cc-connect stores them in its per-project config.
//
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PACKAGE_NAME = 'cc-connect';
const BINARY = process.platform === 'win32' ? 'cc-connect.exe' : 'cc-connect';

function resolvePackageLauncher() {
  for (const subpath of ['run.js', `bin/${BINARY}`]) {
    try {
      const entry = require.resolve(`${PACKAGE_NAME}/${subpath}`);
      return { cmd: process.execPath, args: [entry], displayPath: entry, via: PACKAGE_NAME };
    } catch {
      // Try the next known package entry.
    }
  }
  return null;
}

/**
 * Resolve how to invoke cc-connect. Prefers the bundled optionalDependency
 * (shipped with AgentCLI), falls back to a global `cc-connect` on PATH.
 * Returns {cmd, args, displayPath, via} or null when not found.
 */
function resolveCcConnectLauncher() {
  const launcher = resolvePackageLauncher();
  if (launcher) return launcher;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, [BINARY], { encoding: 'utf-8' });
    const found = (r.stdout || '').split(/\r?\n/)[0]?.trim();
    if (found) return { cmd: found, args: [], displayPath: found, via: 'global' };
  } catch {
    // which/where unavailable.
  }
  return null;
}

function spawnCcConnect(args, opts = {}) {
  const launcher = resolveCcConnectLauncher();
  if (!launcher) return null;
  const spawn = globalThis.__feishuAssistant_test_spawn || spawnSync;
  return spawn(launcher.cmd, [...launcher.args, ...args], {
    encoding: 'utf-8',
    shell: launcher.via === 'global' && process.platform === 'win32',
    windowsHide: true,
    ...opts,
  });
}

function isAlreadyRunningMessage(text) {
  return /another cc-connect instance is already running/i.test(text || '');
}

function compactBridgeResult(r, fallback) {
  if (!r) {
    return {
      ok: false,
      message: `${BINARY} 未安装（运行 pnpm install 或 npm install -g cc-connect 后重试）`,
      detail: 'cc-connect optional dependency not found',
    };
  }
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  return {
    ok: r.status === 0,
    message: stdout || stderr || fallback || `exit ${r.status}`,
    detail: stderr && stdout ? stderr : '',
  };
}

/**
 * Wait for the cc-connect runtime to be reachable through the local AgentCLI
 * server before channel binding. The server owns cc-connect process lifecycle
 * (it launches the sidecar on boot); this only polls the proxied status so the
 * CLI never blocks on a foreground `cc-connect start` process.
 */
export async function ensureCcConnectRuntime(port, { timeoutMs = 60_000, pollMs = 500, fetchImpl } = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const fetchFn = fetchImpl || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
  if (typeof fetchFn !== 'function') {
    return { ok: false, message: '渠道连接服务未就绪：当前环境不支持 fetch', detail: 'fetch unavailable' };
  }
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetchFn(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const payload = await res.json().catch(() => ({}));
        if (payload?.ok !== false) return { ok: true, message: '渠道连接已就绪' };
        lastError = payload?.error || 'runtime status unavailable';
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return {
    ok: false,
    message: '渠道连接服务未就绪，请确认本地工作台已启动并已加载 cc-connect',
    detail: lastError || 'runtime readiness timeout',
  };
}

/**
 * Parse the structured output line cc-connect prints on success.
 * Looks for a trailing JSON blob like {ok:true,teamSlug:"…"} or {ok:false,error:"…"}
 * appended to the human-readable stdout. Falls back to treating stdout as the message.
 */
function parseHermitBridgeOutput(stdout, stderr) {
  const raw = (stdout || '').trim();
  const lines = raw.split('\n');
  // Scan from the end for a JSON object line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
      } catch {
        // Not JSON — keep scanning.
      }
    }
  }
  // No structured output found; treat stdout as message.
  return { ok: true, message: raw || (stderr || '').trim() || '命令执行完成' };
}

/**
 * Result shape returned by all public functions in this module.
 * @typedef {{ ok: boolean; alreadyExists?: boolean; teamSlug?: string; message: string; detail?: string }} CreateFeishuAssistantResult
 */

/**
 * Check whether cc-connect is available (bundled or on PATH).
 * @returns {boolean}
 */
export function isHermitBridgeInstalled() {
  return resolveCcConnectLauncher() !== null;
}

/**
 * Create a new Feishu personal assistant project via cc-connect.
 *
 * @param {object} opts
 * @param {string} opts.name          - Unique project / team name (slug-safe, will be normalized).
 * @param {string} [opts.aiKey]       - API key for the embedded Claude engine (sk-… or ANTHROPIC_API_KEY value).
 * @param {string} [opts.description] - Human-readable description shown in the UI.
 * @param {string} [opts.appId]       - Feishu App ID (optional; cc-connect may prompt or use env).
 * @param {string} [opts.appSecret]   - Feishu App Secret (optional; cc-connect may prompt or use env).
 * @returns {CreateFeishuAssistantResult}
 */
export function createFeishuAssistant({ name, aiKey, description, appId, appSecret } = {}) {
  if (!name || !name.trim()) {
    return { ok: false, message: '缺少项目名称（--name <名称>）' };
  }

  const args = ['create', 'feishu-assistant', '--name', name.trim()];
  if (aiKey) args.push('--ai-key', aiKey);
  if (description) args.push('--description', description);
  if (appId) args.push('--app-id', appId);
  if (appSecret) args.push('--app-secret', appSecret);

  const r = spawnCcConnect(args);
  if (!r) {
    return compactBridgeResult(r);
  }

  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  const parsed = parseHermitBridgeOutput(stdout, stderr);

  if (r.status === 0 || parsed.ok) {
    return {
      ok: true,
      alreadyExists: parsed.alreadyExists ?? false,
      teamSlug: parsed.teamSlug ?? name.trim(),
      message: parsed.message || stdout || '飞书个人助理已创建',
      detail: parsed.detail ?? '',
    };
  }

  // Non-zero exit: surface the error clearly.
  const errorText = parsed.error || stderr || stdout || `exit ${r.status}`;
  return {
    ok: false,
    message: `创建失败：${errorText}`,
    detail: stdout,
  };
}

/**
 * List all Feishu-assistant projects known to cc-connect.
 * Spawns `cc-connect list feishu-assistants` and returns the parsed JSON array.
 *
 * @returns {{ ok: boolean; projects: Array<{name: string; teamSlug: string; status: string}>; message: string }}
 */
export function listFeishuAssistants() {
  const r = spawnCcConnect(['list', 'feishu-assistants', '--json']);
  if (!r) {
    return { ok: false, projects: [], message: compactBridgeResult(r).message };
  }

  if (r.status !== 0) {
    return { ok: false, projects: [], message: (r.stderr || r.stdout || '').trim() || `exit ${r.status}` };
  }

  try {
    const parsed = JSON.parse((r.stdout || '').trim());
    return { ok: true, projects: Array.isArray(parsed) ? parsed : [], message: '' };
  } catch {
    return { ok: false, projects: [], message: '无法解析 cc-connect 输出' };
  }
}
