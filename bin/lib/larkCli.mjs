// larkCli.mjs — quick-install helper for the official Lark/Feishu CLI.
//
// Backs the "本地数字员工工作台 → 快速安装 lark-cli" menu action. The CLI is
// the npm package `@larksuite/cli` (binary `lark-cli`), per the project's own
// ops docs (scripts/build-pages.mjs expects a `lark-cli` binary on PATH).
//
// Stays in the bin/lib shape: importable, no import-time side effects, returns a
// structured result the caller renders. It only bootstraps the GLOBAL binary —
// the per-team profile wrapper (LARK_CLI_PROFILE in each team .env) is team
// setup, documented in scripts/build-pages.mjs, and intentionally out of scope.
import { spawn, spawnSync } from 'node:child_process';

import { logDwEvent } from './dwDiagnostics.mjs';

const PACKAGE = '@larksuite/cli';
const BINARY = 'lark-cli';

function spawnLarkCli(cmd, args, options) {
  const spawn = globalThis.__larkCli_test_spawn || spawnSync;
  return spawn(cmd, args, { windowsHide: true, ...options });
}

function findBinary() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnLarkCli(cmd, [BINARY], { encoding: 'utf-8' });
    const lines = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length) {
      // On Windows `where lark-cli` can return multiple shims (lark-cli.ps1,
      // lark-cli.cmd, lark-cli, …) in PATH order. A .ps1 shim invoked via
      // spawnSync({shell:true}) from cmd.exe exits 0 with EMPTY stdout — so
      // the worker reads no auth list and falsely reports "no-credentials",
      // even though the user is logged in (credentials are in DPAPI storage).
      // Prefer .cmd (the Node-written shim that pipes stdout correctly) and
      // never pick .ps1. Bare name (no extension) is fine on unix.
      if (process.platform === 'win32') {
        const preferred =
          lines.find((p) => p.toLowerCase().endsWith('\\lark-cli.cmd')) ||
          lines.find((p) => !p.toLowerCase().endsWith('.ps1'));
        return preferred || lines[0];
      }
      return lines[0];
    }
  } catch {
    // which/where unavailable — treat as not found.
  }
  return null;
}

function npmGlobalBin() {
  try {
    const r = spawnLarkCli('npm prefix -g', [], { encoding: 'utf-8', shell: true });
    const prefix = (r.stdout || '').trim();
    if (!prefix) return null;
    return process.platform === 'win32' ? prefix : `${prefix}/bin`;
  } catch {
    return null;
  }
}

const DIGITAL_WORKER_LARK_SCOPES = [
  'contact:contact.base:readonly',
  'contact:user.base:readonly',
  'contact:user.basic_profile:readonly',
  'docs:document.content:read',
  'docx:document:readonly',
  'docx:document:write_only',
  'drive:drive:readonly',
  'im:chat:read',
  'im:message:readonly',
  'im:message.send_as_user',
];

