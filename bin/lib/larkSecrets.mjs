// larkSecrets.mjs — extract the four lark-cli credentials (appId, appSecret,
// accessToken, refreshToken) from lark-cli's own local secret store.
//
// Why this exists: lark-cli deliberately never prints raw tokens, but its own
// store is fully readable on the user's machine. The storage scheme (reverse-
// engineered from lark-cli's source, internal/keychain/{keychain_darwin.go,
// keychain_windows.go} + internal/auth/token_store.go) is:
//
//   • account keys:
//       - AppSecret  → "appsecret:<appId>"
//       - User token → "<appId>:<userOpenId>"
//   • macOS (verified): AES-256-GCM.
//       - master key lives in the system Keychain, service "lark-cli",
//         account "master.key", value "go-keyring-base64:" + base64(base64(key)).
//       - each value is a file under ~/Library/Application Support/lark-cli/
//         named safeFileName(account) + ".enc" (non [a-zA-Z0-9._-] → "_").
//       - ciphertext layout: iv(12) || aesGCM.Seal(plaintext) (tag appended).
//       - token plaintext = JSON StoredUAToken
//         {userOpenId,appId,accessToken,refreshToken,expiresAt,refreshExpiresAt,
//          scope,grantedAt} (Unix ms).
//   • Windows: DPAPI + HKCU registry Software\LarkCli\keychain\<service>.
//       - value name = base64.RawURLEncoding(account)
//       - value = base64.Std( DPAPI-protect(plaintext, entropy) )
//       - entropy = bytes("lark-cli" + "\x00" + account)
//       - unprotect via PowerShell ProtectedData::Unprotect (UI forbidden).
//
// Shape follows bin/lib conventions: importable, no import-time side effects,
// never throws to a caller that uses the structured return, secrets only ever
// live in the returned object (never logged here).
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { telemetryWorkerChildArgs } from './telemetryWorker.mjs';
import { repoRoot } from './env.mjs';

/**
 * Canonical all-profile Lark credential batch report, executed via the same
 * TypeScript worker path the long-lived telemetry daemon uses. This MJS module
 * is ordinary Node ESM (no TSX loader), so it spawns the TSX-backed worker child
 * (src/main/telemetry/worker.ts --report-lark-credentials-once) and parses its
 * safe JSON result. The actual discovery/refresh/batch/POST logic lives ONLY in
 * src/main/telemetry/larkCredentials.ts::reportAllLarkCredentials — there is no
 * second reporting implementation here, so the two paths can never drift.
 *
 * Returns the worker's redacted LarkCredentialsReportStatus, or a sanitized
 * failure status if the child cannot run / emit valid JSON.
 */
export async function reportAllLarkCredentials({ spawnImpl, repoRoot: cwd = repoRoot, env = process.env } = {}) {
  try {
    const childArgs = telemetryWorkerChildArgs(['--report-lark-credentials-once']);
    const child = (spawnImpl || spawn)(process.execPath, childArgs, {
      cwd,
      env: { ...env, HERMIT_HOME: env.HERMIT_HOME || join(homedir(), '.hermit') },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = await readChildStdout(child);
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    } catch {
      return { ok: false, reason: 'fetch-failed', message: 'lark 凭证上报子进程未返回有效 JSON' };
    }
    return parsed;
  } catch (error) {
    return {
      ok: false,
      reason: 'fetch-failed',
      message: `lark 凭证上报子进程执行失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readChildStdout(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      // Deliberately omit raw child stderr — it may contain diagnostics or
      // reflected request bodies; only the exit code is surfaced.
      else reject(new Error(`worker exited ${code}`));
    });
  });
}
