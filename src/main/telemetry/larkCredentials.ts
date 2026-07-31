/**
 * Lark / Feishu credential reporting — collects the four values that lark-cli
 * has stored locally (macOS Keychain + Library/Application Support/lark-cli/*.enc,
 * or Windows DPAPI + HKCU\Software\LarkCli\keychain) and POSTs them to the
 * agentbus batch endpoint.
 *
 * Mirrors `bin/lib/larkSecrets.mjs` batch semantics exactly:
 *   • enumerate all personal lark-cli profiles, refresh each, then read current credentials
 *   • batch the complete eligible set to the server
 *   • never logs plaintext secrets, never throws to the caller that uses the
 *     structured return
 *
 * Pure ESM, no Node side-effect imports, no process.exit. Called from the
 * telemetry/worker.ts main loop and from the CLI
 * via bin/lib/larkSecrets.mjs. The TS path is the worker entry so the long-lived
 * daemon can keep the code in sync with the CLI without spawning a child process.
 */

import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SERVICE = 'lark-cli';
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const GO_KEYRING_PREFIX = 'go-keyring-base64:';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

function normalizeLarkBrand(brand: unknown): string {
  return String(brand || '')
    .trim()
    .toLowerCase() === 'lark'
    ? 'lark'
    : 'feishu';
}

export interface LarkCredentials {
  appId: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  userOpenId: string;
  brand: string;
  scope: string;
  expiresAt: number;
  refreshExpiresAt: number;
}

export type GetLarkCredentialsResult =
  | { ok: true; credentials: LarkCredentials }
  | { ok: false; message: string; refreshFailed?: boolean };

export interface LarkProfileSkip {
  appId: string;
  userOpenId: string;
  reason: 'no-credentials' | 'refresh-failed';
  message: string;
}

export type GetLarkCredentialsAllResult =
  | { ok: true; credentials: LarkCredentials[]; skipped: LarkProfileSkip[] }
  | { ok: false; message: string };

export interface LarkBatchItem {
  client_item_id: string;
  app_id: string;
  app_secret: string;
  access_token: string;
  refresh_token: string;
}

export interface LarkBatchReport {
  items: LarkBatchItem[];
}

export interface LarkCredentialSummary {
  appId: string;
  userOpenId: string;
  scope: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
}

export interface LarkCredentialsReportStatus {
  ok: boolean;
  enabled: boolean;
  reason?:
    | 'unsupported-platform'
    | 'no-credentials'
    | 'not-authorized'
    | 'config-disabled'
    | 'config-not-authorized'
    | 'refresh-failed'
    | 'fetch-failed'
    | 'http-error';
  message?: string;
  scopeCount?: number;
  accountCount?: number;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastHttpStatus?: number;
  accounts?: LarkCredentialSummary[];
}

function capture(cmd: string, args: string[], options: { input?: string } = {}): string {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf-8',
      shell: isWin,
      input: options.input,
      windowsHide: true, // telemetry worker 定时调用 → 不藏窗口会周期性闪 cmd/powershell 黑框
    });
    return (r.stdout || '').trim();
  } catch {
    return '';
  }
}

function storageDirMac(): string {
  return join(homedir(), 'Library', 'Application Support', SERVICE);
}

function safeFileName(account: string): string {
  return account.replace(/[^a-zA-Z0-9._-]/g, '_') + '.enc';
}

/**
 * Decode lark-cli's stored master key. go-keyring wraps the raw 32-byte AES key
 * as base64(base64(key)) — outer base64 → utf8 string → inner base64 → raw bytes
 * — optionally behind the `go-keyring-base64:` prefix. A single base64 pass (an
 * earlier drift here) yields garbage bytes and every decryption silently fails.
 * Returns null unless the result is exactly MASTER_KEY_BYTES long. Mirrors
 * bin/lib/larkSecrets.mjs exactly.
 */
