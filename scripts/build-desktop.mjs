#!/usr/bin/env node

import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outputDirectory = path.join(root, 'dist-desktop-main');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/desktop/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(outputDirectory, 'main.cjs'),
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
});

console.log('build:desktop -> dist-desktop-main/main.cjs');
