import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  WorkflowPromptContentResponse,
  WorkflowPromptListResponse,
  WorkflowPromptSafety,
  WorkflowPromptSummary,
} from '@shared/types/systemManager';

const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.prompt', '.workflow']);
const MAX_PROMPT_BYTES = 256 * 1024;
const KNOWN_WORKFLOW_SAFETY = new Set<WorkflowPromptSafety>([
  'read-only',
  'reporting',
  'audit',
  'proposal-only',
  'apply',
  'destructive',
  'unknown',
]);

function expandHome(input: string): string {
  const normalized = input.trim().replace(/^～/, '~');
  if (normalized === '~') return os.homedir();
  if (normalized.startsWith('~/')) return path.join(os.homedir(), normalized.slice(2));
  return normalized;
}

function promptId(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16);
}

function labelFromFilename(filename: string): string {
  return path.basename(filename, path.extname(filename)).replace(/[-_]+/g, ' ').trim() || filename;
}

function getClaudeCommandRoot(folder: string): string | null {
  const normalized = path.normalize(folder);
  const commandsSuffix = path.join('.claude', 'commands');
  if (normalized.endsWith(commandsSuffix)) return normalized;
  const parent = path.dirname(normalized);
  return parent.endsWith(commandsSuffix) ? parent : null;
}

function commandNameFromRelativePath(relativePath: string): `/${string}` {
  const withoutExt = relativePath.slice(0, -path.extname(relativePath).length);
  const commandName = withoutExt.split(path.sep).filter(Boolean).join(':');
  return `/${commandName}`;
}

interface WorkflowPromptFrontmatter {
  id?: string;
  label?: string;
  description?: string;
  category?: string;
  safety?: WorkflowPromptSafety;
  order?: number;
}

function stripInlineComment(value: string): string {
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      quote = quote === char ? null : (quote ?? char);
      continue;
    }
    if (char === '#' && quote === null && (index === 0 || /\s/.test(value[index - 1] ?? ''))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function parseFrontmatterValue(raw: string): string | number | boolean | null {
  const value = stripInlineComment(raw);
  if (!value || value === '~' || value.toLowerCase() === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    return quote === '"'
      ? inner.replace(/\\(["\\nrt])/g, (_match, escaped: string) => {
          switch (escaped) {
            case 'n':
              return '\n';
            case 'r':
              return '\r';
            case 't':
              return '\t';
            default:
              return escaped;
          }
        })
      : inner.replace(/''/g, "'");
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asSafety(value: unknown): WorkflowPromptSafety | undefined {
  const safety = asNonEmptyString(value);
  return safety && KNOWN_WORKFLOW_SAFETY.has(safety as WorkflowPromptSafety)
    ? (safety as WorkflowPromptSafety)
    : undefined;
}

function asOrder(value: unknown): number | undefined {
  const order = typeof value === 'number' ? value : Number(asNonEmptyString(value));
  return Number.isSafeInteger(order) ? order : undefined;
}

function parseWorkflowPromptFrontmatter(content: string): WorkflowPromptFrontmatter {
  if (!content.startsWith('---')) return {};
  const lineEnd = content.indexOf('\n');
  if (lineEnd !== 3 && !(lineEnd === 4 && content[3] === '\r')) return {};

  const closeMatch = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!closeMatch?.index) return {};

  const block = content.slice(lineEnd + 1, closeMatch.index);
  const values = new Map<string, string | number | boolean | null>();
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    values.set(key, parseFrontmatterValue(trimmed.slice(separator + 1)));
  }

  return {
    id: asNonEmptyString(values.get('id')),
    label: asNonEmptyString(values.get('label')),
    description: asNonEmptyString(values.get('description') ?? values.get('desc')),
    category: asNonEmptyString(values.get('category')),
    safety: asSafety(values.get('safety')),
    order: asOrder(values.get('order')),
  };
}

export class WorkflowPromptService {
  async list(folderInput: string): Promise<WorkflowPromptListResponse> {
    const folder = path.resolve(expandHome(folderInput));
    const folderStat = await stat(folder);
    if (!folderStat.isDirectory()) {
      throw new Error(`Loop command folder 不是有效目录: ${folder}`);
    }

    const warnings: string[] = [];
    const prompts: WorkflowPromptSummary[] = [];
    const commandRoot = getClaudeCommandRoot(folder);
    if (!commandRoot) {
      throw new Error(`Claude command folder 必须位于 .claude/commands 下: ${folder}`);
    }
    const pendingDirs = [folder];

    for (const currentDir of pendingDirs) {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const filePath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          pendingDirs.push(filePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
        const fileStat = await stat(filePath);
        if (fileStat.size > MAX_PROMPT_BYTES) {
          warnings.push(`${path.relative(folder, filePath)} 超过 256 KiB，已跳过`);
          continue;
        }

        const content = await readFile(filePath, 'utf-8');
        const frontmatter = parseWorkflowPromptFrontmatter(content);
        const relativeCommandPath = path.relative(commandRoot, filePath);
        const commandName = commandNameFromRelativePath(relativeCommandPath);
        const summary: WorkflowPromptSummary = {
          id: frontmatter.id ?? promptId(filePath),
          label: frontmatter.label ?? labelFromFilename(entry.name),
          filename: path.relative(folder, filePath),
          path: filePath,
          folder,
          sizeBytes: fileStat.size,
          updatedAt: fileStat.mtime.toISOString(),
          source: 'claude-command',
          commandName,
          description: frontmatter.description,
          category: frontmatter.category,
          safety: frontmatter.safety ?? 'unknown',
          order: frontmatter.order,
        };
        prompts.push(summary);
      }
    }

    prompts.sort((a, b) => {
      const orderA = a.order ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.order ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.filename.localeCompare(b.filename);
    });
    return { folder, prompts, warnings };
  }

  async read(folderInput: string, id: string): Promise<WorkflowPromptContentResponse> {
    const list = await this.list(folderInput);
    const prompt = list.prompts.find((item) => item.id === id || item.filename === id);
    if (!prompt) {
      throw new Error(`未找到 Loop workflow: ${id}`);
    }
    const content = await readFile(prompt.path, 'utf-8');
    return { prompt, content };
  }
}