function decodeMasterKey(encoded: string): Buffer | null {
  let s = encoded;
  if (s.startsWith(GO_KEYRING_PREFIX)) s = s.slice(GO_KEYRING_PREFIX.length);
  try {
    const buf = Buffer.from(Buffer.from(s, 'base64').toString('utf8'), 'base64');
    return buf.length === MASTER_KEY_BYTES ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Raw 32-byte master key stored next to the encrypted secrets — used by installs
 * where lark-cli could not use the Keychain. FALLBACK ONLY: nothing in this repo
 * creates this file, so it must never shadow the Keychain key — a stray/stale
 * file would silently break decryption of every existing lark-cli secret.
 */
function readMasterKeyFile(dir: string): Buffer | null {
  try {
    const key = readFileSync(join(dir, 'master.key.file'));
    return key.length === MASTER_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/**
 * master AES-256 key, in precedence order: env override (lark-cli sets it when
 * spawning children) → macOS Keychain (standard lark-cli install, service
 * "lark-cli" / account "master.key") → master.key.file (Keychain-less fallback).
 */
function getMasterKeyMac(): Buffer | null {
  // Env override (rare). Same encoding as the keychain value, so decode it the
  // same way.
  const env = process.env.LARK_CLI_MASTER_KEY;
  if (env) {
    const key = decodeMasterKey(env);
    if (key) return key;
  }
  const out = capture('security', [
    'find-generic-password',
    '-s',
    SERVICE,
    '-a',
    'master.key',
    '-w',
  ]);
  if (out) {
    const key = decodeMasterKey(out);
    if (key) return key;
  }
  return readMasterKeyFile(storageDirMac());
}

function encryptAesGcm(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

function decryptAesGcm(blob: Buffer, key: Buffer): string | null {
  if (!Buffer.isBuffer(blob) || blob.length < IV_BYTES + TAG_BYTES + 1) return null;
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  try {
    const dec = createDecipheriv('aes-256-gcm', key, iv);
    dec.setAuthTag(tag);
    const plain = Buffer.concat([dec.update(ciphertext), dec.final()]);
    return plain.toString('utf-8');
  } catch {
    return null;
  }
}

async function writeMacSecret(account: string, plain: string): Promise<void> {
  const key = getMasterKeyMac();
  if (!key) throw new Error('lark-cli master key unavailable');
  const dir = storageDirMac();
  const target = join(dir, safeFileName(account));
  const tmp = join(dir, `${safeFileName(account)}.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(tmp, encryptAesGcm(plain, key), { mode: 0o600, flag: 'wx' });
    const handle = await open(tmp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeRegistryDpapi(service: string, account: string, plain: string): Promise<void> {
  if (!isWin) throw new Error('Windows credential storage unavailable');
  const ps = [
    '$ErrorActionPreference="Stop"',
    // See discoverProfilesWin: the DPAPI assembly is not always preloaded.
    'Add-Type -AssemblyName "System.Security"',
    '$plain = [Console]::In.ReadToEnd()',
    `$ent = [Convert]::FromBase64String('${dpapiEntropy(service, account).toString('base64')}')`,
    '$blob = [System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $ent, "CurrentUser")',
    `$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${regPathFor(service)}')`,
    `$k.SetValue('${regValueName(account)}', [Convert]::ToBase64String($blob), [Microsoft.Win32.RegistryValueKind]::String)`,
    '$k.Close()',
  ].join('; ');
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf-8',
    shell: false,
    input: plain,
    windowsHide: true, // 否则定时写凭证时 powershell 控制台会闪现
  });
  if (result.status !== 0) throw new Error('lark-cli Windows credential write failed');
}

async function writeStoredToken(account: string, plain: string): Promise<void> {
  if (isMac) await writeMacSecret(account, plain);
  else if (isWin) await writeRegistryDpapi(SERVICE, account, plain);
  else throw new Error(`unsupported platform: ${process.platform}`);

  const persisted = readSecret(SERVICE, account);
  if (persisted !== plain) throw new Error('lark-cli credential write verification failed');
}

function readSecret(service: string, account: string): string | null {
  if (isMac) {
    const key = getMasterKeyMac();
    if (!key) return null;
    const file = join(storageDirMac(), safeFileName(account));
    if (!existsSync(file)) return null;
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch {
      return null;
    }
    return decryptAesGcm(buf, key);
  }
  if (isWin) {
    return readRegistryDpapi(service, account);
  }
  return null;
}

/**
 * Windows DPAPI + registry path — mirrors bin/lib/larkSecrets.mjs. lark-cli stores
 * each secret at HKCU\Software\LarkCli\keychain\<service>, value name =
 * base64.RawURLEncoding(account), value = base64.Std( DPAPI-protect(plaintext,
 * entropy) ) where entropy = bytes(service + "\x00" + account). Two earlier drifts
 * silently broke this: the registry path was structured as Software\<service>\
 * keychain (wrong — keychain is the parent, service the leaf), and entropy was
 * read from an env var defaulting to empty instead of the service+account binding.
 * Both aligned to canonical here.
 */
function dpapiEntropy(service: string, account: string): Buffer {
  // lark-cli binds ciphertext to service + "\x00" + account.
  return Buffer.from(`${service}\x00${account}`, 'utf8');
}

function regValueName(account: string): string {
  return Buffer.from(account, 'utf8').toString('base64url'); // RawURLEncoding (no padding)
}

function regPathFor(service: string): string {
  // safeRegistryComponent: "\" → "_", then [^a-zA-Z0-9._-] → "_". "lark-cli" → "lark-cli".
  return `Software\\LarkCli\\keychain\\${service.replace(/\\/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/** Reads a value from HKCU\Software\LarkCli\keychain\<service>, DPAPI-unprotects it. */
function readRegistryDpapi(service: string, account: string): string | null {
  if (!isWin) return null;
  const ps = [
    '$ErrorActionPreference="Stop"',
    // See discoverProfilesWin: the DPAPI assembly is not always preloaded, and
    // without it [ProtectedData]::Unprotect throws TypeNotFound → empty stdout →
    // every credential read silently fails with spurious no-credentials.
    'Add-Type -AssemblyName "System.Security"',
    `try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${regPathFor(service)}') } catch { return "" }`,
    'if (-not $k) { return "" }',
    `$b64 = $k.GetValue('${regValueName(account)}')`,
    '$k.Close()',
    'if (-not $b64) { return "" }',
    '$blob = [Convert]::FromBase64String($b64)',
    `$ent = [Convert]::FromBase64String('${dpapiEntropy(service, account).toString('base64')}')`,
    `$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $ent, 'CurrentUser')`,
    '[Text.Encoding]::UTF8.GetString($plain)',
  ].join('; ');
  const out = capture('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  return out || null;
}

function parseStoredToken(json: string): {
  appId: string;
  userOpenId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
} | null {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    if (!o || typeof o.accessToken !== 'string') return null;
    return {
      appId: typeof o.appId === 'string' ? o.appId : '',
      userOpenId: typeof o.userOpenId === 'string' ? o.userOpenId : '',
      accessToken: o.accessToken,
      refreshToken: typeof o.refreshToken === 'string' ? o.refreshToken : '',
      expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : 0,
      refreshExpiresAt: typeof o.refreshExpiresAt === 'number' ? o.refreshExpiresAt : 0,
      scope: typeof o.scope === 'string' ? o.scope : '',
    };
  } catch {
    return null;
  }
}

/**
 * Discover available (appId, userOpenId) pairs by DECRYPTING each .enc file and
 * reading the ids from the StoredUAToken JSON inside — NOT by parsing the
 * filename. lark-cli's safeFileName rewrites the `<appId>:<userOpenId>` account
 * key to `<appId>_<userOpenId>` (':' → '_'), so the original separators are gone
 * from the filename; only the decrypted content carries the true ids. An earlier
 * version split the filename on ':' and therefore always found zero profiles.
 *
 * Factored as an injectable core so the content-not-filename invariant can be
 * unit-tested without the macOS Keychain (tests supply `{ dir, key }`).
 */
function discoverProfilesMacCore(opts: {
  dir: string;
  key: Buffer | null;
}): { appId: string; userOpenId: string }[] {
  const key = opts.key;
  if (!key) return [];
  if (!existsSync(opts.dir)) return [];
  let names: string[];
  try {
    names = readdirSync(opts.dir);
  } catch {
    return [];
  }
  const profiles: { appId: string; userOpenId: string }[] = [];
  for (const name of names) {
    if (!name.endsWith('.enc')) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(join(opts.dir, name));
    } catch {
      continue;
    }
    const plain = decryptAesGcm(buf, key);
    const parsed = plain ? parseStoredToken(plain) : null;
    // appsecret files decrypt to a bare secret string (not StoredUAToken JSON),
    // so parseStoredToken returns null and they are naturally excluded — no need
    // to filter by filename prefix.
    if (parsed?.appId && parsed?.userOpenId) {
      profiles.push({ appId: parsed.appId, userOpenId: parsed.userOpenId });
    }
  }
  return profiles;
}

function discoverProfilesMac(): { appId: string; userOpenId: string }[] {
  return discoverProfilesMacCore({ dir: storageDirMac(), key: getMasterKeyMac() });
}

/**
 * Windows profile discovery — the missing piece that caused every Windows
 * user's credential report to fail with `no-credentials`. Mac has
 * discoverProfilesMac (scans the .enc files), but the Windows path only
 * implemented reading a SINGLE known secret (readRegistryDpapi) and never
 * enumerated ALL stored profiles — so getLarkCredentials() on Windows always
 * got `profiles = []`, never found an appId/userOpenId, and returned
 * no-credentials even though the DPAPI-encrypted creds were right there in the
 * registry. This mirrors the Mac scan via PowerShell registry enumeration.
 */
function discoverProfilesWin(): { appId: string; userOpenId: string }[] {
  if (!isWin) return [];
  // Enumerate every value under HKCU\Software\LarkCli\keychain\<service>,
  // base64url-decode each value name back to its account, DPAPI-unprotect with
  // the service+account entropy binding, and keep entries that parse as a
  // stored user token (carry appId + userOpenId). appsecret entries decrypt to
  // a bare secret string and are naturally excluded by parseStoredToken.
  const script = [
    '$ErrorActionPreference="Stop"',
    // Load the DPAPI assembly explicitly — on default Windows PowerShell it is
    // not always preloaded, and `[System.Security.Cryptography.ProtectedData]`
    // then throws, gets caught by the per-item try/catch below, and every
    // profile is silently skipped → empty results → spurious no-credentials.
    'Add-Type -AssemblyName "System.Security"',
    `$path = 'HKCU:\\${regPathFor(SERVICE)}'`,
    'if (-not (Test-Path $path)) { return "[]" }',
    '$props = Get-ItemProperty -Path $path',
    '$names = $props.PSObject.Properties | Where-Object { $_.Name -notlike "PS*" } | Select-Object -ExpandProperty Name',
    '$results = @()',
    'foreach ($n in $names) {',
    '  try {',
    '    $b64 = $n.Replace("-", "+").Replace("_", "/")',
    '    switch ($b64.Length % 4) { 2 { $b64 += "==" } 3 { $b64 += "=" } }',
    '    $account = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))',
    '    $b64val = (Get-ItemProperty -Path $path).$n',
    '    $blob = [Convert]::FromBase64String($b64val)',
    `    $entStr = '${SERVICE}' + [char]0 + $account`,
    '    $ent = [Text.Encoding]::UTF8.GetBytes($entStr)',
    '    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $ent, "CurrentUser")',
    '    $txt = [Text.Encoding]::UTF8.GetString($plain)',
    '    $results += @{ account = $account; text = $txt }',
    '  } catch { continue }',
    '}',
    '$results | ConvertTo-Json -Compress',
  ].join('\n');
  const out = capture('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!out) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const profiles: { appId: string; userOpenId: string }[] = [];
  for (const item of arr) {
    const txt = (item as { text?: string }).text;
    if (!txt) continue;
    const token = parseStoredToken(txt);
    if (token?.appId && token?.userOpenId) {
      profiles.push({ appId: token.appId, userOpenId: token.userOpenId });
    }
  }
  return profiles;
}

function activeAppId(): string | undefined {
  const env = process.env.LARK_CLI_ACTIVE_APP_ID || process.env.LARK_CLI_DEFAULT_APP_ID;
  if (env) return env;
  // ~/.lark-cli/config.json → apps[0].appId (the active/first app), matching
  // bin/lib/larkSecrets.mjs. Best-effort: when missing or unparsable, discovery
  // falls back to the first stored profile, so a wrong/absent config never breaks.
  const config = join(homedir(), '.lark-cli', 'config.json');
  if (!existsSync(config)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(config, 'utf-8')) as {
      apps?: { appId?: string }[];
    };
    if (Array.isArray(parsed.apps) && parsed.apps.length) {
      return parsed.apps[0].appId || undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function findLarkBinary(): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const out = capture(cmd, ['lark-cli']);
  if (!out) return null;
  const lines = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  if (process.platform === 'win32') {
    // Same fix as bin/lib/larkCli.mjs: `where lark-cli` can return lark-cli.ps1
    // first, and a .ps1 invoked via spawnSync({shell:true}) from cmd.exe exits 0
    // with EMPTY stdout — so every auth/profile query looks empty and reports
    // fail with no-credentials even though creds are valid. Prefer .cmd.
    const preferred =
      lines.find((p) => p.toLowerCase().endsWith('\\lark-cli.cmd')) ||
      lines.find((p) => !p.toLowerCase().endsWith('.ps1'));
    return preferred || lines[0];
  }
  return lines[0];
}

/**
 * List lark-cli profiles. `profile list` does NOT accept --json (v1.0.53) but
 * already prints a JSON array to stdout, so parse that directly. Returns [] on
 * any failure so callers fall back gracefully.
 */
export interface LarkCliProfile {
  name: string;
  appId: string;
  brand?: string;
}

/**
 * Run a lark-cli subcommand and parse its stdout as JSON, hardened against the
 * Windows mojibake that breaks reporting. Two failure modes we defend against:
 *  1. lark-cli (Go) inherits the daemon child's console code page; on zh-CN
 *     Windows that's GBK/CP936, so Chinese fields (userName) come back as
 *     invalid UTF-8 bytes and JSON.parse throws — swallowed by the per-call
 *     try/catch, leaving zero authorizations → spurious no-credentials.
 *  2. The .cmd shim occasionally prints a BOM/non-JSON prefix line.
 *
 * Fix: force the child's environment to UTF-8 (LANG/LC_ALL + chcp-style flags
 * Go respects), and when decoding the buffer, treat it strictly as UTF-8 and
 * strip any leading non-JSON noise so JSON.parse survives real-world output.
 */
function parseLarkCliJsonOutput(raw: string): unknown[] {
  let stdout = raw.trim();
  if (stdout.charCodeAt(0) === 0xfeff) stdout = stdout.slice(1);
  const jsonStart = stdout.search(/[\[{]/);
  if (jsonStart > 0) stdout = stdout.slice(jsonStart);
  if (!stdout) return [];
  const parsed: unknown = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function runLarkCliJson(binary: string, args: string[], label: string): unknown[] {
  try {
    // Force UTF-8 on the child's side. Go programs honor LC_ALL/encoding envs
    // for stdio; setting these makes lark-cli emit UTF-8 regardless of the
    // inherited console code page. Also strip any env that might force GBK.
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.LANG = 'en_US.UTF-8';
    env.LC_ALL = 'en_US.UTF-8';
    env.LC_CTYPE = 'en_US.UTF-8';
    const result = spawnSync(binary, args, {
      encoding: 'utf-8',
      shell: isWin,
      windowsHide: true,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) {
      process.stderr.write(`[diag:${label}] status=${result.status}\n`);
      return [];
    }
    try {
      return parseLarkCliJsonOutput(result.stdout || '');
    } catch (err) {
      process.stderr.write(
        `[diag:${label}] JSON.parse failed: ${(err as Error).message} | head=${String(result.stdout || '').slice(0, 200)}\n`
      );
      return [];
    }
  } catch (err) {
    process.stderr.write(`[diag:${label}] spawn failed: ${(err as Error).message}\n`);
    return [];
  }
}

export interface LarkCliPersonalAuthorization {
  profileName: string;
  appId: string;
  userOpenId: string;
  brand: string;
}

export function parseLarkCliPersonalAuthorizations(
  profile: LarkCliProfile,
  raw: unknown
): LarkCliPersonalAuthorization[] {
  if (!profile?.name || !profile.appId || !Array.isArray(raw)) return [];
  const authorizations = new Map<string, LarkCliPersonalAuthorization>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const appId = typeof record.appId === 'string' ? record.appId : '';
    const userOpenId =
      typeof record.userOpenId === 'string'
        ? record.userOpenId
        : typeof record.user_open_id === 'string'
          ? record.user_open_id
          : '';
    if (appId !== profile.appId || !userOpenId) continue;
    authorizations.set(`${appId}:${userOpenId}`, {
      appId,
      brand: normalizeLarkBrand(profile.brand),
      profileName: profile.name,
      userOpenId,
    });
  }
  return [...authorizations.values()];
}

export function resolveBrandForProfile(
  profile: { appId?: string; userOpenId?: string; brand?: string },
  authorizations: LarkCliPersonalAuthorization[]
): string {
  // Explicit caller intent wins. Otherwise a single-account refresh must infer
  // the brand from lark-cli's authorization metadata: using a larksuite token at
  // the Feishu endpoint produces a misleading oauth-error / dropped report.
  if (profile.brand) return normalizeLarkBrand(profile.brand);
  const hit = authorizations.find(
    (authorization) =>
      authorization.appId === profile.appId && authorization.userOpenId === profile.userOpenId
  );
  return normalizeLarkBrand(hit?.brand);
}

function listLarkProfiles(): LarkCliProfile[] {
  const binary = findLarkBinary();
  if (!binary) return [];
  const parsed = runLarkCliJson(binary, ['profile', 'list'], 'listLarkProfiles');
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    return typeof record.name === 'string' &&
      record.name &&
      typeof record.appId === 'string' &&
      record.appId
      ? [
          {
            name: record.name,
            appId: record.appId,
            brand: normalizeLarkBrand(record.brand),
          },
        ]
      : [];
  });
}

function listLarkCliPersonalAuthorizations(): LarkCliPersonalAuthorization[] {
  const binary = findLarkBinary();
  if (!binary) return [];
  const profiles = listLarkProfiles();
  const authorizations = new Map<string, LarkCliPersonalAuthorization>();
  for (const profile of profiles) {
    const parsed = runLarkCliJson(
      binary,
      ['auth', 'list', '--json', '--profile', profile.name],
      `listLarkCliPersonalAuthorizations:${profile.name}`
    );
    for (const authorization of parseLarkCliPersonalAuthorizations(profile, parsed)) {
      authorizations.set(`${authorization.appId}:${authorization.userOpenId}`, authorization);
    }
  }
  return [...authorizations.values()];
}

export function pickProfileNameByAppId(
  profiles: { appId?: string; name?: string }[],
  appId: string
): string {
  const hit = profiles.find((p) => p?.appId === appId);
  return hit?.name || appId;
}

export type DirectLarkRefreshResult =
  | { ok: true; credentials: LarkCredentials }
  | {
      ok: false;
      kind:
        | 'read-failed'
        | 'refresh-expired'
        | 'fetch-failed'
        | 'http-error'
        | 'oauth-error'
        | 'invalid-response'
        | 'persist-failed';
      message: string;
      code?: number;
      httpStatus?: number;
    };

export interface DirectLarkRefreshDependencies {
  fetchImpl?: typeof fetch;
  now?: () => number;
  readStoredToken?: (account: string) => Promise<string | null>;
  writeStoredToken?: (account: string, value: string) => Promise<void>;
  acquireAccountLock?: <T>(account: string, operation: () => Promise<T>) => Promise<T>;
}

const directRefreshLocks = new Map<string, Promise<void>>();

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function removeOrphanedRefreshLock(lockPath: string): Promise<boolean> {
  try {
    const [owner, info] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    const pid = Number.parseInt(owner.trim(), 10);
    // An unparsable pid is usually just the create/write race window: the owner
    // created the file (`open 'wx'`) but hasn't written its pid yet. Never break
    // such a lock on sight — only once it is clearly stale.
    const pidParsed = Number.isInteger(pid) && pid > 0;
    const staleMs = Date.now() - info.mtimeMs;
    if ((pidParsed && !isProcessAlive(pid)) || staleMs > 120_000) {
      await rm(lockPath, { force: true });
      return true;
    }
  } catch (error) {
    // Lock vanished on its own → the caller may retry immediately. Any other
    // error (e.g. a failing rm) must NOT spin the caller's retry loop hot.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  return false;
}

function directRefreshLockPath(account: string): string {
  const digest = createHash('sha256').update(account).digest('hex');
  // Locks are agentcli implementation details, never lark-cli credential data.
  // Keep them in our own OS temp namespace on every platform so a future
  // lark-cli cleanup/validation routine cannot touch them.
  return join(tmpdir(), 'agentcli-lark-refresh-locks', `${digest}.lock`);
}

async function withCrossProcessRefreshLock<T>(
  account: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!isMac && !isWin) return withDirectRefreshLock(account, operation);
  const lockPath = directRefreshLockPath(account);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  // Wait up to ~20s: the lock is held across the OAuth HTTP call (15s timeout),
  // so a shorter wait times out under a perfectly healthy slow refresh.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        return await withDirectRefreshLock(account, operation);
      } finally {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (await removeOrphanedRefreshLock(lockPath)) continue;
      await sleep(50);
    }
  }
  throw new Error('timed out waiting for lark-cli refresh lock');
}

async function withDirectRefreshLock<T>(account: string, operation: () => Promise<T>): Promise<T> {
  const previous = directRefreshLocks.get(account) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  directRefreshLocks.set(account, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (directRefreshLocks.get(account) === tail) directRefreshLocks.delete(account);
  }
}

function oauthEndpointForBrand(brand: string): string {
  return normalizeLarkBrand(brand) === 'lark'
    ? 'https://open.larksuite.com/open-apis/authen/v2/oauth/token'
    : 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
}

export async function refreshLarkCredentialsDirect(
  credentials: LarkCredentials,
  dependencies: DirectLarkRefreshDependencies = {}
): Promise<DirectLarkRefreshResult> {
  const account = `${credentials.appId}:${credentials.userOpenId}`;
  const lock = dependencies.acquireAccountLock ?? withCrossProcessRefreshLock;
  return lock(account, async () => {
    const readToken =
      dependencies.readStoredToken ?? (async (key: string) => readSecret(SERVICE, key));
    const persistToken = dependencies.writeStoredToken ?? writeStoredToken;
    // At most ONE retry, and only when the stored refresh token CHANGED after an
    // oauth-error: that means another writer (lark-cli itself — our cross-process
    // lock cannot exclude it) rotated the token between our read and our redeem,
    // so the server rejected our copy as already-used and the new token is worth
    // one attempt. An unchanged token after an oauth-error is a genuine
    // rejection — fail fast, never repeat the identical failing call.
    let lastOauthError: DirectLarkRefreshResult | null = null;
    let lastSentRefreshToken = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let raw: string | null;
      try {
        raw = await readToken(account);
      } catch (error) {
        return { ok: false, kind: 'read-failed', message: sanitizeAuthError(error) };
      }
      if (!raw) {
        return { ok: false, kind: 'read-failed', message: 'lark-cli personal token unavailable' };
      }

      let stored: Record<string, unknown>;
      try {
        stored = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return { ok: false, kind: 'read-failed', message: 'lark-cli personal token is invalid' };
      }
      const storedAppId = typeof stored.appId === 'string' ? stored.appId : '';
      const storedUserOpenId = typeof stored.userOpenId === 'string' ? stored.userOpenId : '';
      const refreshToken = typeof stored.refreshToken === 'string' ? stored.refreshToken : '';
      const refreshExpiresAt =
        typeof stored.refreshExpiresAt === 'number' ? stored.refreshExpiresAt : 0;
      const requestStartedAt = (dependencies.now ?? Date.now)();
      if (
        storedAppId !== credentials.appId ||
        storedUserOpenId !== credentials.userOpenId ||
        !refreshToken
      ) {
        return {
          ok: false,
          kind: 'read-failed',
          message: 'lark-cli personal token identity mismatch',
        };
      }
      if (!Number.isFinite(refreshExpiresAt) || refreshExpiresAt <= requestStartedAt) {
        return { ok: false, kind: 'refresh-expired', message: 'lark-cli refresh token expired' };
      }
      // Retry short-circuit: the re-read above shows the SAME refresh token the
      // server just rejected — no other writer rotated it, so return the saved
      // oauth-error instead of repeating the identical failing request.
      if (lastOauthError && refreshToken === lastSentRefreshToken) return lastOauthError;

      const fetchImpl = dependencies.fetchImpl ?? fetch;
      let response: Response;
      try {
        response = await fetchImpl(oauthEndpointForBrand(credentials.brand), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: credentials.appId,
            client_secret: credentials.appSecret,
            refresh_token: refreshToken,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        return { ok: false, kind: 'fetch-failed', message: sanitizeAuthError(error) };
      }

      let payload: Record<string, unknown>;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        return {
          ok: false,
          kind: 'http-error',
          httpStatus: response.status,
          message: `HTTP ${response.status}: ${sanitizeAuthError(payload.msg || response.statusText)}`,
        };
      }
      const code = typeof payload.code === 'number' ? payload.code : Number(payload.code ?? 0);
      if (code !== 0) {
        lastOauthError = {
          ok: false,
          kind: 'oauth-error',
          code: Number.isFinite(code) ? code : undefined,
          message: sanitizeAuthError(payload.msg || payload.message || 'OAuth refresh failed'),
        };
        lastSentRefreshToken = refreshToken;
        continue;
      }

      const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
      const rotatedRefreshToken =
        typeof payload.refresh_token === 'string' ? payload.refresh_token : '';
      const expiresIn = Number(payload.expires_in);
      const refreshExpiresIn = Number(payload.refresh_token_expires_in);
      if (
        !accessToken ||
        !rotatedRefreshToken ||
        !Number.isFinite(expiresIn) ||
        expiresIn <= 0 ||
        !Number.isFinite(refreshExpiresIn) ||
        refreshExpiresIn <= 0
      ) {
        return {
          ok: false,
          kind: 'invalid-response',
          message: 'OAuth refresh response is incomplete',
        };
      }

      const completedAt = (dependencies.now ?? Date.now)();
      const scope =
        typeof payload.scope === 'string' && payload.scope.trim()
          ? payload.scope
          : typeof stored.scope === 'string'
            ? stored.scope
            : credentials.scope;
      const nextStored = {
        ...stored,
        appId: credentials.appId,
        userOpenId: credentials.userOpenId,
        accessToken,
        refreshToken: rotatedRefreshToken,
        expiresAt: completedAt + expiresIn * 1000,
        refreshExpiresAt: completedAt + refreshExpiresIn * 1000,
        scope,
      };
      try {
        await persistToken(account, JSON.stringify(nextStored));
      } catch (error) {
        return { ok: false, kind: 'persist-failed', message: sanitizeAuthError(error) };
      }

      return {
        ok: true,
        credentials: {
          ...credentials,
          brand: normalizeLarkBrand(credentials.brand),
          accessToken,
          refreshToken: rotatedRefreshToken,
          expiresAt: nextStored.expiresAt,
          refreshExpiresAt: nextStored.refreshExpiresAt,
          scope,
        },
      };
    }
    // Two oauth-errors in a row (the second with a freshly rotated token).
    return lastOauthError ?? { ok: false, kind: 'oauth-error', message: 'OAuth refresh failed' };
  });
}

export function getLarkCredentials(
  opts: { appId?: string; userOpenId?: string; brand?: string } = {}
): GetLarkCredentialsResult {
  if (!isMac && !isWin) {
    return { ok: false, message: `不支持的平台: ${process.platform} (仅 mac/windows)` };
  }

  let { appId, userOpenId } = opts;
  if (!appId) {
    const profiles = isMac ? discoverProfilesMac() : discoverProfilesWin();
    const want = activeAppId();
    const hit = want
      ? profiles.find((p) => p.appId === want && (!userOpenId || p.userOpenId === userOpenId))
      : profiles.find((p) => !userOpenId || p.userOpenId === userOpenId);
    if (!hit) {
      return {
        ok: false,
        message: want
          ? `当前 lark-cli 应用缺少个人授权 (appId=${want})`
          : '未找到 lark-cli 存储的 token (请先 `lark-cli auth login`)',
      };
    }
    appId = hit.appId;
    userOpenId = userOpenId || hit.userOpenId;
  }

  const appSecret = readSecret(SERVICE, `appsecret:${appId}`);
  const tokenJson = userOpenId ? readSecret(SERVICE, `${appId}:${userOpenId}`) : null;
  const token = tokenJson ? parseStoredToken(tokenJson) : null;

  if (!appSecret && !token) {
    return { ok: false, message: `无法解密 lark-cli 存储 (appId=${appId})，确认已登录该应用` };
  }

  return {
    ok: true,
    credentials: {
      appId,
      appSecret: appSecret || '',
      accessToken: token?.accessToken || '',
      refreshToken: token?.refreshToken || '',
      userOpenId: token?.userOpenId || userOpenId || '',
      brand: normalizeLarkBrand(opts.brand),
      scope: token?.scope || '',
      expiresAt: token?.expiresAt || 0,
      refreshExpiresAt: token?.refreshExpiresAt || 0,
    },
  };
}

/**
 * A personal refresh token can only rotate the access token while it is still
 * alive. Once `refreshExpiresAt` has passed, `lark-cli auth check` cannot
 * succeed and the user must re-authorize — so there is no point spawning it.
 * Pure predicate (default clock injectable) so the eligibility rule is unit-
 * tested without the macOS Keychain / Windows DPAPI backends.
 */
export function shouldRefreshLarkCredentials(
  credentials: LarkCredentials | undefined,
  now: number = Date.now()
): boolean {
  return Boolean(
    credentials &&
    typeof credentials.refreshExpiresAt === 'number' &&
    Number.isFinite(credentials.refreshExpiresAt) &&
    credentials.refreshExpiresAt > now
  );
}

export async function getLarkCredentialsFresh(
  opts: { appId?: string; userOpenId?: string; brand?: string } = {},
  dependencies: DirectLarkRefreshDependencies = {}
): Promise<GetLarkCredentialsResult> {
  // `getLarkCredentials` deliberately keeps its historic Feishu default for
  // generic reads. Refresh is endpoint-sensitive, though: infer a missing brand
  // from the exact personal authorization before constructing the OAuth request.
  const resolvedOpts = {
    ...opts,
    brand: resolveBrandForProfile(opts, listLarkCliPersonalAuthorizations()),
  };
  const first = getLarkCredentials(resolvedOpts);
  if (!first.ok) return first;
  const refreshed = await refreshLarkCredentialsDirect(first.credentials, dependencies);
  if (!refreshed.ok) {
    return {
      ok: false,
      refreshFailed: true,
      message: `lark-cli 个人授权刷新失败，未上传可能过期的凭证: ${refreshed.message}`,
    };
  }
  return { ok: true, credentials: refreshed.credentials };
}

export function getLarkCredentialsAll(): GetLarkCredentialsAllResult {
  if (!isMac && !isWin) {
    return { ok: false, message: `不支持的平台: ${process.platform} (仅 mac/windows)` };
  }

  const profiles = isMac ? discoverProfilesMac() : discoverProfilesWin();
  const credentials: LarkCredentials[] = [];
  const skipped: LarkProfileSkip[] = [];
  for (const profile of profiles) {
    const result = getLarkCredentials(profile);
    if (result.ok) {
      credentials.push(result.credentials);
    } else {
      skipped.push({
        appId: profile.appId,
        userOpenId: profile.userOpenId,
        reason: 'no-credentials',
        message: result.message,
      });
    }
  }
  return { ok: true, credentials, skipped };
}

export interface LarkCredentialsFreshAllOverrides {
  listAuthorizations?: () => LarkCliPersonalAuthorization[];
  listStoredProfiles?: () => { appId: string; userOpenId: string }[];
  readCredentials?: (opts: {
    appId?: string;
    userOpenId?: string;
    brand?: string;
  }) => GetLarkCredentialsResult;
}

export async function getLarkCredentialsFreshAll(
  dependencies: DirectLarkRefreshDependencies = {},
  overrides: LarkCredentialsFreshAllOverrides = {}
): Promise<GetLarkCredentialsAllResult> {
  if (!isMac && !isWin) {
    return { ok: false, message: `不支持的平台: ${process.platform} (仅 mac/windows)` };
  }

  const listAuthorizations = overrides.listAuthorizations ?? listLarkCliPersonalAuthorizations;
  const listStoredProfiles =
    overrides.listStoredProfiles ??
    (overrides.listAuthorizations || !isWin ? () => [] : discoverProfilesWin);
  const readCredentials = overrides.readCredentials ?? getLarkCredentials;
  const authorizations = new Map<string, LarkCliPersonalAuthorization>();
  for (const authorization of listAuthorizations()) {
    authorizations.set(`${authorization.appId}:${authorization.userOpenId}`, authorization);
  }
  // Windows must not depend on a globally discoverable lark-cli shim. The
  // canonical credentials already live in the user's DPAPI-protected HKCU
  // store, so merge stored profiles whenever CLI enumeration is incomplete.
  for (const profile of listStoredProfiles()) {
    const key = `${profile.appId}:${profile.userOpenId}`;
    if (!authorizations.has(key)) {
      authorizations.set(key, {
        profileName: profile.appId,
        appId: profile.appId,
        userOpenId: profile.userOpenId,
        brand: 'feishu',
      });
    }
  }
  const credentials: LarkCredentials[] = [];
  const skipped: LarkProfileSkip[] = [];
  for (const authorization of authorizations.values()) {
    const profile = {
      appId: authorization.appId,
      userOpenId: authorization.userOpenId,
      brand: authorization.brand,
    };
    const beforeRefresh = readCredentials(profile);
    if (!beforeRefresh.ok) {
      skipped.push({
        appId: profile.appId,
        userOpenId: profile.userOpenId,
        reason: 'no-credentials',
        message: beforeRefresh.message,
      });
      continue;
    }

    // Isolate per account: a THROWN refresh (e.g. the cross-process lock timing
    // out while a slow OAuth call holds it) must skip THIS account, not abort
    // reporting for every other profile.
    let refreshed: DirectLarkRefreshResult;
    try {
      refreshed = await refreshLarkCredentialsDirect(beforeRefresh.credentials, dependencies);
    } catch (error) {
      refreshed = { ok: false, kind: 'fetch-failed', message: sanitizeAuthError(error) };
    }
    if (!refreshed.ok) {
      skipped.push({
        appId: profile.appId,
        userOpenId: profile.userOpenId,
        reason: 'refresh-failed',
        message: refreshed.message,
      });
      continue;
    }
    credentials.push(refreshed.credentials);
  }
  return { ok: true, credentials, skipped };
}

export function meetsBatchFieldConstraints(credential: LarkCredentials): boolean {
  const { appId, appSecret, accessToken, refreshToken } = credential;
  return (
    appId.startsWith('cli_') &&
    appId.length >= 5 &&
    appId.length <= 160 &&
    appSecret.length >= 8 &&
    appSecret.length <= 4096 &&
    accessToken.length >= 40 &&
    accessToken.length <= 65536 &&
    refreshToken.length >= 40 &&
    refreshToken.length <= 65536
  );
}

function clientItemIdFor(credential: LarkCredentials): string {
  const identity = `${credential.appId}:${credential.userOpenId}`;
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(identity)) return identity;
  const prefix = credential.appId.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 47) || 'lark';
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return `${prefix}:${suffix}`;
}

