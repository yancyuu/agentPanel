import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALIASES = [
  ['@features/', 'src/features/'],
  ['@main/', 'src/main/'],
  ['@renderer/', 'src/renderer/'],
  ['@shared/', 'src/shared/'],
];

const EXACT_ALIASES = new Map([
  ['@shared/types', 'src/shared/types/index.ts'],
  ['@main/types', 'src/main/types/index.ts'],
]);

function resolveAlias(specifier) {
  const exactTarget = EXACT_ALIASES.get(specifier);
  if (exactTarget) {
    const absolutePath = path.join(repoRoot, exactTarget);
    if (existsSync(absolutePath)) return pathToFileURL(absolutePath).href;
  }

  for (const [prefix, target] of ALIASES) {
    if (!specifier.startsWith(prefix)) continue;
    const relativePath = specifier.slice(prefix.length);
    const basePath = path.join(repoRoot, target, relativePath);
    const candidates = [
      basePath,
      `${basePath}.ts`,
      `${basePath}.tsx`,
      `${basePath}.js`,
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
      path.join(basePath, 'index.js'),
    ];
    const match = candidates.find((candidate) => existsSync(candidate));
    if (match) return pathToFileURL(match).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const aliasUrl = resolveAlias(specifier);
  if (aliasUrl) {
    return { url: aliasUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
