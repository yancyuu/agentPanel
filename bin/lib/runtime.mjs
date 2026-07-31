// runtime.mjs — cc-connect runtime config (TOML/migration/ensure), port checks,
// log helpers, dependency resolution, and the bundled-runtime/tsx/alias-loader
// resolvers. Depends only on env + branding.

import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  repoRoot,
  binDir,
  require,
  port,
  starterProjectName,
  hermitBridgeConfigPath,
  defaultCcConnectConfigPath,
  defaultCcConnectDataDir,
  legacyRuntimeBridgeConfigPath,
  legacyRuntimeBridgeDataDir,
  conversationUploadLogPath,
} from './env.mjs';
import { BRAND, brandCommand, brandLogPrefix } from '../branding.mjs';

function checkDependency(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

const missingDeps = [];
if (!checkDependency('fastify')) missingDeps.push('fastify');
if (!checkDependency('tsx')) missingDeps.push('tsx');

if (missingDeps.length > 0) {
  console.error(`
${brandLogPrefix()} Error: Missing dependencies: ${missingDeps.join(', ')}

Please install dependencies first:
  cd ${repoRoot}
  npm install
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// cc-connect sidecar
// ---------------------------------------------------------------------------

function escapeTomlPath(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseTomlToken(raw, section) {
  const match = raw.match(new RegExp(`\\[${section}\\][^\\[]*token\\s*=\\s*"([^"]+)"`, 's'));
  return match?.[1] || '';
}

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findProjectBlock(raw, name) {
  const projectPattern = new RegExp(
    `\\[\\[projects\\]\\]\\s*\\n\\s*name\\s*=\\s*"${escapeRegExp(name)}"[\\s\\S]*?(?=\\n\\s*\\[\\[projects\\]\\]|\\s*$)`
  );
  const match = raw.match(projectPattern);
  return match ? { pattern: projectPattern, match } : null;
}

function isManagedBootstrapBlock(block) {
  return (
    block.includes('disabled_commands = ["*"]') &&
    (block.includes('app_id = "placeholder"') ||
      block.includes('channel_token = "openhermit-bootstrap"') ||
      block.includes('callback_path = "/openhermit-bootstrap"'))
  );
}

function isStarterProjectConfig(raw) {
  const block = findProjectBlock(raw, starterProjectName);
  if (!block) return false;
  const text = block.match[0];
  return (
    text.includes('name = "my-project"') &&
    text.includes('type = "claudecode"') &&
    text.includes('work_dir = "/path/to/your/project"') &&
    text.includes('app_id = "your-feishu-app-id"') &&
    text.includes('app_secret = "your-feishu-app-secret"')
  );
}

function configRequiresClaudeCode(raw) {
  return /type\s*=\s*"claudecode"/.test(raw);
}

function hasProjectEntries(raw) {
  const projectPattern = /\[\[projects\]\]\s*\n\s*name\s*=\s*"([^"]+)"[\s\S]*?(?=\n\s*\[\[projects\]\]|\s*$)/g;
  return [...raw.matchAll(projectPattern)].some((match) => !isManagedBootstrapBlock(match[0]));
}