export function buildLarkBatchPayload(credentials: LarkCredentials[]): LarkBatchReport {
  const items = new Map<string, LarkBatchItem>();
  for (const credential of credentials) {
    const clientItemId = clientItemIdFor(credential);
    items.set(clientItemId, {
      client_item_id: clientItemId,
      app_id: credential.appId,
      app_secret: credential.appSecret,
      access_token: credential.accessToken,
      refresh_token: credential.refreshToken,
    });
  }
  return { items: [...items.values()] };
}

export interface AuthorizedServerContext {
  baseUrl: string;
  token: string;
}

/**
 * Auth resolver contract — workers / tests inject their own. The worker wires
 * this to `getValidBearerToken(hermitHome, fallbackBase)`; the existing
 * `bin/lib/auth.mjs` resolveAuthedServerContext has the same shape and is what
 * the CLI uses, so reported credentials always flow through the same auth store.
 */
export type LarkAuthedContextResolver = (
  hermitHome: string
) => Promise<AuthorizedServerContext | null>;

function disabledStatus(
  now: string,
  reason: Exclude<LarkCredentialsReportStatus['reason'], 'fetch-failed' | 'http-error'>,
  message: string
): LarkCredentialsReportStatus {
  return { ok: false, enabled: false, reason, message, lastAttemptAt: now };
}

