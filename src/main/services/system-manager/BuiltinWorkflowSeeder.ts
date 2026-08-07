/**
 * Hermit Workflow 文件源 + 扫描器。
 *
 * 内置 workflow 以 markdown prompt 或 JavaScript 动态 workflow 随包分发在
 * ./builtin-workflows/*.{md,js}。启动时由 ensureGlobalWorkflows() 把 bundled 源复制到
 * ~/.hermit/.claude/workflow/，运行时由 scanHermitWorkflows() 扫描该目录得到。
 *
 * 这些 workflow 不再作为 Claude Code slash 命令（不再 seed 到 ~/.claude/commands/hermit/），
 * 只通过能力包（capability pack）暴露给 AI。
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '@shared/utils/logger';
import YAML from 'yaml';

import type { WorkflowPromptSafety } from '@shared/types/systemManager';

const logger = createLogger('HermitWorkflows');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuiltinWorkflowDefinition {
  id: string;
  filename: string;
  commandName: `/${string}`;
  label: string;
  description: string;
  category:
    | 'overview'
    | 'health'
    | 'improvement'
    | 'usage'
    | 'compliance'
    | 'config'
    | 'loop'
    | 'connector'
    | 'worktree'
    | 'state'
    | 'team';
  safety: WorkflowPromptSafety;
  order: number;
  content: string;
}

const BUILTIN_WORKFLOW_MARKER = '<!-- hermit-builtin-workflow:v2-loop -->';

const WORKFLOW_CATEGORIES: readonly BuiltinWorkflowDefinition['category'][] = [
  'overview',
  'health',
  'improvement',
  'usage',
  'compliance',
  'config',
  'loop',
  'connector',
  'worktree',
  'state',
  'team',
];

const SAFETY_VALUES: readonly WorkflowPromptSafety[] = [
  'read-only',
  'reporting',
  'audit',
  'proposal-only',
  'apply',
  'destructive',
  'unknown',
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function hermitHome(): string {
  return process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit');
}

/** Repo 内随包分发的 workflow 源文件目录。 */
function getBundledWorkflowsDir(): string {
  // 生产（ESM node）：import.meta.url 指向本文件，bundled 目录在其同级。
  try {
    const here = fileURLToPath(new URL('./builtin-workflows/', import.meta.url));
    if (existsSync(here)) return here;
  } catch {
    /* import.meta.url 不可用，走 fallback */
  }
  // fallback（vitest/test，cwd = repo root）：相对工作目录解析。
  const cwdBased = path.resolve(
    process.cwd(),
    'src/main/services/system-manager/builtin-workflows'
  );
  if (existsSync(cwdBased)) return cwdBased;
  // 兜底：返回 import.meta.url 结果（即便不存在，让 readdir 抛出可读错误）。
  return fileURLToPath(new URL('./builtin-workflows/', import.meta.url));
}

/** 用户级 workflow 扫描目录：~/.hermit/.claude/workflow/ */
export function getHermitWorkflowScanDir(): string {
  return path.join(hermitHome(), '.claude', 'workflow');
}

function workspaceCommandDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.claude', 'commands');
}