// Commonly-used scopes backing the everyday lark-* skills (calendar, mail,
// task, wiki, sheets, base, minutes, vc, approval, attendance, okr, slides,
// extra drive/im/contact). Best-effort: scopes the app has not enabled or the
// tenant has not approved are simply not granted, and the post-login check
// still only requires DIGITAL_WORKER_LARK_SCOPES, so a partial grant never
// fails the flow. NOTE: do NOT switch this to `--domain`/`--domain all` —
// --domain has compatibility issues across lark-cli versions and `all` also
// pulls in app-administration scopes that need tenant-admin approval and
// stall the device flow on the 90s waiting-approval path.
const COMMON_LARK_SKILL_SCOPES = [
  'calendar:calendar:readonly',
  'calendar:calendar.event:read',
  'calendar:calendar.event:create',
  'calendar:calendar.event:update',
  'calendar:calendar.event:delete',
  'calendar:calendar.free_busy:read',
  'task:task:read',
  'task:task:write',
  'task:tasklist:read',
  'task:tasklist:write',
  'mail:user_mailbox:readonly',
  'mail:user_mailbox.message:readonly',
  'mail:user_mailbox.message:send',
  'wiki:space:read',
  'wiki:space:retrieve',
  'wiki:node:read',
  'wiki:node:retrieve',
  'wiki:node:create',
  'sheets:spreadsheet.meta:read',
  'sheets:spreadsheet:read',
  'sheets:spreadsheet:write_only',
  'sheets:spreadsheet:create',
  'base:readonly',
  'base:workflow:read',
  'base:workflow:update',
  'minutes:minutes:readonly',
  'minutes:minutes.search:read',
  'minutes:minutes.artifacts:read',
  'vc:meeting.search:read',
  'vc:note:read',
  'vc:record:readonly',
  'approval:instance:read',
  'approval:instance:write',
  'approval:task:read',
  'approval:task:write',
  'attendance:task:readonly',
  'okr:okr.period:readonly',
  'okr:okr.content:readonly',
  'okr:okr.progress:readonly',
  'slides:presentation:read',
  'slides:presentation:create',
  'slides:presentation:update',
  'drive:drive.metadata:readonly',
  'drive:file:download',
  'drive:file:upload',
  'docs:document.comment:read',
  'docs:document.comment:create',
  'im:message',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
  'im:chat.members:read',
  'contact:user:search',
];

export function personalLarkProfileName(appId) {
  const normalizedAppId = String(appId || '').trim();
  return normalizedAppId ? `agentcli-user-${normalizedAppId}` : '';
}

function runLarkCli(args, { profile, input } = {}) {
  const binary = findBinary();
  if (!binary) return null;
  const fullArgs = profile ? ['--profile', profile, ...args] : args;
  return spawnLarkCli(binary, fullArgs, { encoding: 'utf-8', shell: process.platform === 'win32', input });
}

function parseJsonOutput(result) {
  try {
    return JSON.parse((result?.stdout || '').trim());
  } catch {
    return null;
  }
}

function getLarkUserIdentity(statusResult) {
  const parsed = parseJsonOutput(statusResult);
  const user = parsed?.identities?.user;
  if (!user || user.available !== true || user.verified !== true) return null;
  const userOpenId = user.userOpenId || user.user_open_id || user.openId || user.open_id || '';
  return { ...user, userOpenId };
}

function parseScopeCheck(result) {
  const parsed = parseJsonOutput(result);
  const missingScopes = Array.isArray(parsed?.missing)
    ? parsed.missing.filter((scope) => typeof scope === 'string' && scope.trim())
    : [];
  return {
    ok: Boolean(parsed?.ok === true && missingScopes.length === 0),
    missingScopes,
  };
}

function listLarkCliProfiles() {
  // NOTE: `lark-cli profile list` does NOT accept `--json` (v1.0.53 rejects it as
  // unknown_flag). The plain subcommand already prints a JSON array to stdout, so
  // parse that directly. Other subcommands (auth status/check/login) do accept
  // `--json` and use it elsewhere above.
  const result = runLarkCli(['profile', 'list']);
  if (!result || result.status !== 0) return null;
  const parsed = parseJsonOutput(result);
  return Array.isArray(parsed) ? parsed : null;
}