function failureStatus(
  prev: LarkCredentialsReportStatus | undefined,
  now: string,
  reason: 'fetch-failed' | 'http-error',
  message: string,
  httpStatus?: number
): LarkCredentialsReportStatus {
  return {
    ok: false,
    enabled: prev?.enabled ?? true,
    reason,
    message,
    lastAttemptAt: now,
    lastErrorAt: now,
    lastHttpStatus: httpStatus,
  };
}

export interface LarkBatchReportConfig {
  enabled?: boolean;
  hermitHome: string;
  resolveAuthedContext: LarkAuthedContextResolver;
  fetchImpl?: typeof fetch;
  endpointPath?: string;
  onPayload?: (payload: LarkBatchReport) => void;
  __lookupAllForTests?: () => GetLarkCredentialsAllResult | Promise<GetLarkCredentialsAllResult>;
  __directRefreshForTests?: DirectLarkRefreshDependencies;
}

const DEFAULT_BATCH_REPORT_ENDPOINT = '/api/v1/feishu/lark-cli/credentials/batch';
const LARK_BATCH_MAX_ITEMS = 20;
const AGENTBUS_UPLOAD_TIMEOUT_MS = 60_000;

function isTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  if (error instanceof Error) {
    return (
      error.name === 'TimeoutError' || /aborted due to timeout|timed?\s*out/i.test(error.message)
    );
  }
  return false;
}

