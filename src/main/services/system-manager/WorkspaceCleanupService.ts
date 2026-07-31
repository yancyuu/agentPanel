import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  CleanupCandidate,
  CleanupCandidateCategory,
  CleanupExecutionResult,
  CleanupScanResult,
} from '@shared/types/systemManager';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SIZE_SCAN_ENTRIES = 30_000;
const PROJECT_CACHE_PATHS = [
  '.cache',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '.eslintcache',
  '.stylelintcache',
  path.join('.next', 'cache'),
  path.join('node_modules', '.cache'),
  path.join('coverage', '.cache'),
] as const;
const TEMP_PREFIXES = ['agentcli-', 'hermit-', 'openhermit-', 'pi-subagents-'] as const;

interface WorkspaceCleanupServiceOptions {
  hermitHome: string;
  tempRoot?: string;
  homeDir?: string;
  now?: () => number;
}

interface MeasuredPath {
  sizeBytes: number;
  itemCount: number;
}

function categoryLabel(category: CleanupCandidateCategory): string {
  switch (category) {
    case 'application-temp':
      return '应用临时文件';
    case 'old-logs':
      return '过期运行日志';
    case 'project-cache':
      return '项目缓存';
    case 'system-junk':
      return '系统杂项';
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function measurePath(target: string): Promise<MeasuredPath> {
  const root = await lstat(target);
  if (root.isSymbolicLink()) return { sizeBytes: 0, itemCount: 0 };
  if (!root.isDirectory()) return { sizeBytes: root.size, itemCount: 1 };
  let sizeBytes = 0;
  let itemCount = 1;
  const pending = [target];
  while (pending.length > 0 && itemCount < MAX_SIZE_SCAN_ENTRIES) {
    const directory = pending.pop();
    if (!directory) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (itemCount >= MAX_SIZE_SCAN_ENTRIES) break;
      const entryPath = path.join(directory, entry.name);
      let info;
      try {
        info = await lstat(entryPath);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      itemCount += 1;
      if (info.isDirectory()) pending.push(entryPath);
      else sizeBytes += info.size;
    }
  }
  return { sizeBytes, itemCount };
}

export class WorkspaceCleanupService {
  private readonly hermitHome: string;
  private readonly tempRoot: string;
  private readonly homeDir: string;
  private readonly now: () => number;

  constructor(options: WorkspaceCleanupServiceOptions) {
    this.hermitHome = path.resolve(options.hermitHome);
    this.tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
    this.homeDir = path.resolve(options.homeDir ?? os.homedir());
    this.now = options.now ?? Date.now;
  }

  async scan(selectedWorkDir?: string): Promise<CleanupScanResult> {
    const candidates: CleanupCandidate[] = [];
    const warnings: string[] = [];
    const workspaces = await this.readManagedWorkspaces(selectedWorkDir, warnings);

    for (const workspace of workspaces) {
      for (const relativePath of PROJECT_CACHE_PATHS) {
        await this.addCandidate(candidates, {
          target: path.join(workspace, relativePath),
          allowedRoot: workspace,
          category: 'project-cache',
          reason: '可重新生成的工具缓存',
        });
      }
      let rootEntries;
      try {
        rootEntries = await readdir(workspace, { withFileTypes: true });
      } catch {
        warnings.push(`无法读取工作区：${this.displayPath(workspace)}`);
        continue;
      }
      for (const entry of rootEntries) {
        if (!entry.isFile()) continue;
        const lowerName = entry.name.toLowerCase();
        const knownJunk =
          lowerName === '.ds_store' ||
          lowerName === 'npm-debug.log' ||
          lowerName === 'yarn-error.log' ||
          lowerName === 'pnpm-debug.log' ||
          lowerName.endsWith('.tmp');
        if (!knownJunk) continue;
        await this.addCandidate(candidates, {
          target: path.join(workspace, entry.name),
          allowedRoot: workspace,
          category: 'system-junk',
          reason: '不影响项目内容的临时或系统文件',
          minimumAgeMs: lowerName === '.ds_store' ? 0 : 3 * DAY_MS,
        });
      }
    }

    await this.scanOldChildren(
      candidates,
      path.join(this.hermitHome, 'logs'),
      'old-logs',
      14 * DAY_MS
    );
    await this.scanOldChildren(
      candidates,
      path.join(this.hermitHome, 'tmp'),
      'application-temp',
      DAY_MS
    );
    await this.scanOldChildren(
      candidates,
      path.join(this.hermitHome, 'cache'),
      'application-temp',
      DAY_MS
    );
    await this.scanNamedTempEntries(candidates);

    candidates.sort((left, right) => right.sizeBytes - left.sizeBytes);
    return {
      scannedAt: new Date(this.now()).toISOString(),
      candidates,
      totalBytes: candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
      totalItems: candidates.reduce((sum, candidate) => sum + candidate.itemCount, 0),
      scannedWorkspaces: workspaces.size,
      warnings,
    };
  }

  async clean(ids: string[], selectedWorkDir?: string): Promise<CleanupExecutionResult> {
    const uniqueIds = [...new Set(ids)].slice(0, 1_000);
    const scan = await this.scan(selectedWorkDir);
    const candidatesById = new Map(scan.candidates.map((candidate) => [candidate.id, candidate]));
    const removedIds: string[] = [];
    const failed: { id: string; error: string }[] = [];
    let freedBytes = 0;

    for (const id of uniqueIds) {
      const candidate = candidatesById.get(id);
      if (!candidate) {
        failed.push({ id, error: '项目已变化或不在安全清理范围内' });
        continue;
      }
      try {
        const info = await lstat(candidate.path);
        if (info.isSymbolicLink()) throw new Error('符号链接不会自动清理');
        await rm(candidate.path, { recursive: info.isDirectory(), force: true });
        removedIds.push(id);
        freedBytes += candidate.sizeBytes;
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : '清理失败' });
      }
    }

    return {
      cleanedAt: new Date(this.now()).toISOString(),
      removedIds,
      failed,
      freedBytes,
      remaining: await this.scan(selectedWorkDir),
    };
  }

  private async readManagedWorkspaces(
    selectedWorkDir: string | undefined,
    warnings: string[]
  ): Promise<Set<string>> {
    const result = new Set<string>();
    if (selectedWorkDir) result.add(path.resolve(selectedWorkDir));
    const teamsRoot = path.join(this.hermitHome, 'teams');
    let teamEntries;
    try {
      teamEntries = await readdir(teamsRoot, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const entry of teamEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.archived-')) continue;
      const configPath = path.join(teamsRoot, entry.name, 'team.json');
      try {
        const config = JSON.parse(await readFile(configPath, 'utf8')) as {
          workDir?: unknown;
          projectPath?: unknown;
        };
        for (const value of [config.workDir, config.projectPath]) {
          if (typeof value === 'string' && path.isAbsolute(value)) result.add(path.resolve(value));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          warnings.push(`无法读取智能体目录配置：${entry.name}`);
        }
      }
    }
    return result;
  }

  private async scanOldChildren(
    candidates: CleanupCandidate[],
    root: string,
    category: CleanupCandidateCategory,
    minimumAgeMs: number
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      await this.addCandidate(candidates, {
        target: path.join(root, entry.name),
        allowedRoot: root,
        category,
        reason: category === 'old-logs' ? '超过 14 天的运行日志' : '超过 24 小时的应用临时文件',
        minimumAgeMs,
      });
    }
  }

  private async scanNamedTempEntries(candidates: CleanupCandidate[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.tempRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
      await this.addCandidate(candidates, {
        target: path.join(this.tempRoot, entry.name),
        allowedRoot: this.tempRoot,
        category: 'application-temp',
        reason: '超过 24 小时的 AgentCLI 临时文件',
        minimumAgeMs: DAY_MS,
      });
    }
  }

  private async addCandidate(
    candidates: CleanupCandidate[],
    input: {
      target: string;
      allowedRoot: string;
      category: CleanupCandidateCategory;
      reason: string;
      minimumAgeMs?: number;
    }
  ): Promise<void> {
    const target = path.resolve(input.target);
    if (!isInside(input.allowedRoot, target)) return;
    let info;
    try {
      info = await lstat(target);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) return;
    if (input.minimumAgeMs && this.now() - info.mtimeMs < input.minimumAgeMs) return;
    const measured = await measurePath(target);
    if (measured.itemCount === 0) return;
    const category = input.category;
    candidates.push({
      id: createHash('sha256').update(`${category}:${target}`).digest('hex').slice(0, 24),
      category,
      categoryLabel: categoryLabel(category),
      name: path.basename(target),
      path: target,
      displayPath: this.displayPath(target),
      kind: info.isDirectory() ? 'directory' : 'file',
      sizeBytes: measured.sizeBytes,
      itemCount: measured.itemCount,
      modifiedAt: info.mtime.toISOString(),
      reason: input.reason,
      selectedByDefault: true,
    });
  }

  private displayPath(target: string): string {
    return target === this.homeDir || target.startsWith(`${this.homeDir}${path.sep}`)
      ? `~${target.slice(this.homeDir.length)}`
      : target;
  }
}
