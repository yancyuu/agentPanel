/**
 * 员工产物库读取路由：解析 workDir 的 openspec 项目，
 * 返回 living specs 列表与最近沉淀记录（均为只读）。
 * 读取前幂等补建 openspec 骨架（存量团队回填路径）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { AssetArchiveEntry, AssetSpecEntry, TeamAssetsResponse } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

interface TeamAssetRouteDependencies {
  readTeamManifest(
    teamName: string
  ): Promise<{ slug: string; workDir?: string; deletedAt?: string; harness?: string }>;
  /** 幂等补建 openspec 骨架（存量团队）；失败不阻塞读取 */
  ensureAssetsProject?(workDir: string, harness?: string): Promise<void>;
  reply500(error: unknown): { ok: false; error: string };
}

const SPEC_OPERATION_PATTERN = /^## (ADDED|MODIFIED|REMOVED|RENAMED)\b/gm;

async function listSubDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function extractTitle(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() || fallback;
}

async function newestMtimeMs(dir: string): Promise<number> {
  let newest = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const stat = await fs.stat(path.join(dir, entry)).catch(() => null);
    if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

async function readSpecs(specsDir: string): Promise<AssetSpecEntry[]> {
  const ids = await listSubDirs(specsDir);
  const specs: AssetSpecEntry[] = [];
  for (const id of ids) {
    const specDir = path.join(specsDir, id);
    const specFile = path.join(specDir, 'spec.md');
    let title = id;
    try {
      title = extractTitle(await fs.readFile(specFile, 'utf8'), id);
    } catch {
      // 无 spec.md 时用目录名
    }
    const mtimeMs = await newestMtimeMs(specDir);
    specs.push({
      id,
      title,
      updatedAt: mtimeMs > 0 ? new Date(mtimeMs).toISOString() : '',
    });
  }
  return specs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

async function readArchives(archiveDir: string): Promise<AssetArchiveEntry[]> {
  const ids = await listSubDirs(archiveDir);
  const archives: AssetArchiveEntry[] = [];
  for (const id of ids) {
    const changeDir = path.join(archiveDir, id);
    const operations = new Set<string>();
    const files = await listMarkdownFiles(changeDir);
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf8');
        for (const match of content.matchAll(SPEC_OPERATION_PATTERN)) {
          if (match[1]) operations.add(match[1]);
        }
      } catch {
        // 忽略不可读文件
      }
    }
    const mtimeMs = await newestMtimeMs(changeDir);
    archives.push({
      id,
      archivedAt: mtimeMs > 0 ? new Date(mtimeMs).toISOString() : '',
      operations: [...operations],
    });
  }
  return archives.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

export function registerTeamAssetRoutes(
  app: FastifyInstance,
  dependencies: TeamAssetRouteDependencies
): void {
  app.get<{ Params: { name: string } }>('/api/teams/:name/assets', async (request, reply) => {
    try {
      const manifest = await dependencies.readTeamManifest(request.params.name);
      if (manifest.deletedAt) return reply.code(404).send({ ok: false, error: 'team not found' });
      const workDir = manifest.workDir?.trim();
      if (!workDir) return reply.code(404).send({ ok: false, error: 'team workDir not found' });

      // 存量团队幂等补建（首次读取产物库即回填骨架）
      await dependencies.ensureAssetsProject?.(workDir, manifest.harness).catch(() => undefined);

      const openspecDir = path.join(workDir, 'openspec');
      const [specs, archives] = await Promise.all([
        readSpecs(path.join(openspecDir, 'specs')),
        // openspec CLI 的归档目录是 changes/archive/
        readArchives(path.join(openspecDir, 'changes', 'archive')),
      ]);
      const response: TeamAssetsResponse = { ok: true, specs, archives };
      return response;
    } catch (error) {
      return reply.code(500).send(dependencies.reply500(error));
    }
  });
}