export function ensureLarkCliProfile({ profile, appId, appSecret, brand = 'feishu' }) {
  if (!profile || !appId || !appSecret) {
    return { ok: false, message: '缺少 lark-cli profile / app_id / app_secret' };
  }
  const installed = findBinary();
  if (!installed) return { ok: false, message: '未检测到 lark-cli' };

  // lark-cli maps each app_id to at most one profile. When the same Feishu app
  // backs multiple digital workers, forcing a new profile named after the worker
  // fails validation. Reuse the existing profile for this app_id if present.
  const existing = (listLarkCliProfiles() || []).find((p) => p.appId === appId);
  if (existing) {
    return { ok: true, profile: existing.name, reused: true, message: `已复用 lark-cli profile：${existing.name}` };
  }

  const result = runLarkCli([
    'profile', 'add',
    '--name', profile,
    '--app-id', appId,
    '--brand', brand,
    '--app-secret-stdin',
  ], { input: `${appSecret}\n` });
  if (result?.status === 0) return { ok: true, profile, message: `已准备 lark-cli profile：${profile}` };
  const detail = (result?.stderr || result?.stdout || '').trim();
  if (/already exists|已存在|exists/i.test(detail)) {
    const after = (listLarkCliProfiles() || []).find((p) => p.appId === appId);
    if (after) return { ok: true, profile: after.name, reused: true, message: `已复用 lark-cli profile：${after.name}` };
    return { ok: true, profile, message: `已复用 lark-cli profile：${profile}` };
  }
  return { ok: false, profile, message: '创建 lark-cli profile 失败', detail };
}

export function checkLarkCliDigitalWorkerAuth({ profile } = {}) {
  const status = runLarkCli(['auth', 'status', '--json', '--verify'], { profile });
  if (!status || status.status !== 0) {
    return { ok: false, message: '飞书个人身份授权状态不可用', detail: (status?.stderr || status?.stdout || '').trim() };
  }
  const userIdentity = getLarkUserIdentity(status);
  if (!userIdentity) {
    return {
      ok: false,
      message: '需要绑定飞书个人身份',
      detail: (status?.stdout || status?.stderr || '').trim(),
      scopes: DIGITAL_WORKER_LARK_SCOPES,
    };
  }
  const check = runLarkCli(['auth', 'check', '--json', '--scope', DIGITAL_WORKER_LARK_SCOPES.join(' ')], { profile });
  const scopeCheck = parseScopeCheck(check);
  if (!check || check.status !== 0 || !scopeCheck.ok) {
    return {
      ok: false,
      message: '个人授权缺少数字员工所需权限',
      detail: (check?.stdout || check?.stderr || '').trim(),
      scopes: DIGITAL_WORKER_LARK_SCOPES,
      missingScopes: scopeCheck.missingScopes,
      user: userIdentity,
    };
  }
  return {
    ok: true,
    message: userIdentity.userName ? `已绑定个人：${userIdentity.userName}` : '飞书个人身份已绑定',
    scopes: DIGITAL_WORKER_LARK_SCOPES,
    user: userIdentity,
  };
}

const AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function runLarkCliAsync(args, { profile } = {}) {
  const binary = findBinary();
  if (!binary) return Promise.resolve(null);
  const child = globalThis.__larkCli_test_spawn_async || spawn;
  const fullArgs = profile ? ['--profile', profile, ...args] : args;
  const proc = child(binary, fullArgs, { shell: process.platform === 'win32' });
  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (chunk) => { stdout += chunk; });
  proc.stderr?.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    proc.on('close', (code) => {
      resolve({ status: code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.on('error', (err) => {
      resolve({ status: 1, stdout: '', stderr: err.message });
    });
  });
}

export async function ensureLarkCliDigitalWorkerAuth(renderQr, options = {}) {
  const authStartedAt = Date.now();
  const installed = await installLarkCli();
  logDwEvent('dw.lark.install', { ok: installed.ok, message: installed.message, alreadyInstalled: installed.alreadyInstalled });
  if (!installed.ok) return { ...installed, authReady: false };

  let profile = options.profile;
  if (profile && options.appId && options.appSecret) {
    const profileResult = ensureLarkCliProfile({
      profile,
      appId: options.appId,
      appSecret: options.appSecret,
      brand: options.brand,
    });
    logDwEvent('dw.lark.profile', { ok: profileResult.ok, reused: profileResult.reused, message: profileResult.message });
    if (!profileResult.ok) return { ...profileResult, installed, authReady: false };
    profile = profileResult.profile || profile;
  }
  const runOpts = { profile };

  const current = checkLarkCliDigitalWorkerAuth(runOpts);
  // Short-circuit ONLY when not forced. The digital-worker provisioning flow
  // passes options.force so the creator always re-authorizes (refreshes) their
  // personal Feishu identity instead of silently reusing a prior grant — a stale
  // or partial grant would otherwise let the last provisioning step skip auth.
  if (current.ok && !options.force) {
    logDwEvent('dw.lark.reuse', { message: current.message });
    return { ok: true, authReady: true, installed, auth: current, profile, message: current.message };
  }
  logDwEvent('dw.lark.preauth', { ok: current.ok, message: current.message, missingScopes: current.missingScopes });

  // Request the digital-worker scopes plus the commonly-used lark-* skill
  // scopes. Broad `--domain all` is avoided: it has compatibility issues across
  // lark-cli versions and can surface application scopes that the tenant has
  // not enabled, then make a valid personal authorization look incomplete
  // during the post-login check.
  const init = runLarkCli([
    'auth', 'login', '--no-wait', '--json',
    '--scope', [...DIGITAL_WORKER_LARK_SCOPES, ...COMMON_LARK_SKILL_SCOPES].join(' '),
  ], runOpts);
  const initResult = parseJsonOutput(typeof init === 'object' && init !== null && 'then' in init ? await init : init);
  if (!initResult?.verification_url || !initResult?.device_code) {
    const raw = typeof init === 'object' && init !== null && 'then' in init ? await init : init;
    logDwEvent('dw.lark.init.fail', { detail: (raw?.stderr || raw?.stdout || '').slice(0, 300) });
    return {
      ok: false,
      authReady: false,
      installed,
      profile,
      message: '飞书授权初始化失败',
      detail: raw?.stderr || raw?.stdout || '',
      scopes: DIGITAL_WORKER_LARK_SCOPES,
    };
  }
  logDwEvent('dw.lark.init.ok', { interval: initResult.interval });

  // Display verification URL / QR to the user.
  let renderStatus = null;
  if (typeof renderQr === 'function') {
    const maybeStatus = await renderQr(initResult.verification_url, current, initResult);
    if (typeof maybeStatus === 'function') renderStatus = maybeStatus;
  } else {
    console.log(initResult.verification_url);
  }

  // Step 2: poll until user completes authorization in browser.
  // Two timeouts: a SHORT one (90s) that treats continued pending as "waiting
  // for admin approval" — common when the tenant app needs approval and the
  // admin is slow. We throw (not return) so the digital-worker provisioning
  // catch block rolls back the half-created team instead of leaving a zombie.
  // The long AUTH_POLL_TIMEOUT_MS only guards against a genuinely stuck scan.
  const APPROVAL_WAIT_MS = 90_000;
  const startedAt = Date.now();
  let pendingLogged = false;
  let iteration = 0;
  while (Date.now() - startedAt < AUTH_POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    iteration += 1;
    const poll = await runLarkCliAsync(['auth', 'login', '--device-code', initResult.device_code, '--json'], runOpts);
    const pollResult = parseJsonOutput(poll);
    const currentStatus = pollResult?.status || pollResult?.error?.subtype || (poll?.status === 0 ? 'completed' : 'pending');
    renderStatus?.(currentStatus);
    if (poll?.status === 0 && (!pollResult?.error)) break;
    if (pollResult?.ok === true) break;

    // lark-cli 1.0.53 can keep returning authorization_pending (or report an
    // already-consumed device code) after the browser has completed authorization.
    // The persisted profile token is authoritative, so verify its identity/scopes
    // before treating the device-code response as expired. Each verification
    // spawns 2+ lark-cli processes with network calls, so it is throttled to
    // the 1st iteration (fast path when the grant landed during QR display) and
    // every 3rd after that — the device-code poll remains the primary signal.
    if (iteration % 3 === 1) {
      const interim = checkLarkCliDigitalWorkerAuth(runOpts);
      if (interim.ok) {
        renderStatus?.('completed');
        break;
      }
    }
    if (pollResult?.error?.subtype === 'expired') {
      return { ok: false, authReady: false, installed, profile, message: '飞书授权已过期，请重新开通数字员工', scopes: DIGITAL_WORKER_LARK_SCOPES };
    }
    // Still pending past the short window → almost certainly waiting on a slow
    // admin approval (the app/tenant scopes need manager sign-off). Throw so
    // the provisioning flow rolls back the half-created team cleanly; the user
    // re-runs create after approval lands.
    if (currentStatus === 'pending' || currentStatus === 'authorization_pending') {
      if (Date.now() - startedAt > APPROVAL_WAIT_MS) {
        throw new Error(
          '飞书个人授权仍在等待中（90 秒未完成）。如果应用需要管理员审批，请等审批通过后重新创建数字员工；已创建的团队将自动清理。'
        );
      }
      if (!pendingLogged) {
        pendingLogged = true;
        renderStatus?.('waiting-approval');
      }
    }
  }

  const verified = checkLarkCliDigitalWorkerAuth(runOpts);
  logDwEvent(verified.ok ? 'dw.lark.ok' : 'dw.lark.fail', {
    durationMs: Date.now() - authStartedAt,
    message: verified.message,
    missingScopes: verified.missingScopes,
  });
  return verified.ok
    ? { ok: true, authReady: true, installed, auth: verified, profile, message: verified.message }
    : { ok: false, authReady: false, installed, auth: verified, profile, message: verified.message, detail: verified.detail };
}

/**
 * Ensures the `lark-cli` binary is available. Installs `@larksuite/cli` globally
 * via npm when missing or older than MIN_LARK_CLI_VERSION. Resolves to a
 * structured result (never throws) so the menu can always render an outcome.
 */
const MIN_LARK_CLI_VERSION = '1.0.53';

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text || '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isVersionAtLeast(version, minimum) {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

function installedLarkCliVersion(binary) {
  try {
    const r = spawnLarkCli(binary, ['--version'], { encoding: 'utf-8', shell: process.platform === 'win32' });
    if (r.status !== 0) return null;
    return parseVersion(`${r.stdout || ''}\n${r.stderr || ''}`);
  } catch {
    return null;
  }
}

export async function installLarkCli() {
  const existing = findBinary();
  // Skip the global npm install when a new-enough binary is already present —
  // `npm install -g` costs seconds-to-minutes on a slow network even when it
  // would be a no-op, and this runs on every digital-worker authorization.
  if (existing) {
    const version = installedLarkCliVersion(existing);
    const minimum = parseVersion(MIN_LARK_CLI_VERSION);
    if (version && minimum && isVersionAtLeast(version, minimum)) {
      return {
        ok: true,
        alreadyInstalled: true,
        binPath: existing,
        message: `lark-cli 已安装（v${version.join('.')}）`,
      };
    }
  }
  const npmCheck = spawnLarkCli('npm --version', [], { encoding: 'utf-8', shell: true });
  if (npmCheck.status !== 0 || !(npmCheck.stdout || '').trim()) {
    return { ok: false, alreadyInstalled: false, message: '未检测到 npm，请先安装 Node.js / npm' };
  }

  // Only reached when lark-cli is missing or older than MIN_LARK_CLI_VERSION —
  // install/upgrade to the current official release so AgentCLI can rely on the
  // CLI flags used by the digital worker authorization flow.
  const install = spawnLarkCli(`npm install -g ${PACKAGE}`, [], { encoding: 'utf-8', shell: true });
  if (install.status !== 0) {
    return {
      ok: false,
      alreadyInstalled: false,
      message: `安装失败（npm exit ${install.status}）`,
      detail: (install.stderr || install.stdout || '').slice(-400),
    };
  }

  const installed = findBinary() || `${npmGlobalBin()}/${BINARY}`;
  return {
    ok: true,
    alreadyInstalled: Boolean(existing),
    binPath: installed,
    message: existing
      ? `已更新：${installed || existing}`
      : installed ? `已安装：${installed}` : '安装完成，但未在 PATH 找到 lark-cli（重开终端后再试）',
  };
}
