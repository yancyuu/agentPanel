// update.mjs — `update` (self-update via git tag or npm) and `add <plugin>`
// (register a feature plugin into the MCP library) commands.

import { execSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

import { currentVersion as defaultCurrentVersion, repoRoot as defaultRepoRoot } from './env.mjs';
import { BRAND, brandCommand, brandLogPrefix } from '../branding.mjs';
import { rethrowIfExitSentinel } from './exitGuard.mjs';

/**
 * Resolve the latest published version from npm's official registry. This is the
 * same source that the global-install update path uses, so `agentpanel update`
 * remains available when GitHub Releases/API is blocked by a network or proxy.
 */
async function fetchLatestRelease(fetchImpl) {
  const res = await fetchImpl(
    `https://registry.npmjs.org/${encodeURIComponent(BRAND.npmPackage)}/latest`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Failed to check npm registry (HTTP ${res.status})`);
  const data = await res.json();
  const latestVersion = String(data?.version || '').trim();
  if (!latestVersion) throw new Error('No latest version found in npm registry');
  return latestVersion;
}

/**
 * Self-update. Emits the Claude-CLI-style transcript:
 *   Current version: <v>
 *   Checking for updates to latest version...
 *   New version available: <v> (current: <v>)   ← only when an update exists
 *   Installing update...
 *   Using <git|global> installation update method...
 *   Successfully updated from <old> to version <new>
 *
 * Every side-effecting dependency (fetch, exec, migration, output, version,
 * install method) is injectable so the transcript can be unit-tested without
 * network or subprocesses. Production callers pass only `onUpdated`.
 */
function failUpdate(error, printError) {
  printError(
    `${brandLogPrefix()} Update failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
  throw error;
}

function installGitUpdate(exec, repoRoot, latestVersion, log, printError) {
  log('Using git installation update method...');
  try {
    exec('git fetch --tags', { cwd: repoRoot, stdio: 'inherit' });
    exec(`git checkout v${latestVersion}`, { cwd: repoRoot, stdio: 'inherit' });
    exec('npm install', { cwd: repoRoot, stdio: 'inherit' });
    exec('npm run build:web', { cwd: repoRoot, stdio: 'inherit' });
  } catch (error) {
    failUpdate(error, printError);
  }
}

function installGlobalUpdate(exec, log, printError) {
  log('Using global installation update method...');
  try {
    exec(`npm install -g ${BRAND.npmPackage}@latest --registry=https://registry.npmjs.org/`, {
      stdio: 'inherit',
    });
  } catch (error) {
    const hint =
      process.platform === 'win32'
        ? `先关闭所有运行中的 agentpanel 进程（或重启电脑）再重试：npm install -g ${BRAND.npmPackage}@latest --prefer-online`
        : `Try: sudo npm install -g ${BRAND.npmPackage}@latest`;
    printError(`${brandLogPrefix()} npm update failed. ${hint}`);
    process.exit(1);
    throw error;
  }
}

async function runUpdate({
  onUpdated,
  currentVersion = defaultCurrentVersion,
  repoRoot = defaultRepoRoot,
  isGitRepo = existsSync(path.join(defaultRepoRoot, '.git')),
  fetchImpl = fetch,
  exec = execSync,
  migrate = () => undefined,
  log = (msg) => console.log(msg),
  error = (msg) => console.error(msg),
} = {}) {
  log(`Current version: ${currentVersion}`);
  log('Checking for updates to latest version...');

  let latestVersion;
  try {
    latestVersion = await fetchLatestRelease(fetchImpl);
  } catch (cause) {
    failUpdate(cause, error);
  }

  if (latestVersion === currentVersion) {
    migrate();
    log(`Already on latest version (${currentVersion})`);
    return;
  }

  log(`New version available: ${latestVersion} (current: ${currentVersion})`);
  log('Installing update...');
  if (isGitRepo) installGitUpdate(exec, repoRoot, latestVersion, log, error);
  else installGlobalUpdate(exec, log, error);

  migrate();
  await onUpdated?.();
  log(`Successfully updated from ${currentVersion} to version ${latestVersion}`);
  log(`请运行 ${brandCommand('restart')}，以重启本地工作台并加载新版本。`);
}

// ---------------------------------------------------------------------------
// add <plugin> - install a feature plugin into the MCP library
// ---------------------------------------------------------------------------

/**
 * Known installable feature plugins. Each maps a `agentpanel add <name>` key to
 * the MCP library entry it registers (pointing at a hermit-served MCP endpoint).
 * Mirrors src/features/worker-society/main/composition/workerSocietyPlugin.ts.
 */
const KNOWN_PLUGINS = {
  'worker-society': {
    name: 'worker-society',
    description:
      '去中心化 worker 自治社会：agent 通过 society_* 工具发布需求、自荐、择优选派、积累声誉与关系，替代中心化派单。',
    endpoint: '/mcp',
    transport: 'sse',
    hint: 'society_* tools (publish need / volunteer / auto-select …)',
  },
};

async function runAddPlugin(pluginName, port) {
  if (!pluginName) {
    console.error(`${brandLogPrefix()} Usage: ${brandCommand('add <plugin-name>')}`);
    console.error(`${brandLogPrefix()} Known plugins: ${Object.keys(KNOWN_PLUGINS).join(', ')}`);
    process.exit(1);
  }

  const spec = KNOWN_PLUGINS[pluginName];
  if (!spec) {
    console.error(`${brandLogPrefix()} Unknown plugin: ${pluginName}`);
    console.error(`${brandLogPrefix()} Known plugins: ${Object.keys(KNOWN_PLUGINS).join(', ')}`);
    process.exit(1);
  }

  const base = `http://127.0.0.1:${port}`;
  const body = {
    name: spec.name,
    description: spec.description,
    installSpec: {
      type: 'http',
      url: `${base}${spec.endpoint}`,
      transportType: spec.transport,
    },
  };

  console.log(
    `${brandLogPrefix()} Installing plugin "${pluginName}" → registering MCP server ${body.installSpec.url}`
  );

  try {
    const res = await fetch(`${base}/api/extensions/mcp/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    // 服务端统一包成 { success, data | error }：HTTP 200 但 success:false 也算失败。
    const text = await res.text().catch(() => '');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 响应，按 HTTP 状态兜底 */
    }
    const ok = res.ok && parsed && parsed.success !== false;
    const errMsg = parsed && typeof parsed.error === 'string' ? parsed.error : '';

    if (ok) {
      console.log(`${brandLogPrefix()} OK "${pluginName}" installed into the MCP library.`);
      console.log(`${brandLogPrefix()}   Agents can now use: ${spec.hint}`);
      console.log(
        `${brandLogPrefix()}   Enable it for a worker in the Extensions panel, or via the MCP library.`
      );
      return;
    }

    // 同名已存在 → 幂等视为已安装。
    if (res.status === 409 || /already exist|已存在|exists/i.test(errMsg)) {
      console.log(
        `${brandLogPrefix()} OK "${pluginName}" already in the MCP library (idempotent).`
      );
      return;
    }
    console.error(
      `${brandLogPrefix()} Install failed (HTTP ${res.status}): ${(errMsg || text).slice(0, 200)}`
    );
    process.exit(1);
  } catch (err) {
    rethrowIfExitSentinel(err);
    console.error(`${brandLogPrefix()} Could not reach ${BRAND.stylizedName} at ${base}.`);
    console.error(`${brandLogPrefix()} ${err instanceof Error ? err.message : String(err)}`);
    console.error(`${brandLogPrefix()} Start it first with: ${brandCommand()}`);
    process.exit(1);
  }
}

export { runUpdate, runAddPlugin };
