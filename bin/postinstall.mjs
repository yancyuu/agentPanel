#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRAND, brandCommand, brandLogPrefix } from './branding.mjs';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let version = 'unknown';
try {
  version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')).version;
} catch {
  // Keep install non-blocking.
}

let runtimeVersion = 'bundled';
try {
  runtimeVersion = JSON.parse(readFileSync(require.resolve('cc-connect/package.json'), 'utf-8')).version;
} catch {
  // Keep install non-blocking.
}

const hermitHome = process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit');

// cc-connect is the current canonical dir; hermit-bridge is the pre-rename
// legacy name (configs/data migrated forward by migrateLegacyHermitBridgeFiles).
const legacyRuntimeBridgeDir = path.join(hermitHome, 'hermit-bridge');
const ccConnectDir = path.join(hermitHome, 'cc-connect');
const legacyRuntimeBridgeConfigPath = path.join(legacyRuntimeBridgeDir, 'config.toml');
const ccConnectConfigPath = path.join(ccConnectDir, 'config.toml');
const legacyRuntimeBridgeDataDir = path.join(legacyRuntimeBridgeDir, 'data');
const ccConnectDataDir = path.join(ccConnectDir, 'data');
const bundledWorkflowsDir = path.join(packageRoot, 'src/main/services/system-manager/builtin-workflows');
const hermitWorkflowDir = path.join(hermitHome, '.claude', 'workflow');
const builtinWorkflowMarker = '<!-- hermit-builtin-workflow:v2-loop -->';

function normalizeHermitBridgeConfig(raw) {
  return raw
    .split(legacyRuntimeBridgeDataDir)
    .join(ccConnectDataDir)
    .split('~/.hermit/hermit-bridge/data')
    .join(`~/.hermit/cc-connect/data`);
}

function seedBuiltinWorkflows() {
  if (!existsSync(bundledWorkflowsDir)) return { copied: 0, refreshed: 0, skipped: 0 };
  mkdirSync(hermitWorkflowDir, { recursive: true });
  let copied = 0;
  let refreshed = 0;
  let skipped = 0;

  for (const filename of readdirSync(bundledWorkflowsDir)) {
    if (!filename.endsWith('.md') && !filename.endsWith('.js')) continue;
    const sourcePath = path.join(bundledWorkflowsDir, filename);
    const targetPath = path.join(hermitWorkflowDir, filename);
    const bundled = readFileSync(sourcePath, 'utf-8');

    if (!existsSync(targetPath)) {
      writeFileSync(targetPath, bundled, 'utf-8');
      copied += 1;
      continue;
    }

    const existing = readFileSync(targetPath, 'utf-8');
    if (!existing.includes(builtinWorkflowMarker)) {
      skipped += 1;
      continue;
    }
    if (existing !== bundled) {
      writeFileSync(targetPath, bundled, 'utf-8');
      refreshed += 1;
    }
  }

  return { copied, refreshed, skipped };
}

function migrateLegacyHermitBridgeFiles() {
  mkdirSync(ccConnectDir, { recursive: true });
  let changed = false;
  if (!existsSync(ccConnectDataDir) && existsSync(legacyRuntimeBridgeDataDir)) {
    try {
      renameSync(legacyRuntimeBridgeDataDir, ccConnectDataDir);
    } catch {
      cpSync(legacyRuntimeBridgeDataDir, ccConnectDataDir, { recursive: true });
      rmSync(legacyRuntimeBridgeDataDir, { recursive: true, force: true });
    }
    changed = true;
  }

  if (!existsSync(ccConnectConfigPath) && existsSync(legacyRuntimeBridgeConfigPath)) {
    copyFileSync(legacyRuntimeBridgeConfigPath, ccConnectConfigPath);
    rmSync(legacyRuntimeBridgeConfigPath, { force: true });
    changed = true;
  }
  if (existsSync(ccConnectConfigPath)) {
    const raw = readFileSync(ccConnectConfigPath, 'utf-8');
    const migrated = normalizeHermitBridgeConfig(raw);
    if (migrated !== raw) {
      writeFileSync(ccConnectConfigPath, migrated, 'utf-8');
      changed = true;
    }
  }
  // Best-effort: remove the now-empty legacy dir if everything was migrated.
  try {
    if (existsSync(legacyRuntimeBridgeDir) && !existsSync(legacyRuntimeBridgeConfigPath) && !existsSync(legacyRuntimeBridgeDataDir)) {
      rmSync(legacyRuntimeBridgeDir, { recursive: true, force: true });
    }
  } catch {
    /* non-fatal */
  }
  return changed;
}