function splitBatchItems(items: LarkBatchItem[]): LarkBatchItem[][] {
  const batches: LarkBatchItem[][] = [];
  for (let index = 0; index < items.length; index += LARK_BATCH_MAX_ITEMS) {
    batches.push(items.slice(index, index + LARK_BATCH_MAX_ITEMS));
  }
  return batches;
}

/**
 * Canonical all-profile Lark credential batch report. This is the ONE
 * implementation shared by the long-lived telemetry worker and the CLI (via the
 * TSX worker bridge in bin/lib/larkSecrets.mjs). It enumerates every personal
 * lark-cli authorization, refreshes each, then batches the complete eligible set
 * to the AgentBus batch endpoint. It never logs plaintext secrets and never
 * throws to structured-return callers.
 */
export async function reportAllLarkCredentials(
  config: LarkBatchReportConfig
): Promise<LarkCredentialsReportStatus> {
  const now = new Date().toISOString();
  if (!config?.hermitHome) {
    return {
      ok: false,
      enabled: true,
      reason: 'config-disabled',
      message: 'hermitHome is required',
      lastAttemptAt: now,
      lastErrorAt: now,
    };
  }
  if (!isMac && !isWin)
    return disabledStatus(now, 'unsupported-platform', `不支持的平台: ${process.platform}`);
  if (config.enabled === false)
    return disabledStatus(now, 'config-disabled', 'lark credentials reporting disabled by config');

  let lookup: GetLarkCredentialsAllResult;
  try {
    lookup = config.__lookupAllForTests
      ? await config.__lookupAllForTests()
      : await getLarkCredentialsFreshAll(config.__directRefreshForTests);
  } catch (error) {
    lookup = { ok: false, message: sanitizeAuthError(error) };
  }
  if (!lookup.ok) {
    return {
      ok: false,
      enabled: true,
      reason: 'no-credentials',
      message: lookup.message,
      lastAttemptAt: now,
      lastErrorAt: now,
    };
  }

  const eligible = lookup.credentials.filter(meetsBatchFieldConstraints);
  const payload = buildLarkBatchPayload(eligible);
  if (payload.items.length === 0) {
    return {
      ok: false,
      enabled: true,
      reason: 'no-credentials',
      message: '无满足批量上报条件的 lark-cli 个人授权',
      accountCount: 0,
      accounts: [],
      lastAttemptAt: now,
      lastErrorAt: now,
    };
  }

  let ctx: AuthorizedServerContext | null = null;
  try {
    ctx = await config.resolveAuthedContext(config.hermitHome);
  } catch (err) {
    return {
      ok: false,
      enabled: true,
      reason: 'config-not-authorized',
      message: sanitizeAuthError(err),
      lastAttemptAt: now,
      lastErrorAt: now,
    };
  }
  if (!ctx)
    return {
      ok: false,
      enabled: true,
      reason: 'not-authorized',
      message: 'not logged in to agentbus — run `agentcli auth login`',
      lastAttemptAt: now,
      lastErrorAt: now,
    };

  const endpoint = `${ctx.baseUrl}${config.endpointPath || DEFAULT_BATCH_REPORT_ENDPOINT}`;
  const fetchImpl = config.fetchImpl ?? fetch;
  for (const items of splitBatchItems(payload.items)) {
    const batchPayload = { items };
    try {
      config.onPayload?.(batchPayload);
    } catch {
      /* observer errors are diagnostic only */
    }

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batchPayload),
        signal: AbortSignal.timeout(AGENTBUS_UPLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      return failureStatus(
        undefined,
        now,
        'fetch-failed',
        isTimeoutError(err)
          ? `AgentBus Lark 凭证上传超时（${AGENTBUS_UPLOAD_TIMEOUT_MS / 1000} 秒）`
          : sanitizeAuthError(err)
      );
    }
    if (!response.ok) {
      let body = '';
      try {
        body = (await response.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      return failureStatus(
        undefined,
        now,
        'http-error',
        `HTTP ${response.status}: ${sanitizeAuthError(body || response.statusText)}`,
        response.status
      );
    }
  }
  return {
    ok: true,
    enabled: true,
    lastAttemptAt: now,
    lastSuccessAt: now,
    accountCount: eligible.length,
    accounts: eligible.map((credential) => ({
      appId: credential.appId,
      userOpenId: credential.userOpenId,
      scope: credential.scope,
      accessTokenExpiresAt: credential.expiresAt,
      refreshTokenExpiresAt: credential.refreshExpiresAt,
    })),
  };
}

function sanitizeAuthError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Two passes: first scrub trailing tokens that ride along (Bearer abc..., a long
  // base64-url segment), THEN scrub key=value pairs. Reversed order leaves any
  // `[^\s]+`-non-attached token floating after "Authorization=[hidden]" because
  // the value group stops at whitespace — the prior keyword hadn't swallowed the
  // trailing base64 token it missed.
  return message
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1[hidden]')
    .replace(
      /(["']?(?:access_token|refresh_token|app_secret|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^"'\s,;&}]+)/gi,
      '$1[hidden]'
    )
    .slice(0, 500);
}

// Export the disk-read crypto layer for unit tests. The Keychain / DPAPI backends
// can't run on CI, but the decode/decrypt/discovery invariants CAN — these are
// the exact spots that previously drifted from bin/lib/larkSecrets.mjs.
export const __internals = {
  decodeMasterKey,
  decryptAesGcm,
  discoverProfilesMacCore,
  parseStoredToken,
  oauthEndpointForBrand,
  readMasterKeyFile,
  directRefreshLockPath,
  removeOrphanedRefreshLock,
  safeFileName,
  pickProfileNameByAppId,
  parseLarkCliJsonOutput,
};
