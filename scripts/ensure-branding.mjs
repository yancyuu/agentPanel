/**
 * ensure-branding.mjs — seed repo-root branding.json when it is missing.
 *
 * branding.json is intentionally not committed to git (it is machine/runtime
 * specific). Without it, bin/branding.mjs falls back to DEFAULT_BRAND so the CLI
 * still boots, but writing the file makes the effective brand explicit and keeps
 * the auth/upload base URLs, npm package, and CLI command name discoverable.
 *
 * Run manually or from postinstall. Never overwrites an existing file.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_BRAND } from '../bin/branding.mjs';

export function ensureBranding(repoRoot) {
  const brandingPath = path.join(repoRoot, 'branding.json');
  if (existsSync(brandingPath)) {
    return { wrote: false, path: brandingPath, reason: 'already exists' };
  }
  writeFileSync(brandingPath, `${JSON.stringify(DEFAULT_BRAND, null, 2)}\n`, 'utf-8');
  return { wrote: true, path: brandingPath };
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const result = ensureBranding(repoRoot);
  if (result.wrote) {
    console.log(`[hermit] wrote default ${path.relative(repoRoot, result.path)}`);
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  await main();
}
