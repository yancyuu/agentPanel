import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decodePath, getProjectsBasePath } from '@main/utils/pathDecoder';

import type {
  RecentProjectsSourcePayload,
  RecentProjectsSourcePort,
} from '../../core/application/ports/RecentProjectsSourcePort';
import type { RecentProjectCandidate } from '../../core/domain/models/RecentProjectCandidate';

const DEFAULT_MAX_DEPTH = 5;
const SKIPPED_DIRS = new Set([
  '.cache',
  '.git',
  '.hg',
  '.next',
  '.pnpm-store',
  '.svn',
  '.turbo',
  'Library',
  'Applications',
  'Desktop',
  'Documents',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'build',
  'coverage',
  'dist',
  'dist-electron',
  'dist-renderer',
  'dist-standalone',
  'node_modules',
  'target',
]);

interface LocalClaudeProjectSourceOptions {
  roots: string[];
  maxDepth?: number;
  includeClaudeSessionProjects?: boolean;
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function canonicalPath(dirPath: string): Promise<string> {
  try {
    return await realpath(dirPath);
  } catch {
    return path.resolve(dirPath);
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const normalized = path.resolve(item);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function shouldSkipDirectory(name: string): boolean {
  if (name === '.claude') return true;
  if (SKIPPED_DIRS.has(name)) return true;
  return name.startsWith('.') && name !== '..';
}

function projectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

async function projectActivity(projectPath: string, claudeDir: string): Promise<number> {
  const stats = await Promise.allSettled([stat(projectPath), stat(claudeDir)]);
  return Math.max(
    ...stats.map((result) => (result.status === 'fulfilled' ? result.value.mtimeMs : 0)),
    1
  );
}

function buildCandidate(projectPath: string, lastActivityAt: number): RecentProjectCandidate {
  return {
    identity: `local:${projectPath}`,
    displayName: projectName(projectPath),
    primaryPath: projectPath,
    associatedPaths: [projectPath],
    lastActivityAt,
    providerIds: ['anthropic'],
    sourceKind: 'claude',
    openTarget: {
      type: 'synthetic-path',
      path: projectPath,
    },
  };
}

async function listClaudeSessionProjectRoots(): Promise<string[]> {
  const projectsBase = getProjectsBasePath();
  let entries;
  try {
    entries = await readdir(projectsBase, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => decodePath(entry.name))
    .filter((candidate) => path.isAbsolute(candidate));
}

export function buildDefaultLocalClaudeProjectRoots(extraRoots: string[] = []): string[] {
  const home = os.homedir();
  return uniquePaths([
    path.join(home, 'code'),
    path.join(home, 'Code'),
    path.join(home, 'projects'),
    path.join(home, 'Projects'),
    path.join(home, '.hermit'),
    ...extraRoots,
  ]);
}

export class LocalClaudeProjectSource implements RecentProjectsSourcePort {
  readonly sourceId = 'local-claude-projects';
  readonly timeoutMs = 3_000;

  constructor(private readonly options: LocalClaudeProjectSourceOptions) {}

  async list(): Promise<RecentProjectsSourcePayload> {
    const roots = uniquePaths([
      ...this.options.roots,
      ...(this.options.includeClaudeSessionProjects ? await listClaudeSessionProjectRoots() : []),
    ]);
    const candidates = new Map<string, RecentProjectCandidate>();
    let degraded = false;

    for (const root of roots) {
      try {
        await this.scanRoot(root, candidates);
      } catch {
        degraded = true;
      }
    }

    return {
      candidates: Array.from(candidates.values()).sort(
        (left, right) => right.lastActivityAt - left.lastActivityAt
      ),
      degraded,
    };
  }

  private async scanRoot(
    root: string,
    candidates: Map<string, RecentProjectCandidate>
  ): Promise<void> {
    if (!(await isDirectory(root))) return;

    const maxDepth = this.options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const pending: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

    while (pending.length > 0) {
      const current = pending.shift();
      if (!current) continue;

      const entries = await readdir(current.dir, { withFileTypes: true });
      const hasClaudeDir = entries.some((entry) => entry.isDirectory() && entry.name === '.claude');
      if (hasClaudeDir) {
        const projectPath = await canonicalPath(current.dir);
        if (!candidates.has(projectPath)) {
          const claudeDir = path.join(projectPath, '.claude');
          candidates.set(
            projectPath,
            buildCandidate(projectPath, await projectActivity(projectPath, claudeDir))
          );
        }
      }

      if (current.depth >= maxDepth) continue;

      for (const entry of entries) {
        if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) continue;
        pending.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
}
