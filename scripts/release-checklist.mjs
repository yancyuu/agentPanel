#!/usr/bin/env node
/**
 * release-checklist.mjs
 *
 * Pre-publish reminders printed to stdout. Run before `pnpm publish` to catch
 * the easy-to-forget cc-connect mirror patch and version-pinning rules.
 *
 * Not a CI gate — just a human-in-the-loop checklist that surfaces the
 * non-obvious coupling between agentpanel's optionalDependencies and the
 * patches/cc-connect@x.y.z.patch file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));

console.log('— agentpanel release checklist —\n');

const ccPinned = pkg.optionalDependencies?.['cc-connect'];
console.log(`[1] cc-connect pinned version (optionalDependencies): ${ccPinned ?? '(missing!)'}`);

const patchVersion = pkg.pnpm?.patchedDependencies?.['cc-connect@' + ccPinned];
if (ccPinned && patchVersion) {
  console.log(`    ✓ mirror patch registered: ${patchVersion}`);
} else if (ccPinned) {
  console.log('    ✗ mirror patch MISSING — run: pnpm patch cc-connect');
  console.log('      (without the patch, install.js downloads the binary from');
  console.log('       raw GitHub, which fails for users behind the GFW/firewall)');
} else {
  console.log('    ✗ cc-connect not pinned in optionalDependencies');
}

const launchTimeout = process.env.HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS;
console.log(
  `\n[2] HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS override: ${launchTimeout ?? '(default 180000ms)'}`
);

console.log(`
[3] After publish, users on Windows/behind-firewall upgrade via:
      npm install -g @yancyyu/agentpanel@latest
    The cc-connect install.js will now fetch the binary through GitHub-release
    mirrors (gh-proxy.com, ghproxy.net), and a missing binary self-heals on
    next workbench open via the runtime downloader.

[4] Manual cross-platform smoke test (optional but recommended):
      rm -rf /tmp/hermit-test
      HERMIT_HOME=/tmp/hermit-test node bin/hermit.mjs --no-serve   # just boot + self-heal
      ls /tmp/hermit-test/cc-connect-bin/
`);