function legacyWorkflowDir(workspaceDir: string): string {
  return path.join(workspaceDir, 'workflows');
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function nextAvailableConflictPath(targetDir: string, filename: string): Promise<string> {
  const parsed = path.parse(filename);
  for (let index = 0; index < 100; index++) {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const candidate = path.join(targetDir, `${parsed.name}.legacy-workflow${suffix}${parsed.ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`无法为 legacy workflow 生成不冲突的目标路径: ${filename}`);
}

// ---------------------------------------------------------------------------
// Frontmatter parsing（复用 SkillMetadataParser 的正则模式 + yaml 库）
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(raw);
  if (!match) return { data: {}, body: raw };
  try {
    const parsed = YAML.parse(match[1]) as unknown;
    return {
      data:
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
      body: match[2],
    };
  } catch {
    return { data: {}, body: match[2] };
  }
}

function parseJsMeta(raw: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of ['name', 'label', 'description', 'category', 'safety']) {
    const pattern = '(?:^|[,{\\s])' + key + '\\s*:\\s*([\'"`])([^\'"`]+)\\1';
    const match = new RegExp(pattern, 'u').exec(raw);
    if (match) data[key] = match[2];
  }
  const orderMatch = /(?:^|[,{\s])order\s*:\s*(\d+)/u.exec(raw);
  if (orderMatch) data.order = Number(orderMatch[1]);
  return data;
}

function isWorkflowFile(name: string): boolean {
  return name.endsWith('.md') || name.endsWith('.js');
}

function asCategory(value: unknown): BuiltinWorkflowDefinition['category'] {
  return WORKFLOW_CATEGORIES.includes(value as BuiltinWorkflowDefinition['category'])
    ? (value as BuiltinWorkflowDefinition['category'])
    : 'loop';
}

function asSafety(value: unknown): WorkflowPromptSafety {
  return SAFETY_VALUES.includes(value as WorkflowPromptSafety)
    ? (value as WorkflowPromptSafety)
    : 'read-only';
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * 扫描目录下的 *.md / *.js workflow。
 * - markdown workflow: YAML frontmatter 承载 metadata，content 为 frontmatter 后正文。
 * - dynamic workflow: `export const meta = {...}` 承载 metadata，content 为完整 JS 脚本。
 * 按 order 升序、id 字典序兜底。
 */
export async function scanHermitWorkflows(dir: string): Promise<BuiltinWorkflowDefinition[]> {
  const entries = await readdir(dir).catch(() => []);
  const result: BuiltinWorkflowDefinition[] = [];
  for (const name of entries) {
    if (!isWorkflowFile(name)) continue;
    const full = path.join(dir, name);
    const stats = await stat(full).catch(() => null);
    if (!stats?.isFile()) continue;
    const raw = await readFile(full, 'utf8');
    const parsed = name.endsWith('.js')
      ? { data: parseJsMeta(raw), body: raw }
      : parseFrontmatter(raw);
    const basename = path.basename(name, path.extname(name));
    const id = String(parsed.data.id ?? parsed.data.name ?? basename);
    result.push({
      id,
      filename: name,
      commandName: `/${id}`,
      label: String(parsed.data.label ?? parsed.data.name ?? id),
      description: String(parsed.data.description ?? ''),
      category: asCategory(parsed.data.category),
      safety: asSafety(parsed.data.safety),
      order: Number.isFinite(Number(parsed.data.order)) ? Number(parsed.data.order) : 999,
      content: parsed.body,
    });
  }
  result.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return result;
}

/** 扫描用户级 ~/.hermit/.claude/workflow/，返回当前可用的 workflow。 */
export async function listHermitWorkflows(): Promise<BuiltinWorkflowDefinition[]> {
  return scanHermitWorkflows(getHermitWorkflowScanDir());
}

// ---------------------------------------------------------------------------
// Seed：bundled 源 → ~/.hermit/.claude/workflow/
// ---------------------------------------------------------------------------

function shouldRefreshBuiltinWorkflow(existingContent: string, bundledContent: string): boolean {
  // 只刷新带内置 marker 的副本；用户自定义（无 marker）一律不动。
  if (!existingContent.includes(BUILTIN_WORKFLOW_MARKER)) return false;
  return existingContent !== bundledContent;
}

async function seedBuiltinWorkflowsIntoDir(sourceDir: string, targetDir: string): Promise<number> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir).catch(() => []);
  let copied = 0;
  for (const name of entries) {
    if (!isWorkflowFile(name)) continue;
    const bundledContent = await readFile(path.join(sourceDir, name), 'utf8');
    const targetPath = path.join(targetDir, name);
    const targetExists = await exists(targetPath);
    if (targetExists) {
      const existingContent = await readFile(targetPath, 'utf-8').catch(() => '');
      if (!shouldRefreshBuiltinWorkflow(existingContent, bundledContent)) continue;
    }
    await writeFile(targetPath, bundledContent, 'utf-8');
    copied++;
    logger.info(
      `${targetExists ? 'refreshed' : 'seeded'} hermit workflow: ${name} → ${targetPath}`
    );
  }
  return copied;
}

// ---------------------------------------------------------------------------
// Legacy migration（workspace 级 workflows/ → .claude/commands/，保留兼容）
// ---------------------------------------------------------------------------

export async function migrateLegacyWorkflowFolder(workspaceDir: string): Promise<number> {
  const sourceDir = legacyWorkflowDir(workspaceDir);
  const targetDir = workspaceCommandDir(workspaceDir);
  const sourceExists = await stat(sourceDir)
    .then((item) => item.isDirectory())
    .catch(() => false);
  if (!sourceExists) return 0;

  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  let moved = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const from = path.join(sourceDir, entry.name);
    const preferredTarget = path.join(targetDir, entry.name);
    const to = (await exists(preferredTarget))
      ? await nextAvailableConflictPath(targetDir, entry.name)
      : preferredTarget;
    await rename(from, to);
    moved++;
    logger.info(`migrated legacy workflow to Claude command: ${from} → ${to}`);
  }

  const remaining = await readdir(sourceDir).catch(() => []);
  if (remaining.length === 0) await rm(sourceDir, { recursive: true, force: true });
  return moved;
}

// ---------------------------------------------------------------------------
// Ensure（启动期）：bundled 源 → ~/.hermit/.claude/workflow/
// ---------------------------------------------------------------------------

/**
 * 确保 ~/.hermit/.claude/workflow/ 有最新的内置 workflow（从 bundled 源复制）。
 * 启动期调用一次。带 marker 的旧副本在内容变化时刷新；用户自定义（无 marker）不动。
 */
export async function ensureGlobalWorkflows(): Promise<void> {
  await migrateLegacyWorkflowFolder(hermitHome()).catch((err) =>
    logger.warn(
      'failed to migrate legacy Hermit workflows:',
      err instanceof Error ? err.message : err
    )
  );
  try {
    const copied = await seedBuiltinWorkflowsIntoDir(
      getBundledWorkflowsDir(),
      getHermitWorkflowScanDir()
    );
    if (copied > 0) {
      logger.info(`ensured ${copied} hermit workflow(s) at ${getHermitWorkflowScanDir()}`);
    }
  } catch (err) {
    logger.warn('failed to ensure hermit workflows:', err instanceof Error ? err.message : err);
  }
}
