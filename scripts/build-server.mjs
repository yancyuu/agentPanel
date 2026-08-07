#!/usr/bin/env node
// scripts/build-server.mjs
//
// Precompile the TypeScript server (src/main/server.ts) into a single ESM
// bundle so production boots with plain `node` — no `tsx`, no runtime
// `alias-loader`. This removes runtime TS->JS transpilation from the cold-start
// path (the root cause of slow cold starts: ~40k lines re-transpiled every boot).
//
// Strategy: bundle ONLY the project's own TypeScript (src/, packages/); keep
// node_modules deps EXTERNAL via `packages: 'external'`. Dependencies already
// ship as JS and load fast — the slow part was transpiling our own TS, which
// this step does once at build time.
//
// Output: dist/server.bundle.mjs — run with `node dist/server.bundle.mjs`.
// ESM is required (not CJS) because server.ts uses top-level await and
// import.meta.url, neither of which CJS supports.
// (dev stays on `tsx watch src/main/server.ts`; see bin/hermit.mjs which prefers
// the bundle when present and falls back to tsx otherwise.)

import { build } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// --standalone: bundle ALL deps (including node_modules) into one file, for
// Node SEA injection (a standalone .exe with no Node / no node_modules).
// Without the flag: keep node_modules EXTERNAL (npm package already ships them).
const standalone = process.argv.includes('--standalone');

// Mirror tsconfig.json `paths` for bare-specifier aliases. esbuild does not read
// tsconfig `paths` for bare imports, so we resolve them here.
const aliasPrefixes = [
  [/^@main\//, path.join(root, 'src/main/')],
  [/^@shared\//, path.join(root, 'src/shared/')],
  [/^@features\//, path.join(root, 'src/features/')],
  [/^@renderer\//, path.join(root, 'src/renderer/')],
];
const aliasExact = {
  '@claude-teams/agent-graph': path.join(root, 'packages/agent-graph/src/index.ts'),
};
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.json'];

function resolveWithExtension(candidate) {
  if (path.extname(candidate) && existsSync(candidate)) return candidate;
  for (const ext of extensions) {
    if (existsSync(candidate + ext)) return candidate + ext;
  }
  for (const ext of extensions) {
    if (existsSync(path.join(candidate, 'index' + ext))) return path.join(candidate, 'index' + ext);
  }
  return null;
}

const aliasPlugin = {
  name: 'tsconfig-aliases',
  setup(build) {
    // Only intercept our own @-prefixed aliases; defer everything else.
    build.onResolve({ filter: /^@/ }, (args) => {
      let candidate = null;
      if (aliasExact[args.path]) {
        candidate = aliasExact[args.path];
      } else {
        for (const [re, base] of aliasPrefixes) {
          if (re.test(args.path)) {
            candidate = path.join(base, args.path.replace(re, ''));
            break;
          }
        }
      }
      if (!candidate) return undefined; // not ours — let esbuild resolve normally
      const resolved = resolveWithExtension(candidate);
      if (!resolved) {
        return { errors: [{ text: `Could not resolve alias ${args.path} -> ${candidate}` }] };
      }
      return { path: resolved };
    });
  },
};

mkdirSync(path.join(root, 'dist'), { recursive: true });

const entries = [
  { in: 'src/main/server.ts', out: standalone ? 'server.standalone.mjs' : 'server.bundle.mjs' },
  {
    in: 'src/main/telemetry/worker.ts',
    out: standalone ? 'telemetry-worker.standalone.mjs' : 'telemetry-worker.bundle.mjs',
  },
];

try {
  let warnings = 0;
  for (const e of entries) {
    const result = await build({
      entryPoints: [path.join(root, e.in)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      packages: standalone ? undefined : 'external', // external for npm pkg; bundle-all for SEA
      sourcemap: true,
      outfile: path.join(root, 'dist/' + e.out),
      logLevel: 'info',
      plugins: [aliasPlugin],
    });
    warnings += result.warnings.length;
    console.log('build:server -> dist/' + e.out + (standalone ? ' (standalone)' : ''));
  }
  if (warnings) console.warn(`build:server completed with ${warnings} warning(s) total`);
} catch (err) {
  console.error('build:server failed:', err.message);
  process.exit(1);
}
