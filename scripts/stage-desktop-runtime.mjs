#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { access, chmod, cp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const stageRoot = path.join(root, 'desktop-runtime');
const runtimeRoot = path.join(stageRoot, 'agentcli');

async function removeSymbolicLinks(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        await rm(entryPath, { force: true });
      } else if (entry.isDirectory()) {
        await removeSymbolicLinks(entryPath);
      }
    })
  );
}

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });

execFileSync(
  'pnpm',
  ['--config.node-linker=hoisted', '--filter', '.', 'deploy', '--prod', '--legacy', runtimeRoot],
  {
    cwd: root,
    stdio: 'inherit',
  }
);

// Hoisted deploy uses the reviewed pnpm-lock graph and leaves only executable
// convenience links under node_modules/.bin. The packaged runtime calls concrete
// entry files, so remove those links rather than re-resolving dependencies with npm.
await removeSymbolicLinks(path.join(runtimeRoot, 'node_modules'));

const portableNativePackages = [
  '@mariozechner/clipboard@0.3.9',
  '@mariozechner/clipboard-darwin-arm64@0.3.9',
  '@mariozechner/clipboard-darwin-x64@0.3.9',
  '@mariozechner/clipboard-win32-x64-msvc@0.3.9',
  '@mariozechner/clipboard-win32-arm64-msvc@0.3.9',
  '@mariozechner/clipboard-linux-x64-gnu@0.3.9',
  '@mariozechner/clipboard-linux-arm64-gnu@0.3.9',
];
const portablePackageRoot = path.join(tmpdir(), 'agentcli-desktop-native-packages');
await rm(portablePackageRoot, { recursive: true, force: true });
await mkdir(portablePackageRoot, { recursive: true });
for (const packageSpec of portableNativePackages) {
  const packed = execFileSync(
    'npm',
    ['pack', packageSpec, '--pack-destination', portablePackageRoot, '--silent'],
    { cwd: root, encoding: 'utf8' }
  ).trim();
  const packageName = packageSpec.slice(0, packageSpec.lastIndexOf('@'));
  const target = path.join(runtimeRoot, 'node_modules', ...packageName.split('/'));
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  execFileSync(
    'tar',
    ['xzf', path.join(portablePackageRoot, packed), '--strip-components=1', '-C', target],
    { cwd: root, stdio: 'inherit' }
  );
}
await rm(portablePackageRoot, { recursive: true, force: true });

const workflowSource = path.join(root, 'src/main/services/system-manager/builtin-workflows');
const workflowTarget = path.join(runtimeRoot, 'dist', 'builtin-workflows');
await rm(workflowTarget, { recursive: true, force: true });
await cp(workflowSource, workflowTarget, { recursive: true });

await Promise.all([
  access(path.join(runtimeRoot, 'dist', 'server.bundle.mjs')),
  access(path.join(runtimeRoot, 'dist', 'telemetry-worker.bundle.mjs')),
  access(path.join(runtimeRoot, 'dist-renderer', 'index.html')),
  access(path.join(runtimeRoot, 'bin', 'agentcli.mjs')),
  access(path.join(runtimeRoot, 'node_modules', 'fastify', 'package.json')),
  access(
    path.join(runtimeRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
  ),
]);

const bundledBridgeTargets = [
  ['darwin-amd64', 'cc-connect'],
  ['darwin-arm64', 'cc-connect'],
  ['windows-amd64', 'cc-connect.exe'],
  ['windows-arm64', 'cc-connect.exe'],
  ['linux-amd64', 'cc-connect'],
  ['linux-arm64', 'cc-connect'],
];
for (const [target, binaryName] of bundledBridgeTargets) {
  const bundledBridge = path.join(runtimeRoot, 'vendor', 'cc-connect', target, binaryName);
  try {
    await access(bundledBridge);
    if (!target.startsWith('windows-')) await chmod(bundledBridge, 0o755);
  } catch {
    throw new Error(`[desktop:stage] missing bundled cc-connect binary for ${target}`);
  }
}

console.log(`desktop:stage -> ${path.relative(root, runtimeRoot)}`);
