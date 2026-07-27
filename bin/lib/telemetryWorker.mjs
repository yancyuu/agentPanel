// telemetryWorker.mjs — Worker spawning utilities used by both hermit.mjs
// (__telemetry-worker command entry) and usageCommand.mjs.
// Keeps the require() call isolated so other modules stay pure ESM.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { env } from 'node:process';
import { binDir } from './env.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.join(binDir, '..');

export function telemetryWorkerChildArgs(extraArgs = []) {
  // Prefer the precompiled bundle (no tsx, no alias-loader) when present —
  // matches bin/hermit.mjs's server spawn. Falls back to tsx for dev.
  const workerBundle = path.join(repoRoot, 'dist', 'telemetry-worker.bundle.mjs');
  if (existsSync(workerBundle)) {
    return [workerBundle, ...extraArgs];
  }
  const tsxPath = pathToFileURL(require.resolve('tsx')).href;
  const aliasLoaderUrl = pathToFileURL(path.join(binDir, 'alias-loader.mjs')).href;
  // IMPORTANT: the parentURL passed to register() must be a fully-resolved file
  // URL, NOT pathToFileURL("./"). On Windows the relative "./" resolves against
  // an indeterminate base (cwd vs. main module URL) depending on Node version,
  // and the custom resolver silently fails to engage — every module alias
  // (@main/, @shared/, …) then ERR_MODULE_NOT_FOUND's at worker boot, which is
  // the root cause of "all Windows users fail lark-credential upload".
  // Passing the alias-loader's own URL anchors the registration reliably.
  const aliasLoader = `data:text/javascript,import { register } from "node:module"; register(${JSON.stringify(aliasLoaderUrl)}, ${JSON.stringify(aliasLoaderUrl)});`;
  return [
    '--import',
    aliasLoader,
    '--import',
    tsxPath,
    'src/main/telemetry/worker.ts',
    ...extraArgs,
  ];
}