const migratedRuntimeConfig = migrateLegacyHermitBridgeFiles();

// Patch the bundled cc-connect's install.js so its GitHub-Release binary
// download goes through mirrors. IMPORTANT: pnpm's patchedDependencies only
// applies when THIS package is installed via pnpm; the majority of users
// install with `npm install -g`, for which pnpm patches never run. Applying
// the mirror rewrite here inside agentpanel's own postinstall covers BOTH npm
// and pnpm users. Idempotent and best-effort: failures never block install.
function patchCcConnectInstaller() {
  let installJsPath;
  try {
    const pkgRoot = path.dirname(require.resolve('cc-connect/package.json'));
    installJsPath = path.join(pkgRoot, 'install.js');
  } catch {
    return { applied: false, reason: 'cc-connect not installed (optional dep skipped)' };
  }
  if (!existsSync(installJsPath)) {
    return { applied: false, reason: `install.js missing at ${installJsPath}` };
  }
  let src;
  try {
    src = readFileSync(installJsPath, 'utf-8');
  } catch (err) {
    return { applied: false, reason: `read failed: ${err.message}` };
  }
  // Idempotency: skip if an earlier agentpanel postinstall already patched it.
  if (src.includes('Patched by @yancyyu/agentpanel')) {
    return { applied: false, reason: 'already patched', already: true };
  }
  // The original returns a 2-element array of github/gitee URLs. Replace just
  // that return with a mirror-prepended list, mirroring the pnpm patch.
  const marker = '  return [';
  const idx = src.indexOf(marker);
  if (idx === -1) {
    return { applied: false, reason: 'install.js structure changed; cannot locate getDownloadURLs return' };
  }
  const before = src.slice(0, idx);
  const after = src.slice(idx);
  const replacement =
    '  const github = `https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/${filename}`;\n' +
    '  const gitee = `https://gitee.com/${GITEE_REPO}/releases/download/${VERSION}/${filename}`;\n' +
    '  // Patched by @yancyyu/agentpanel: prepend GitHub-release mirror prefixes so the\n' +
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
  // Find the closing `];` of the original return array.
  const closeIdx = after.indexOf('];');
  if (closeIdx === -1) {
    return { applied: false, reason: 'install.js structure changed; cannot locate return array close' };
  }
  const patched = before + replacement + after.slice(closeIdx + 2);
  try {
    writeFileSync(installJsPath, patched, 'utf-8');
    return { applied: true };
  } catch (err) {
    return { applied: false, reason: `write failed: ${err.message}` };
  }
}

const ccInstallPatchResult = patchCcConnectInstaller();

let seededWorkflows = { copied: 0, refreshed: 0, skipped: 0 };
let workflowSeedError = null;
try {
  seededWorkflows = seedBuiltinWorkflows();
} catch (err) {
  workflowSeedError = err;
}

console.log(`${brandLogPrefix()} Installed ${version}`);
console.log(`${brandLogPrefix()} Bundled ${BRAND.runtimeBridgeName} runtime service: ${runtimeVersion}`);
console.log(`${brandLogPrefix()} Data directory: ${hermitHome}`);
if (migratedRuntimeConfig) console.log(`${brandLogPrefix()} Migrated runtime files to ~/${BRAND.defaultLocalHomeName}/${BRAND.runtimeBridgeName}/`);
if (ccInstallPatchResult.applied) {
  console.log(`${brandLogPrefix()} Patched cc-connect installer to use mirror downloads`);
} else if (!ccInstallPatchResult.already) {
  console.log(`${brandLogPrefix()} cc-connect installer mirror-patch skipped: ${ccInstallPatchResult.reason}`);
}
if (workflowSeedError) {
  console.log(`${brandLogPrefix()} Skipped workflow installation: ${workflowSeedError.message ?? String(workflowSeedError)}`);
} else {
  const changedWorkflows = seededWorkflows.copied + seededWorkflows.refreshed;
  console.log(
    `${brandLogPrefix()} Installed ${changedWorkflows} workflow(s) to ${hermitWorkflowDir}` +
      (seededWorkflows.skipped ? `; skipped ${seededWorkflows.skipped} user-managed file(s)` : '')
  );
}
console.log(`${brandLogPrefix()} Start with: ${brandCommand()}`);
console.log(`${brandLogPrefix()} Background mode: ${brandCommand('--daemon')}`);
