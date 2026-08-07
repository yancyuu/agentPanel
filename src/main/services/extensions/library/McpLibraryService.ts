/**
 * McpLibraryService — a reusable, global library of MCP server definitions.
 *
 * cc-switch model: a server is defined once and can be enabled for any worker
 * (= installed into that worker's project config) without re-entering the
 * command / URL / env each time. The "enable/disable for a worker" action is
 * handled by the existing install/uninstall path; this service only owns the
 * persisted library of definitions.
 *
 * Storage: ~/.hermit/mcp-library.json (HERMIT_HOME override respected).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { McpConfigStateReader } from '../runtime/McpConfigStateReader';

import type {
  McpHeaderDef,
  McpInstallSpec,
  McpLibraryEntry,
  McpLibraryImportRequest,
  McpLibraryImportResult,
  McpLibraryUpsertRequest,
} from '@shared/types/extensions';

const logger = createLogger('Extensions:McpLibrary');

function getHermitHome(): string {
  return process.env.HERMIT_HOME ?? path.join(os.homedir(), '.hermit');
}

/**
 * Best-effort mapping of a raw MCP server config (from ~/.claude.json /
 * .mcp.json) into the install spec the current install path understands.
 * Returns null when the config cannot be represented (e.g. an arbitrary stdio
 * command rather than an npm package) — the caller skips those.
 */
function rawConfigToInstallSpec(config: Record<string, unknown>): McpInstallSpec | null {
  const url = typeof config.url === 'string' ? config.url : null;
  if (url) {
    const rawType = typeof config.type === 'string' ? config.type : 'http';
    const transportType =
      rawType === 'sse' ? 'sse' : rawType === 'streamable-http' ? 'streamable-http' : 'http';
    return { type: 'http', url, transportType };
  }

  const command = typeof config.command === 'string' ? config.command : null;
  if (command) {
    const args = Array.isArray(config.args) ? config.args.map(String) : [];
    const npmPackage = extractNpmPackage(command, args);
    if (npmPackage) {
      return { type: 'stdio', npmPackage };
    }
  }

  return null;
}

/** Pull the package spec out of `npx -y <pkg>` / `npm exec <pkg>` style commands. */
function extractNpmPackage(command: string, args: string[]): string | null {
  const base = path.basename(command);
  if (base !== 'npx' && base !== 'npm' && base !== 'pnpm' && base !== 'bunx') {
    return null;
  }
  // Skip flags (-y, --yes, exec, ...) and take the first package-looking token.
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (arg === 'exec' || arg === 'dlx') continue;
    return arg;
  }
  return null;
}

function extractEnvValues(config: Record<string, unknown>): Record<string, string> | undefined {
  const env = config.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractHeaders(config: Record<string, unknown>): McpHeaderDef[] | undefined {
  const headers = config.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  const out: McpHeaderDef[] = [];
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === 'string') out.push({ key, value });
  }
  return out.length > 0 ? out : undefined;
}

export class McpLibraryService {
  private readonly filePath: string;
  private entries: McpLibraryEntry[] | null = null;

  constructor(
    dataDir: string = getHermitHome(),
    private readonly stateReader = new McpConfigStateReader()
  ) {
    this.filePath = path.join(dataDir, 'mcp-library.json');
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  list(): McpLibraryEntry[] {
    return [...this.load()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  upsert(request: McpLibraryUpsertRequest): McpLibraryEntry {
    const name = request.name.trim();
    if (!name) throw new Error('MCP 名称不能为空');

    const entries = this.load();
    const now = Date.now();

    if (request.id) {
      const existing = entries.find((e) => e.id === request.id);
      if (!existing) throw new Error(`未找到库条目: ${request.id}`);
      this.assertNameAvailable(entries, name, request.id);
      existing.name = name;
      existing.description = request.description?.trim() || undefined;
      existing.installSpec = request.installSpec;
      existing.envValues = request.envValues;
      existing.headers = request.headers;
      existing.updatedAt = now;
      this.save(entries);
      return existing;
    }

    this.assertNameAvailable(entries, name, null);
    const entry: McpLibraryEntry = {
      id: randomUUID(),
      name,
      description: request.description?.trim() || undefined,
      installSpec: request.installSpec,
      envValues: request.envValues,
      headers: request.headers,
      createdAt: now,
      updatedAt: now,
    };
    entries.push(entry);
    this.save(entries);
    return entry;
  }

  remove(id: string): void {
    const entries = this.load();
    const next = entries.filter((e) => e.id !== id);
    if (next.length !== entries.length) this.save(next);
  }

  /**
   * Import MCP servers already present in live config into the library.
   * Skips entries whose name already exists, and ones whose config can't be
   * represented by the current install spec (e.g. arbitrary stdio commands).
   */
  async importFromLive(request: McpLibraryImportRequest): Promise<McpLibraryImportResult> {
    const configured = await this.stateReader.readConfigured(request.projectPath);
    const entries = this.load();
    const existingNames = new Set(entries.map((e) => e.name.toLowerCase()));

    const imported: string[] = [];
    const skipped: string[] = [];
    const now = Date.now();

    for (const entry of configured) {
      if (existingNames.has(entry.name.toLowerCase())) {
        skipped.push(entry.name);
        continue;
      }
      const installSpec = rawConfigToInstallSpec(entry.config);
      if (!installSpec) {
        skipped.push(entry.name);
        continue;
      }
      entries.push({
        id: randomUUID(),
        name: entry.name,
        installSpec,
        envValues: extractEnvValues(entry.config),
        headers: extractHeaders(entry.config),
        createdAt: now,
        updatedAt: now,
      });
      existingNames.add(entry.name.toLowerCase());
      imported.push(entry.name);
    }

    if (imported.length > 0) this.save(entries);
    return { imported, skipped };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private assertNameAvailable(
    entries: McpLibraryEntry[],
    name: string,
    ignoreId: string | null
  ): void {
    const clash = entries.find(
      (e) => e.name.toLowerCase() === name.toLowerCase() && e.id !== ignoreId
    );
    if (clash) throw new Error(`库中已存在同名 MCP: ${name}`);
  }

  private load(): McpLibraryEntry[] {
    if (this.entries) return this.entries;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as McpLibraryEntry[];
        this.entries = Array.isArray(parsed) ? parsed : [];
      } else {
        this.entries = [];
      }
    } catch (error) {
      logger.warn(`Failed to load MCP library from ${this.filePath}: ${getErrorMessage(error)}`);
      this.entries = [];
    }
    return this.entries;
  }

  private save(entries: McpLibraryEntry[]): void {
    this.entries = entries;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (error) {
      logger.warn(`Failed to save MCP library to ${this.filePath}: ${getErrorMessage(error)}`);
    }
  }
}