function commandExists(command) {
  try {
    execSync(`${command} --version`, { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
}

function ccConnectBinaryName() {
  return process.platform === 'win32' ? 'cc-connect.exe' : 'cc-connect';
}

/**
 * Detect the cc-connect release platform/arch suffix for the vendored layout.
 * Returns e.g. 'windows-amd64' / 'darwin-arm64', or null if unsupported.
 */
function ccConnectVendorTarget() {
  const osMap = { darwin: 'darwin', win32: 'windows', linux: 'linux' };
  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const os = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) return null;
  return `${os}-${arch}`;
}

/**
 * Resolve the vendored (pre-baked) cc-connect binary path shipped inside
 * agentcli's own npm tarball under vendor/cc-connect/<os>-<arch>/. Returns null
 * when this platform has no vendored binary (e.g. linux) — callers then fall
 * back to the mirror download path.
 */
function resolveVendoredCcConnectBinary() {
  const target = ccConnectVendorTarget();
  if (!target) return null;
  const candidate = path.join(repoRoot, 'vendor', 'cc-connect', target, ccConnectBinaryName());
  return existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the cc-connect package dir inside agentcli's own node_modules.
 * Returns null when the optionalDependency was skipped at install time
 * (the classic silent failure behind "fetch failed" on Windows / behind firewalls).
 */
function resolveCcConnectPackageDir() {
  try {
    const pkgJson = require.resolve('cc-connect/package.json');
    return path.dirname(pkgJson);
  } catch {
    return null;
  }
}

/**
 * Patch cc-connect's install.js so its binary download uses GitHub-release
 * mirrors instead of raw github.com (unreachable behind GFW / corporate
 * firewalls). Idempotent: skips if already patched.
 */
function patchCcConnectInstaller(pkgDir) {
  const installJsPath = path.join(pkgDir, 'install.js');
  if (!existsSync(installJsPath)) return false;
  let src;
  try {
    src = readFileSync(installJsPath, 'utf-8');
  } catch {
    return false;
  }
  if (src.includes('Patched by @yancyyu/agentcli')) return true;
  const marker = '  return [';
  const idx = src.indexOf(marker);
  if (idx === -1) return false;
  const before = src.slice(0, idx);
  const after = src.slice(idx);
  const closeIdx = after.indexOf('];');
  if (closeIdx === -1) return false;
  const replacement =
    '  const github = `https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/${filename}`;\n' +
    '  const gitee = `https://gitee.com/${GITEE_REPO}/releases/download/${VERSION}/${filename}`;\n' +
    '  // Patched by @yancyyu/agentcli: prepend GitHub-release mirror prefixes so the\n' +
    '  // binary can be fetched from behind the GFW / corporate firewalls where raw\n' +
    '  // github.com releases are unreachable. CC_CONNECT_MIRROR (comma-separated)\n' +
    '  // overrides the defaults. Mirrors are tried first; originals remain as fallback.\n' +
    '  const defaults = ["https://gh-proxy.com/", "https://ghproxy.net/"];\n' +
    '  const configured = (process.env.CC_CONNECT_MIRROR || "")\n' +
    '    .split(",")\n' +
    '    .map((s) => s.trim())\n' +
    '    .filter(Boolean);\n' +
    '  const prefixes = [...configured, ...defaults];\n' +
    '  const mirrored = prefixes.map((p) => `${p}${github}`);\n' +
    '  return [...mirrored, github, gitee];';
  try {
    writeFileSync(installJsPath, before + replacement + after.slice(closeIdx + 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the cc-connect npm package AND its native binary are present.
 * Mirrors ensureClaudeCodeCliIfNeeded: detect → install → verify.
 *
 * Flow:
 *   1. If the package shell is missing (optionalDependency was silently
 *      skipped), `npm install cc-connect` it into agentcli's node_modules.
 *   2. Patch its install.js to use GitHub-release mirrors (raw github.com is
 *      unreachable for many Windows / behind-firewall users — the root cause
 *      of the original "fetch failed" bug).
 *   3. Run install.js to download the binary (now via mirrors).
 *   4. Verify the binary exists.
 *
 * Why this lives here (not in the TS layer): the TS HermitBridgeLauncher runs
 * inside the spawned server.ts; by then node is already loaded and a missing
 * binary can only fail at spawn time. Running the check + install here, in the
 * CLI entry (bin/hermit.mjs) BEFORE server.ts starts, means the binary is
 * guaranteed present by the time the server launches cc-connect.
 */
export function ensureCcConnectBinary() {
  let pkgDir = resolveCcConnectPackageDir();
  const binaryName = ccConnectBinaryName();

  // Fast path: package + binary both present.
  if (pkgDir && existsSync(path.join(pkgDir, 'bin', binaryName))) {
    return;
  }

  // PREFERRED PATH: use the vendored (pre-baked) binary shipped inside
  // agentcli's own npm tarball. This needs ZERO network — the binary is
  // physically in the package — so it works on the nastiest networks
  // (air-gapped, corp proxy, GFW, antivirus MITM, …). We copy it into
  // cc-connect's expected bin/ location so run.js picks it up unchanged.
  const vendoredBinary = resolveVendoredCcConnectBinary();
  if (vendoredBinary) {
    // Ensure the cc-connect package shell exists (run.js lives there). If it
    // was silently skipped as an optionalDependency, install just the shell
    // without scripts so we don't trigger the failing GitHub download.
    if (!pkgDir) {
      let version = 'latest';
      try {
        const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
        const pinned = rootPkg.optionalDependencies?.['cc-connect'];
        if (pinned) version = pinned;
      } catch {
        /* latest */
      }
      try {
        execSync(`npm install cc-connect@${version} --ignore-scripts`, {
          stdio: 'inherit',
          cwd: repoRoot,
          shell: true,
        });
      } catch (err) {
        console.error(`${brandLogPrefix()} cc-connect package shell install failed; cannot place vendored binary.`);
        throw err;
      }
      pkgDir = resolveCcConnectPackageDir();
      if (!pkgDir) {
        throw new Error('cc-connect package shell install reported success but package.json still not resolvable');
      }
    }
    // Place the vendored binary into cc-connect/bin/.
    const targetBinDir = path.join(pkgDir, 'bin');
    mkdirSync(targetBinDir, { recursive: true });
    const targetBinaryPath = path.join(targetBinDir, binaryName);
    try {
      cpSync(vendoredBinary, targetBinaryPath);
      if (process.platform !== 'win32') {
        execSync(`chmod +x ${JSON.stringify(targetBinaryPath)}`, { shell: true });
      }
      console.log(`${brandLogPrefix()} cc-connect binary placed from vendored package (no download needed).`);
      return;
    } catch (err) {
      console.warn(`${brandLogPrefix()} Vendored binary copy failed, falling back to download: ${err.message}`);
      /* fall through to download path */
    }
  }

  // FALLBACK PATH (no vendored binary, e.g. linux): download via mirror.
  // Read the pinned version from agentcli's own package.json.
  let version = 'latest';
  try {
    const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    const pinned = rootPkg.optionalDependencies?.['cc-connect'];
    if (pinned) version = pinned;
  } catch {
    /* fall back to latest */
  }

  // Step 1: install the package shell if missing.
  if (!pkgDir) {
    console.log(`${brandLogPrefix()} cc-connect package not found, installing cc-connect@${version}...`);
    try {
      execSync(`npm install cc-connect@${version} --prefer-online --ignore-scripts`, {
        stdio: 'inherit',
        cwd: repoRoot,
        shell: true,
      });
    } catch (err) {
      console.error(`${brandLogPrefix()} cc-connect package install failed.`);
      console.error(`${brandLogPrefix()} Please install it manually: npm install -g cc-connect@${version}`);
      throw err;
    }
    pkgDir = resolveCcConnectPackageDir();
    if (!pkgDir) {
      throw new Error('cc-connect package install reported success but package.json still not resolvable');
    }
  }

  // Step 2: patch install.js to use mirrors.
  const patched = patchCcConnectInstaller(pkgDir);
  if (patched) {
    console.log(`${brandLogPrefix()} Patched cc-connect installer to use mirror downloads.`);
  }

  // Step 3: run install.js to fetch the binary (now via mirrors).
  if (!existsSync(path.join(pkgDir, 'bin', binaryName))) {
    console.log(`${brandLogPrefix()} Downloading cc-connect binary (~10 MB) via mirror...`);
    try {
      execSync(`node install.js`, {
        stdio: 'inherit',
        cwd: pkgDir,
        shell: true,
      });
    } catch (err) {
      console.error(`${brandLogPrefix()} cc-connect binary download failed.`);
      console.error(`${brandLogPrefix()} Try setting CC_CONNECT_MIRROR=https://gh-proxy.com/ and retry.`);
      throw err;
    }
  }

  // Step 4: verify.
  const binaryPath = path.join(pkgDir, 'bin', binaryName);
  if (!existsSync(binaryPath)) {
    throw new Error(
      `cc-connect install finished but binary ${binaryName} is still missing. ` +
        'Set CC_CONNECT_MIRROR=https://gh-proxy.com/ and restart, or download manually from https://github.com/chenhg5/cc-connect/releases'
    );
  }
  console.log(`${brandLogPrefix()} cc-connect binary ready at ${binaryPath}`);
}

function ensureClaudeCodeCliIfNeeded(raw) {
  if (!configRequiresClaudeCode(raw) || commandExists('claude')) return;

  console.log(`${brandLogPrefix()} Claude Code CLI not found.`);
  console.log(`${brandLogPrefix()} Installing @anthropic-ai/claude-code globally. This may take a few minutes...`);
  console.log(`${brandLogPrefix()} Running: npm install -g @anthropic-ai/claude-code@latest --prefer-online`);
  try {
    execSync('npm install -g @anthropic-ai/claude-code@latest --prefer-online', {
      stdio: 'inherit',
      shell: true,
    });
  } catch (err) {
    console.error(`${brandLogPrefix()} Claude Code CLI install command failed.`);
    console.error(`${brandLogPrefix()} Failed to install Claude Code CLI automatically.`);
    console.error(`${brandLogPrefix()} Please install it manually: npm install -g @anthropic-ai/claude-code@latest`);
    throw err;
  }

  if (!commandExists('claude')) {
    throw new Error('Claude Code CLI was installed but `claude` is still not available in PATH');
  }
  console.log(`${brandLogPrefix()} Claude Code CLI installed and available in PATH.`);
}

/**
 * Map a digital-worker agentType to the runtime CLI it requires.
 * Returns { agentType, command, pkg, label } or null for unsupported types.
 *   - 'claudecode' → claude  (@anthropic-ai/claude-code)
 *   - 'codex'      → codex   (@openai/codex)
 */
function agentRuntimeCliSpec(agentType) {
  const t = String(agentType || '').trim();
  if (t === 'claudecode') return { agentType: t, command: 'claude', pkg: '@anthropic-ai/claude-code', label: 'Claude Code' };
  if (t === 'codex') return { agentType: t, command: 'codex', pkg: '@openai/codex', label: 'Codex' };
  return null;
}

/**
 * Ensure the runtime CLI required by a digital-worker agentType is installed.
 * Detect → (hint) → install → verify. Returns { ok, installed, message, detail }.
 *
 * ok=false means the CLI is missing AND auto-install could not make it available
 * (unsupported type, install failed, or `command` still not on PATH afterwards).
 * Callers in the provisioning flow should abort EARLY on ok=false — before team
 * creation / cc-connect restart — so the user isn't left with a half-created
 * worker that only fails when cc-connect tries to launch the runtime. This also
 * covers the re-authorize path (existingTeam), which reuses provisionDigitalWorker.
 *
 * Unlike ensureClaudeCodeCliIfNeeded (which throws), this returns a result so the
 * provisioning gate can surface the message and roll back cleanly.
 */
function ensureAgentRuntimeCli(agentType, { onHint } = {}) {
  const spec = agentRuntimeCliSpec(agentType);
  if (!spec) {
    return { ok: false, installed: false, message: `不支持的运行时类型：${agentType}`, detail: 'unsupported agentType' };
  }
  if (commandExists(spec.command)) {
    return { ok: true, installed: true, message: `${spec.label} CLI 已就绪` };
  }

  const hint = `${spec.label} CLI 未检测到（\`${spec.command}\` 不在 PATH），正在自动安装：npm install -g ${spec.pkg}@latest`;
  console.log(`${brandLogPrefix()} ${hint}`);
  onHint?.({ ...spec, message: hint });

  console.log(`${brandLogPrefix()} Installing ${spec.pkg} globally. This may take a few minutes...`);
  console.log(`${brandLogPrefix()} Running: npm install -g ${spec.pkg}@latest --prefer-online`);
  let installError = null;
  try {
    execSync(`npm install -g ${spec.pkg}@latest --prefer-online`, { stdio: 'inherit', shell: true });
  } catch (err) {
    installError = err;
  }

  if (installError) {
    const message = `${spec.label} CLI 自动安装失败，请手动安装后重试：npm install -g ${spec.pkg}@latest`;
    console.error(`${brandLogPrefix()} ${message}`);
    return { ok: false, installed: false, message, detail: installError instanceof Error ? installError.message : String(installError) };
  }

  if (!commandExists(spec.command)) {
    const message = `${spec.label} CLI 已安装，但 \`${spec.command}\` 仍不在 PATH；请重开终端（或检查 PATH）后重试`;
    console.error(`${brandLogPrefix()} ${message}`);
    return { ok: false, installed: false, message, detail: 'command still not in PATH after install' };
  }

  console.log(`${brandLogPrefix()} ${spec.label} CLI installed and available in PATH.`);
  return { ok: true, installed: true, message: `${spec.label} CLI 已安装并就绪` };
}

function hasTomlSection(raw, section) {
  return new RegExp(`^\\[${section}\\]\\s*$`, 'm').test(raw);
}

function buildOpenHermitStarterConfig(managementToken, bridgeToken) {
  return `# cc-connect configuration
# Runtime bridge packaged by AgentCLI (cc-connect).

data_dir = "${escapeTomlPath(defaultCcConnectDataDir)}"
language = "zh"

[management]
enabled = true
host = "127.0.0.1"
port = 9820
token = "${managementToken}"

[bridge]
enabled = true
host = "127.0.0.1"
port = 9810
token = "${bridgeToken}"
path = "/bridge/ws"

[log]
level = "info"

[[projects]]
name = "my-project"

[projects.agent]
type = "claudecode"   # "claudecode", "codex", "cursor", "gemini", "qoder", "opencode", or "iflow"

[projects.agent.options]
work_dir = "/path/to/your/project"
mode = "default"
# model = "claude-sonnet-4-20250514"

# --- Choose at least one platform below ---

[[projects.platforms]]
type = "feishu"

[projects.platforms.options]
app_id = "your-feishu-app-id"
app_secret = "your-feishu-app-secret"
`;
}

function normalizeMigratedHermitBridgeConfig(raw) {
  return raw
    .split(escapeTomlPath(legacyRuntimeBridgeDataDir))
    .join(escapeTomlPath(defaultCcConnectDataDir))
    .split('~/.hermit/hermit-bridge/data')
    .join('~/.hermit/cc-connect/data');
}

function migrateLegacyHermitBridgeDataIfNeeded() {
  if (existsSync(defaultCcConnectDataDir) || !existsSync(legacyRuntimeBridgeDataDir)) return false;
  mkdirSync(path.dirname(defaultCcConnectDataDir), { recursive: true });
  try {
    renameSync(legacyRuntimeBridgeDataDir, defaultCcConnectDataDir);
  } catch {
    cpSync(legacyRuntimeBridgeDataDir, defaultCcConnectDataDir, { recursive: true });
    rmSync(legacyRuntimeBridgeDataDir, { recursive: true, force: true });
  }
  return true;
}

function normalizeHermitBridgeConfigFileIfNeeded() {
  if (!existsSync(hermitBridgeConfigPath)) return false;
  const raw = readFileSync(hermitBridgeConfigPath, 'utf-8');
  const normalized = normalizeMigratedHermitBridgeConfig(raw);
  if (normalized === raw) return false;
  writeFileSync(hermitBridgeConfigPath, normalized, 'utf-8');
  return true;
}

function migrateLegacyHermitBridgeConfigIfNeeded() {
  if (hermitBridgeConfigPath !== defaultCcConnectConfigPath) return;

  const migratedData = migrateLegacyHermitBridgeDataIfNeeded();
  let migratedConfig = false;
  if (!existsSync(hermitBridgeConfigPath) && existsSync(legacyRuntimeBridgeConfigPath)) {
    mkdirSync(path.dirname(hermitBridgeConfigPath), { recursive: true });
    const migrated = normalizeMigratedHermitBridgeConfig(readFileSync(legacyRuntimeBridgeConfigPath, 'utf-8'));
    writeFileSync(hermitBridgeConfigPath, migrated, 'utf-8');
    rmSync(legacyRuntimeBridgeConfigPath, { force: true });
    migratedConfig = true;
  }
  const normalizedConfig = normalizeHermitBridgeConfigFileIfNeeded();
  if (migratedConfig || migratedData || normalizedConfig) {
    console.log(`${brandLogPrefix()} Migrated runtime files to ~/${BRAND.defaultLocalHomeName}/${BRAND.runtimeBridgeName}/`);
  }
}

function ensureOpenHermitRuntimeConfig() {
  migrateLegacyHermitBridgeConfigIfNeeded();
  mkdirSync(path.dirname(hermitBridgeConfigPath), { recursive: true });
  if (!existsSync(hermitBridgeConfigPath)) {
    writeFileSync(hermitBridgeConfigPath, buildOpenHermitStarterConfig(randomToken(), randomToken()), 'utf-8');
    return;
  }

  let raw = readFileSync(hermitBridgeConfigPath, 'utf-8');
  let changed = false;
  if (!hasTomlSection(raw, 'management')) {
    raw = `${raw.trimEnd()}

[management]
enabled = true
host = "127.0.0.1"
port = 9820
token = "${randomToken()}"
`;
    changed = true;
  }
  if (!hasTomlSection(raw, 'bridge')) {
    raw = `${raw.trimEnd()}

[bridge]
enabled = true
host = "127.0.0.1"
port = 9810
token = "${randomToken()}"
path = "/bridge/ws"
`;
    changed = true;
  }
  if (changed) {
    writeFileSync(hermitBridgeConfigPath, raw, 'utf-8');
  }
}

function readHermitBridgeConfigState() {
  ensureOpenHermitRuntimeConfig();

  const raw = readFileSync(hermitBridgeConfigPath, 'utf-8');

  return {
    configExists: true,
    managementToken:
      process.env.HERMIT_BRIDGE_TOKEN ||
      process.env.HERMIT_BRIDGE_MANAGEMENT_TOKEN ||
      parseTomlToken(raw, 'management'),
    bridgeToken:
      process.env.HERMIT_BRIDGE_WS_TOKEN ||
      process.env.HERMIT_BRIDGE_TOKEN ||
      parseTomlToken(raw, 'bridge'),
    hasProjects: hasProjectEntries(raw),
    isStarterConfig: isStarterProjectConfig(raw),
    raw,
  };
}

async function waitForHermitBridge(baseUrl, token, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (res.ok) return true;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function appendLog(filePath, chunk) {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, chunk);
  } catch {
    // Logging must never block startup.
  }
}

function printLogTail(label, filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trimEnd().split(/\r?\n/).slice(-80);
    console.error(`${brandLogPrefix()} ${label} log: ${filePath}`);
    if (lines.length > 0) {
      console.error(`${brandLogPrefix()} Last ${label} log lines:`);
      console.error(lines.join('\n'));
    }
  } catch {
    console.error(`${brandLogPrefix()} ${label} log: ${filePath}`);
  }
}

function readLogTail(filePath, maxLines = 30) {
  try {
    const content = readFileSync(filePath, 'utf-8').trimEnd();
    if (!content) return '（暂无日志）';
    return content.split(/\r?\n/).slice(-maxLines).join('\n');
  } catch {
    return '（日志文件尚未生成）';
  }
}

function printDeveloperUploadLogs() {
  if (!requireDeveloperMode()) return;
  printCliRows('消息上报调试日志', [
    ['消息上报', conversationUploadLogPath, 'info'],
    ['后台扫描', telemetryWorkerLogPath, 'info'],
    ['错误日志', telemetryWorkerErrorLogPath, 'info'],
  ], '只显示本地日志尾部；不会打印 token、原始 JSONL 或完整私有路径内容。');
  console.log(ui.dim('\n--- conversation-upload.log ---'));
  console.log(readLogTail(conversationUploadLogPath));
  console.log(ui.dim('\n--- telemetry-worker.log ---'));
  console.log(readLogTail(telemetryWorkerLogPath));
  console.log(ui.dim('\n--- telemetry-worker.err.log ---'));
  console.log(readLogTail(telemetryWorkerErrorLogPath));
}

async function waitForRuntimeReady(baseUrl, token, child, timeoutMs = 30_000) {
  let exitCode = null;
  child.once('exit', (code) => {
    exitCode = code ?? 1;
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (exitCode !== null) {
      throw new Error(`Runtime service exited before becoming ready (code ${exitCode})`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/v1/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Runtime service did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

function resolveHermitBridgeRunner() {
  // The upstream npm package was renamed `hermit-bridge` → `cc-connect`. The
  // old require.resolve('hermit-bridge/...') would always throw on fresh
  // installs (no such dependency anymore) and surface as the misleading
  // "runtime is not installed for this platform" warning — the real cause of
  // Windows users never getting cc-connect auto-started.
  //
  // PREFERRED: return the Go binary path directly (not run.js). cc-connect's
  // run.js calls execFileSync(binary, {stdio:'inherit'}) WITHOUT windowsHide,
  // so on Windows the cc-connect.exe pops a console window — users see a black
  // box and close it, killing the runtime and breaking the workbench. Spawning
  // the binary ourselves (with windowsHide:true, see hermit.mjs) avoids that.
  // run.js also re-checks the binary version, but ensureCcConnectBinary()
  // already validated it before we get here, so the wrapper adds no value.
  try {
    const pkgPath = require.resolve('cc-connect/package.json');
    const pkgDir = path.dirname(pkgPath);
    const binaryName = process.platform === 'win32' ? 'cc-connect.exe' : 'cc-connect';
    const binaryPath = path.join(pkgDir, 'bin', binaryName);
    if (existsSync(binaryPath)) return binaryPath;
    // Fallback: hand off to run.js if the binary somehow isn't placed yet
    // (run.js will then re-trigger its install path).
    const runner = path.join(pkgDir, 'run.js');
    return existsSync(runner) ? runner : null;
  } catch {
    return null;
  }
}

function resolveTsxLoader() {
  return pathToFileURL(require.resolve('tsx')).href;
}

function resolveAliasLoaderRegister() {
  const aliasLoaderUrl = pathToFileURL(path.join(binDir, 'alias-loader.mjs')).href;
  return `data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register(${JSON.stringify(aliasLoaderUrl)}, pathToFileURL("./"));`;
}

async function checkExistingOpenHermitServer() {
  const url = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const version = (await res.text()).trim() || 'unknown';
      return { running: true, version, url };
    }
  } catch {
    // Port may be unused or owned by another process.
  }
  return { running: false, version: '', url };
}

async function isTcpPortAvailable(portNumber) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(portNumber, process.env.HOST || '127.0.0.1');
  });
}

async function assertWebPortAvailable() {
  const existingServer = await checkExistingOpenHermitServer();
  if (existingServer.running) {
    console.log(`${brandLogPrefix()} Already running: ${existingServer.url}`);
    console.log(`${brandLogPrefix()} Version: ${existingServer.version}`);
    console.log(`${brandLogPrefix()} Run ${brandCommand('stop')} first, or use ${brandCommand('--port <port>')} for another instance.`);
    process.exit(0);
  }

  const available = await isTcpPortAvailable(Number.parseInt(port, 10));
  if (!available) {
    console.error(`${brandLogPrefix()} Port ${port} is already in use.`);
    console.error(`${brandLogPrefix()} Stop the existing process first, or start with another port:`);
    console.error(`  ${brandCommand(`--port ${Number.parseInt(port, 10) + 1}`)}`);
    console.error(`${brandLogPrefix()} macOS/Linux: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    console.error(`${brandLogPrefix()} Windows: netstat -ano | findstr :${port}`);
    process.exit(1);
  }
}

export {
checkDependency,
escapeTomlPath,
parseTomlToken,
randomToken,
escapeRegExp,
findProjectBlock,
isManagedBootstrapBlock,
isStarterProjectConfig,
configRequiresClaudeCode,
hasProjectEntries,
commandExists,
ensureClaudeCodeCliIfNeeded,
agentRuntimeCliSpec,
ensureAgentRuntimeCli,
hasTomlSection,
buildOpenHermitStarterConfig,
normalizeMigratedHermitBridgeConfig,
migrateLegacyHermitBridgeDataIfNeeded,
normalizeHermitBridgeConfigFileIfNeeded,
migrateLegacyHermitBridgeConfigIfNeeded,
ensureOpenHermitRuntimeConfig,
readHermitBridgeConfigState,
waitForHermitBridge,
appendLog,
printLogTail,
readLogTail,
printDeveloperUploadLogs,
waitForRuntimeReady,
resolveHermitBridgeRunner,
resolveTsxLoader,
resolveAliasLoaderRegister,
checkExistingOpenHermitServer,
isTcpPortAvailable,
assertWebPortAvailable,
};
