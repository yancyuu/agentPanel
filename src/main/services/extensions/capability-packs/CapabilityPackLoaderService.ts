import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getHermitWorkflowScanDir,
  listHermitWorkflows,
} from '@main/services/system-manager/BuiltinWorkflowSeeder';
import { validateOpenPathUserSelected } from '@main/utils/pathValidation';
import { createLogger } from '@shared/utils/logger';
import { isSupportedSlashCommandName, KNOWN_SLASH_COMMANDS } from '@shared/utils/slashCommands';

import { McpConfigStateReader } from '../runtime/McpConfigStateReader';
import { SkillsCatalogService } from '../skills/SkillsCatalogService';

import type {
  CapabilityCommand,
  CapabilityCommandPromptRequest,
  CapabilityCommandPromptResult,
  CapabilityCommandSurface,
  CapabilityCronJob,
  CapabilityMcpServer,
  CapabilityPackExportRequest,
  CapabilityPackExportRuntime,
  CapabilityPackImportRequest,
  CapabilityPackListResult,
  CapabilityPackManifest,
  CapabilityPackMutationResult,
  CapabilitySafety,
  CapabilityScope,
  CapabilitySkill,
  CapabilityWorkflow,
  LoadedCapabilityPack,
  RegisteredSlashCommand,
  SkillCatalogItem,
  TeamCapabilityTelemetryAsset,
  TeamCapabilityTelemetrySnapshot,
} from '@shared/types/extensions';
import type { HermitBridgeCronJob } from '@shared/types/hermitBridge';

const logger = createLogger('Extensions:CapabilityPacks');
const MANIFEST_FILENAME = 'pack.json';
const MAX_PACK_FILE_COUNT = 500;
const MAX_PACK_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_COMMAND_PROMPT_BYTES = 512 * 1024;
const CAPABILITY_SCOPES = new Set<CapabilityScope>([
  'admin-loop',
  'team-loop',
  'kanban-card',
  'task-detail',
]);
const CAPABILITY_SURFACES = new Set<CapabilityCommandSurface>(['slash', 'quick-run']);
const CAPABILITY_SAFETY_VALUES = new Set<CapabilitySafety>([
  'read-only',
  'reporting',
  'proposal-only',
  'write',
  'audit',
]);
const RESERVED_SLASH_COMMANDS = new Set([
  ...KNOWN_SLASH_COMMANDS.map((command) => command.name.toLowerCase()),
  'help',
  'settings',
  'permissions',
  'login',
  'logout',
  'mcp',
  'agents',
  'hooks',
  'memory',
]);

const BUILTIN_HERMIT_OPS_PACK_ID = 'hermit-team-ops';
const BUILTIN_HERMIT_OPS_PACK_NAMESPACE = 'hermit';
const LOCAL_CAPABILITY_PACK_ID = 'local-capabilities';
const LOCAL_CAPABILITY_PACK_NAMESPACE = 'local';
const LOCAL_CAPABILITY_FALLBACK_TEAM = 'personal';
const SUPPORTED_EXPORT_RUNTIMES = new Set<CapabilityPackExportRuntime>([
  'claudecode',
  'codex',
  'cursor',
  'gemini',
  'opencode',
]);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintSnapshot(
  snapshot: Omit<TeamCapabilityTelemetrySnapshot, 'fingerprint'>
): string {
  const { reportedAt: _reportedAt, ...stableSnapshot } = snapshot;
  return createHash('sha256').update(stableJson(stableSnapshot)).digest('hex');
}

function slugifyCapabilityTelemetry(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'team'
  );
}

export interface LocalTeamEntry {
  slug: string;
  displayName: string;
  workDir?: string;
  bindProject?: string;
  /**
   * 当前工作目录对应的团队（personal/cwd）。它承载 user 级 + 项目级 skills/MCP
   * 与内置 workflows，并使用遗留的裸 `local-capabilities` id，方便按运行时导出。
   */
  isPersonal?: boolean;
}

export interface LocalCapabilityPackSource {
  projectPath?: string;
  listCronJobs?: () => Promise<HermitBridgeCronJob[]>;
  /** 枚举所有团队，按团队工作空间分组生成本地能力包。 */
  listTeams?: () => Promise<LocalTeamEntry[]>;
}

function getHermitHome(): string {
  return process.env.HERMIT_HOME ?? path.join(os.homedir(), '.hermit');
}

function toCapabilitySafety(safety: string): CapabilitySafety {
  if (CAPABILITY_SAFETY_VALUES.has(safety as CapabilitySafety)) return safety as CapabilitySafety;
  return 'audit';
}

async function createBuiltinHermitOpsPack(): Promise<LoadedCapabilityPack> {
  const workflows = await listHermitWorkflows();
  return {
    manifest: {
      schemaVersion: 1,
      id: BUILTIN_HERMIT_OPS_PACK_ID,
      name: 'AgentCLI Team Ops',
      namespace: BUILTIN_HERMIT_OPS_PACK_NAMESPACE,
      version: '1.0.0',
      author: 'AgentCLI',
      description:
        'AgentCLI 官方预装的团队运维检测包，workflow 随包分发到 ~/.hermit/.claude/workflow，通过能力包暴露给所有团队。',
      capabilities: {
        commands: workflows.map((workflow) => ({
          id: workflow.id,
          alias: workflow.id,
          title: workflow.label,
          description: workflow.description,
          scope: ['admin-loop', 'team-loop'],
          surfaces: ['slash', 'quick-run'],
          safety: toCapabilitySafety(workflow.safety),
          prompt: workflow.filename,
          workflow: workflow.filename,
          order: workflow.order,
          execution: { type: 'loop-session', reuse: true },
        })),
        workflows: workflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.label,
          description: workflow.description,
          path: `workflows/${workflow.filename}`,
        })),
        skills: [],
      },
    },
    packDir: getHermitWorkflowScanDir(),
    source: 'builtin',
    enabled: true,
    warnings: [],
  };
}

function normalizeName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function sanitizePackId(packId: string): string {
  const sanitized = packId.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!sanitized) throw new Error('Capability pack id is required');
  return sanitized;
}

function isValidSlashToken(value: string): boolean {
  return isSupportedSlashCommandName(value) && !value.includes(':');
}

function requireValidSlashToken(value: string, fieldName: string): void {
  if (!isValidSlashToken(value)) {
    throw new Error(
      `${fieldName} must start with a letter and contain only letters, numbers, hyphens, and underscores`
    );
  }
}

function filterStringUnion<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  fieldName: string,
  required: boolean
): T[] {
  const entries = asStringArray(value);
  const invalid = entries.find((entry) => !allowed.has(entry as T));
  if (invalid) {
    throw new Error(`${fieldName} contains unsupported value: ${invalid}`);
  }
  if (required && entries.length === 0) {
    throw new Error(`${fieldName} requires at least one value`);
  }
  return entries as T[];
}

function sortTelemetryAssets(
  assets: TeamCapabilityTelemetryAsset[]
): TeamCapabilityTelemetryAsset[] {
  return [...assets].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id) ||
      a.packId.localeCompare(b.packId)
  );
}

export function buildTeamCapabilityTelemetrySnapshots(
  packs: LoadedCapabilityPack[],
  options: { reportedAt?: string } = {}
): TeamCapabilityTelemetrySnapshot[] {
  const reportedAt = options.reportedAt ?? new Date().toISOString();
  const grouped = new Map<
    string,
    {
      teamName: string;
      projectDir: string;
      projectName: string;
      sourcePackIds: Set<string>;
      assets: TeamCapabilityTelemetryAsset[];
      counts: TeamCapabilityTelemetrySnapshot['counts'];
    }
  >();

  for (const pack of packs) {
    if (!pack.enabled) continue;
    const projectDir = path.resolve(pack.packDir || getHermitHome());
    const projectName = path.basename(projectDir) || pack.manifest.name.trim() || 'unknown-project';
    const teamName = pack.manifest.teamName?.trim() || pack.manifest.name.trim() || projectName;
    const teamKey = slugifyCapabilityTelemetry(teamName) || teamName;
    const entry = grouped.get(teamKey) ?? {
      teamName,
      projectDir,
      projectName,
      sourcePackIds: new Set<string>(),
      assets: [],
      counts: { commands: 0, skills: 0, workflows: 0, cron: 0, mcpServers: 0 },
    };
    entry.sourcePackIds.add(pack.manifest.id);

    for (const command of pack.manifest.capabilities.commands ?? []) {
      entry.counts.commands += 1;
      entry.assets.push({
        kind: 'command',
        id: command.id,
        name: command.title || command.alias,
        description: command.description,
        scope: command.scope.join(','),
        safety: command.safety,
        source: pack.source,
        packId: pack.manifest.id,
      });
    }

    for (const skill of pack.manifest.capabilities.skills ?? []) {
      entry.counts.skills += 1;
      entry.assets.push({
        kind: 'skill',
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: pack.source,
        packId: pack.manifest.id,
      });
    }

    for (const workflow of pack.manifest.capabilities.workflows ?? []) {
      entry.counts.workflows += 1;
      entry.assets.push({
        kind: 'workflow',
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        source: pack.source,
        packId: pack.manifest.id,
      });
    }

    for (const cron of pack.manifest.capabilities.cron ?? []) {
      entry.counts.cron += 1;
      entry.assets.push({
        kind: 'cron',
        id: cron.id,
        name: cron.name,
        description: cron.description,
        enabled: cron.enabled,
        scope: cron.cronExpression,
        source: pack.source,
        packId: pack.manifest.id,
      });
    }

    for (const server of pack.manifest.capabilities.mcpServers ?? []) {
      entry.counts.mcpServers += 1;
      entry.assets.push({
        kind: 'mcp',
        id: server.id,
        name: server.name,
        scope: server.scope,
        transport: server.transport,
        source: pack.source,
        packId: pack.manifest.id,
      });
    }

    grouped.set(teamKey, entry);
  }

  return [...grouped.values()]
    .map((entry) => {
      const snapshotWithoutFingerprint = {
        teamSlug: slugifyCapabilityTelemetry(entry.teamName),
        teamName: entry.teamName,
        teamDisplayName: entry.teamName,
        projectDir: entry.projectDir,
        projectName: entry.projectName,
        sourcePackIds: [...entry.sourcePackIds].sort(),
        assets: sortTelemetryAssets(entry.assets),
        counts: entry.counts,
        reportedAt,
      } satisfies Omit<TeamCapabilityTelemetrySnapshot, 'fingerprint'>;
      return {
        ...snapshotWithoutFingerprint,
        fingerprint: fingerprintSnapshot(snapshotWithoutFingerprint),
      };
    })
    .sort((a, b) => a.teamName.localeCompare(b.teamName));
}

export class CapabilityPackLoaderService {
  private readonly rootDir: string;
  private localSource: LocalCapabilityPackSource;

  constructor(
    rootDir = path.join(getHermitHome(), 'capability-packs'),
    private readonly skillsCatalog = new SkillsCatalogService(),
    private readonly mcpReader = new McpConfigStateReader(),
    localSource: LocalCapabilityPackSource = {}
  ) {
    this.rootDir = rootDir;
    this.localSource = localSource;
  }

  setLocalSource(source: LocalCapabilityPackSource): void {
    this.localSource = { ...this.localSource, ...source };
  }

  async list(): Promise<CapabilityPackListResult> {
    const warnings: string[] = [];
    await fs.mkdir(this.rootDir, { recursive: true });

    let entries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      logger.warn(`Failed to read capability pack root ${this.rootDir}`, error);
      return {
        packs: [],
        warnings: ['Unable to read capability pack directory.'],
        rootDir: this.rootDir,
      };
    }

    const loadedPacks = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(async (entry) => {
          const packDir = path.join(this.rootDir, entry.name);
          try {
            return await this.loadPackDir(packDir);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`${entry.name}: ${message}`);
            logger.warn(`Failed to load capability pack ${packDir}`, error);
            return null;
          }
        })
    );

    const packs: LoadedCapabilityPack[] = [await createBuiltinHermitOpsPack()];
    packs.push(...(await this.createLocalCapabilityPacks()));
    const packIds = new Set<string>(packs.map((pack) => pack.manifest.id));
    for (const pack of loadedPacks) {
      if (!pack) continue;
      if (packIds.has(pack.manifest.id)) {
        warnings.push(
          `${path.basename(pack.packDir)}: Duplicate capability pack id ${pack.manifest.id}`
        );
        continue;
      }
      packIds.add(pack.manifest.id);
      packs.push(pack);
    }

    return {
      packs: packs.sort(
        (a, b) =>
          Number(a.source !== 'builtin') - Number(b.source !== 'builtin') ||
          a.manifest.name.localeCompare(b.manifest.name)
      ),
      warnings,
      rootDir: this.rootDir,
    };
  }

  async importPack(request: CapabilityPackImportRequest): Promise<CapabilityPackMutationResult> {
    const sourceDir = await this.validateSourceDir(request.sourceDir);
    const sourceManifest = await this.readManifest(path.join(sourceDir, MANIFEST_FILENAME));
    const targetDir = path.join(this.rootDir, sanitizePackId(sourceManifest.id));

    if (!request.overwrite && (await this.pathExists(targetDir))) {
      throw new Error(`Capability pack ${sourceManifest.id} already exists`);
    }

    await fs.mkdir(this.rootDir, { recursive: true });
    if (request.overwrite) {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
    await this.copyDirectory(sourceDir, targetDir);

    const pack = await this.loadPackDir(targetDir);
    return { pack, warnings: pack.warnings };
  }

  async exportPack(request: CapabilityPackExportRequest): Promise<CapabilityPackMutationResult> {
    const packId = sanitizePackId(request.packId);
    const runtime = this.normalizeExportRuntime(request.runtime);
    const destinationRoot = this.resolveExportDestinationRoot(request.destinationDir, runtime);
    const destination = path.join(destinationRoot, packId);
    if (!request.overwrite && (await this.pathExists(destination))) {
      throw new Error(`Export destination already contains ${packId}`);
    }

    if (request.overwrite) {
      await fs.rm(destination, { recursive: true, force: true });
    }

    if (this.isLocalCapabilityPackId(packId)) {
      const pack = await this.exportLocalPack(packId, destination, runtime);
      return {
        pack,
        warnings: [`Exported ${runtime} config package to ${destination}`, ...pack.warnings],
      };
    }

    if (packId === BUILTIN_HERMIT_OPS_PACK_ID) {
      const pack = await this.exportBuiltinPack(destination, runtime);
      return { pack, warnings: [`Exported ${runtime} config package to ${destination}`] };
    }

    const sourceDir = path.join(this.rootDir, packId);
    if (!(await this.pathExists(sourceDir))) {
      throw new Error(`Capability pack ${packId} is not installed`);
    }

    await this.copyDirectory(sourceDir, destination);
    await this.writeRuntimeExportDescriptor(
      destination,
      runtime,
      await this.readManifest(path.join(sourceDir, MANIFEST_FILENAME))
    );
    const pack = await this.loadPackDir(sourceDir);
    return { pack, warnings: [`Exported ${runtime} config package to ${destination}`] };
  }

  async getCommandPrompt(
    request: CapabilityCommandPromptRequest
  ): Promise<CapabilityCommandPromptResult> {
    const canonicalId = normalizeName(request.canonicalId);
    if (!canonicalId) throw new Error('Capability command canonicalId is required');

    const { packs } = await this.list();
    const registered = this.buildRegisteredCommands(packs, request.scope);
    const command = registered.find((entry) => entry.canonicalId === canonicalId);
    if (!command) {
      throw new Error(`Capability command ${canonicalId} not found`);
    }
    if (command.source === 'builtin') {
      throw new Error(
        `Built-in workflow command ${canonicalId} runs via Claude Code slash command`
      );
    }

    const pack = packs.find((entry) => entry.manifest.id === command.packId);
    if (!pack) {
      throw new Error(`Capability pack ${command.packId ?? ''} not found`);
    }

    const prompt = await this.readPromptFile(pack.packDir, command.command.prompt);
    return { command, prompt };
  }

  async loadPackDir(packDir: string): Promise<LoadedCapabilityPack> {
    const manifestPath = path.join(packDir, MANIFEST_FILENAME);
    const manifest = await this.readManifest(manifestPath);
    const warnings = await this.validateReferencedFiles(packDir, manifest);
    return {
      manifest,
      packDir,
      source: 'user',
      enabled: true,
      warnings,
    };
  }

  async validateSourceDir(sourceDir: string): Promise<string> {
    const validatedSource = validateOpenPathUserSelected(sourceDir);
    if (!validatedSource.valid || !validatedSource.normalizedPath) {
      throw new Error(validatedSource.error ?? 'Invalid import source');
    }

    const normalizedSourceDir = validatedSource.normalizedPath;
    const stat = await fs.stat(normalizedSourceDir);
    if (!stat.isDirectory()) {
      throw new Error('Import source must be a directory');
    }

    await this.readManifest(path.join(normalizedSourceDir, MANIFEST_FILENAME));
    return normalizedSourceDir;
  }

  private async readManifest(manifestPath: string): Promise<CapabilityPackManifest> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(
        error instanceof SyntaxError
          ? `Invalid ${MANIFEST_FILENAME}: ${error.message}`
          : `Missing ${MANIFEST_FILENAME}`
      );
    }

    return this.normalizeManifest(raw);
  }

  private normalizeManifest(raw: unknown): CapabilityPackManifest {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Capability pack manifest must be an object');
    }

    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== 1) {
      throw new Error('Unsupported capability pack schemaVersion');
    }

    const id = normalizeName(record.id);
    const name = normalizeName(record.name);
    const namespace = normalizeName(record.namespace);
    const version = normalizeName(record.version);
    if (!id || !name || !namespace || !version) {
      throw new Error('Capability pack manifest requires id, name, namespace, and version');
    }
    requireValidSlashToken(namespace, 'Capability pack namespace');

    const capabilities =
      record.capabilities && typeof record.capabilities === 'object'
        ? (record.capabilities as Record<string, unknown>)
        : {};

    return {
      schemaVersion: 1,
      id,
      name,
      namespace,
      version,
      author: normalizeName(record.author) ?? undefined,
      description: normalizeName(record.description) ?? undefined,
      tags: asStringArray(record.tags),
      teamName: normalizeName(record.teamName) ?? undefined,
      capabilities: {
        commands: this.normalizeCommands(capabilities.commands),
        skills: this.normalizeSkills(capabilities.skills),
        workflows: this.normalizeWorkflows(capabilities.workflows),
        cron: this.normalizeCronJobs(capabilities.cron),
        mcpServers: this.normalizeMcpServers(capabilities.mcpServers),
      },
    };
  }

  private normalizeCommands(value: unknown): CapabilityCommand[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`Command at index ${index} must be an object`);
      }
      const record = entry as Record<string, unknown>;
      const id = normalizeName(record.id);
      const alias = normalizeName(record.alias);
      const title = normalizeName(record.title);
      const prompt = normalizeName(record.prompt);
      const safety = normalizeName(record.safety);
      if (!id || !alias || !title || !prompt || !safety) {
        throw new Error(`Command at index ${index} requires id, alias, title, prompt, and safety`);
      }
      requireValidSlashToken(alias, `Command at index ${index} alias`);
      const scope = filterStringUnion(
        record.scope,
        CAPABILITY_SCOPES,
        `Command at index ${index} scope`,
        true
      );
      const surfaces = filterStringUnion(
        record.surfaces,
        CAPABILITY_SURFACES,
        `Command at index ${index} surfaces`,
        true
      );
      if (!CAPABILITY_SAFETY_VALUES.has(safety as CapabilitySafety)) {
        throw new Error(`Command at index ${index} has unsupported safety: ${safety}`);
      }

      const executionRecord =
        record.execution && typeof record.execution === 'object'
          ? (record.execution as Record<string, unknown>)
          : null;
      const executionType = normalizeName(executionRecord?.type);

      return {
        id,
        alias,
        title,
        description: normalizeName(record.description) ?? undefined,
        scope,
        surfaces,
        safety: safety as CapabilityCommand['safety'],
        prompt,
        usesSkills: asStringArray(record.usesSkills),
        workflow: record.workflow === null ? null : (normalizeName(record.workflow) ?? undefined),
        order: typeof record.order === 'number' ? record.order : undefined,
        execution:
          executionType === 'send-message' || executionType === 'loop-session'
            ? { type: executionType, reuse: executionRecord?.reuse === true }
            : undefined,
      };
    });
  }

  private buildRegisteredCommands(
    packs: readonly LoadedCapabilityPack[],
    scope?: CapabilityScope
  ): RegisteredSlashCommand[] {
    const registered: RegisteredSlashCommand[] = [];
    for (const pack of packs) {
      if (!pack.enabled) continue;
      const packId = pack.manifest.id;
      const namespace = pack.manifest.namespace.trim().toLowerCase();
      for (const rawCommand of pack.manifest.capabilities.commands ?? []) {
        if (scope && !rawCommand.scope.includes(scope)) continue;
        if (!rawCommand.surfaces.includes('slash')) continue;
        const alias = rawCommand.alias.trim().toLowerCase();
        registered.push({
          canonicalId: `${packId}.${rawCommand.id}`,
          alias,
          namespace,
          slash: `/${alias}`,
          namespacedSlash: `/${namespace}:${alias}`,
          source: pack.source === 'builtin' ? 'builtin' : 'pack',
          packId,
          command: {
            ...rawCommand,
            alias,
            execution: rawCommand.execution ?? {
              type: scope === 'admin-loop' ? 'loop-session' : 'send-message',
              reuse: true,
            },
          },
        });
      }
    }

    const byAlias = new Map<string, RegisteredSlashCommand[]>();
    for (const command of registered) {
      byAlias.set(command.alias, [...(byAlias.get(command.alias) ?? []), command]);
    }

    return registered.map((command) => {
      const aliasPeers = byAlias.get(command.alias) ?? [];
      const conflictsWith = [
        ...aliasPeers
          .filter((peer) => peer.canonicalId !== command.canonicalId)
          .map((peer) => peer.canonicalId),
        ...(RESERVED_SLASH_COMMANDS.has(command.alias) ? [`official.${command.alias}`] : []),
      ];
      return conflictsWith.length ? { ...command, conflictsWith } : command;
    });
  }

  private normalizeSkills(value: unknown): CapabilitySkill[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`Skill at index ${index} must be an object`);
      }
      const record = entry as Record<string, unknown>;
      const id = normalizeName(record.id);
      const name = normalizeName(record.name);
      const skillPath = normalizeName(record.path);
      if (!id || !name || !skillPath) {
        throw new Error(`Skill at index ${index} requires id, name, and path`);
      }
      return {
        id,
        name,
        description: normalizeName(record.description) ?? undefined,
        path: skillPath,
      };
    });
  }

  private normalizeWorkflows(value: unknown): CapabilityWorkflow[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`Workflow at index ${index} must be an object`);
      }
      const record = entry as Record<string, unknown>;
      const id = normalizeName(record.id);
      const name = normalizeName(record.name);
      const workflowPath = normalizeName(record.path);
      if (!id || !name || !workflowPath) {
        throw new Error(`Workflow at index ${index} requires id, name, and path`);
      }
      return {
        id,
        name,
        description: normalizeName(record.description) ?? undefined,
        path: workflowPath,
      };
    });
  }

  private normalizeCronJobs(value: unknown): CapabilityCronJob[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`Cron job at index ${index} must be an object`);
      }
      const record = entry as Record<string, unknown>;
      const id = normalizeName(record.id);
      const name = normalizeName(record.name);
      const cronExpression = normalizeName(record.cronExpression);
      const prompt = normalizeName(record.prompt);
      if (!id || !name || !cronExpression || !prompt) {
        throw new Error(`Cron job at index ${index} requires id, name, cronExpression, and prompt`);
      }
      return {
        id,
        name,
        description: normalizeName(record.description) ?? undefined,
        cronExpression,
        prompt,
        enabled: record.enabled !== false,
        teamName: normalizeName(record.teamName) ?? undefined,
      };
    });
  }

  private normalizeMcpServers(value: unknown): CapabilityMcpServer[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`MCP server at index ${index} must be an object`);
      }
      const record = entry as Record<string, unknown>;
      const id = normalizeName(record.id);
      const name = normalizeName(record.name);
      const scope = normalizeName(record.scope);
      if (!id || !name || !this.isMcpScope(scope)) {
        throw new Error(`MCP server at index ${index} requires id, name, and supported scope`);
      }
      const config =
        record.config && typeof record.config === 'object' && !Array.isArray(record.config)
          ? { ...(record.config as Record<string, unknown>) }
          : undefined;
      return {
        id,
        name,
        scope,
        transport: normalizeName(record.transport) ?? undefined,
        config,
      };
    });
  }

  private isMcpScope(value: string | null): value is CapabilityMcpServer['scope'] {
    return value === 'local' || value === 'user' || value === 'project';
  }

  private async readPromptFile(packDir: string, relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
      throw new Error(`Unsafe capability command prompt path: ${relativePath}`);
    }

    const absolutePath = path.join(packDir, relativePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      throw new Error(`Capability command prompt must be a file: ${relativePath}`);
    }
    if (stat.size > MAX_COMMAND_PROMPT_BYTES) {
      throw new Error('Capability command prompt is too large');
    }
    return fs.readFile(absolutePath, 'utf8');
  }

  private async createLocalCapabilityPacks(): Promise<LoadedCapabilityPack[]> {
    const warnings: string[] = [];
    const cronJobs = await this.readLocalCronJobs(warnings);
    const teams = await this.readLocalTeams(warnings, cronJobs);

    const cronByKey = new Map<string, CapabilityCronJob[]>();
    for (const job of cronJobs) {
      const key = (job.teamName ?? '').trim();
      if (!key) continue;
      cronByKey.set(key, [...(cronByKey.get(key) ?? []), job]);
    }

    // The personal (cwd) team carries the operator's user-level + project-level
    // capabilities; real workspace teams carry only their own project caps, and
    // cron-only teams (no workspace) carry their schedules. Skills/MCP for the
    // personal pack are scanned once and reused.
    const personalWorkDir = teams.find((team) => team.isPersonal)?.workDir;
    const [personalSkills, personalMcpServers] = personalWorkDir
      ? await Promise.all([
          this.readLocalSkills(warnings, personalWorkDir),
          this.readLocalMcpServers(warnings, personalWorkDir),
        ])
      : ([[], []] as [CapabilitySkill[], CapabilityMcpServer[]]);
    const workflows = await this.toCapabilityWorkflows();

    const packs: LoadedCapabilityPack[] = [];
    for (const team of teams) {
      const cron = this.matchTeamCronJobs(team, cronByKey);
      let skills: CapabilitySkill[] = [];
      let mcpServers: CapabilityMcpServer[] = [];
      let packWorkflows: CapabilityWorkflow[] = [];
      if (team.isPersonal) {
        skills = personalSkills;
        mcpServers = personalMcpServers;
        packWorkflows = workflows;
      } else if (team.workDir) {
        [skills, mcpServers] = await Promise.all([
          this.readProjectSkills(warnings, team.workDir),
          this.readProjectMcpServers(warnings, team.workDir),
        ]);
      }
      const pack = this.buildLocalCapabilityPack({
        team,
        skills,
        mcpServers,
        workflows: packWorkflows,
        cron,
      });
      if (this.hasCapabilities(pack.manifest)) {
        packs.push({ ...pack, warnings: [...warnings] });
      }
    }
    return packs;
  }

  private async toCapabilityWorkflows(): Promise<CapabilityWorkflow[]> {
    const workflows = await listHermitWorkflows();
    return workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.label,
      description: workflow.description,
      path: `workflows/${workflow.filename}`,
    }));
  }

  private async readLocalTeams(
    warnings: string[],
    cronJobs: CapabilityCronJob[]
  ): Promise<LocalTeamEntry[]> {
    if (this.localSource.listTeams) {
      try {
        const teams = await this.localSource.listTeams();
        const cwd = this.localSource.projectPath;
        const cwdName = cwd ? path.basename(cwd) : '';
        return teams.map((team) => ({
          ...team,
          isPersonal:
            Boolean(cwd) &&
            (team.workDir === cwd || (Boolean(cwdName) && team.displayName === cwdName)),
        }));
      } catch (error) {
        warnings.push('Unable to enumerate teams for local capability packs.');
        logger.warn('Failed to enumerate teams for capability packs', error);
        return [];
      }
    }
    // 无团队枚举器时回退：当前项目作为 personal 团队，并按 cron 的 project 字段
    // 派生出额外团队（每个 project 一个本地能力包）。
    const projectPath = this.localSource.projectPath;
    if (!projectPath) return [];
    const personalName = path.basename(projectPath) || LOCAL_CAPABILITY_FALLBACK_TEAM;
    const seen = new Set([personalName.toLowerCase()]);
    const teams: LocalTeamEntry[] = [
      {
        slug: this.slugify(personalName),
        displayName: personalName,
        workDir: projectPath,
        isPersonal: true,
      },
    ];
    for (const job of cronJobs) {
      const project = (job.teamName ?? '').trim();
      if (!project || seen.has(project.toLowerCase())) continue;
      seen.add(project.toLowerCase());
      teams.push({ slug: this.slugify(project), displayName: project, bindProject: project });
    }
    return teams;
  }

  private matchTeamCronJobs(
    team: LocalTeamEntry,
    cronByKey: Map<string, CapabilityCronJob[]>
  ): CapabilityCronJob[] {
    const keys = [team.bindProject, team.slug, team.displayName]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const matched = new Map<string, CapabilityCronJob>();
    for (const key of keys) {
      for (const job of cronByKey.get(key) ?? []) {
        matched.set(job.id, job);
      }
    }
    return [...matched.values()];
  }

  private buildLocalCapabilityPack(input: {
    team: LocalTeamEntry;
    skills: CapabilitySkill[];
    mcpServers: CapabilityMcpServer[];
    workflows: CapabilityWorkflow[];
    cron: CapabilityCronJob[];
  }): LoadedCapabilityPack {
    const { team, skills, mcpServers, workflows, cron } = input;
    const slug = this.slugify(team.slug || team.displayName);
    // The personal (cwd) team keeps the legacy bare id so existing exports that
    // reference `local-capabilities` keep resolving to it.
    const id = team.isPersonal ? LOCAL_CAPABILITY_PACK_ID : `${LOCAL_CAPABILITY_PACK_ID}-${slug}`;
    return {
      manifest: {
        schemaVersion: 1,
        id,
        name: `${team.displayName} 能力`,
        namespace: LOCAL_CAPABILITY_PACK_NAMESPACE,
        version: '1.0.0',
        author: 'AgentCLI',
        description: `${team.displayName} 工作空间的本地能力（skills、MCP、定时任务），可按运行时导出。`,
        tags: ['local'],
        teamName: team.displayName,
        capabilities: {
          commands: [],
          skills,
          workflows,
          cron,
          mcpServers,
        },
      },
      packDir: team.workDir ?? this.localSource.projectPath ?? getHermitHome(),
      source: 'local' as const,
      enabled: true,
      warnings: [],
    };
  }

  private hasCapabilities(manifest: CapabilityPackManifest): boolean {
    return Boolean(
      manifest.capabilities.commands?.length ||
      manifest.capabilities.skills?.length ||
      manifest.capabilities.workflows?.length ||
      manifest.capabilities.cron?.length ||
      manifest.capabilities.mcpServers?.length
    );
  }

  private isLocalCapabilityPackId(packId: string): boolean {
    return packId === LOCAL_CAPABILITY_PACK_ID || packId.startsWith(`${LOCAL_CAPABILITY_PACK_ID}-`);
  }

  private async readLocalSkills(warnings: string[], workDir?: string): Promise<CapabilitySkill[]> {
    try {
      const skills = await this.skillsCatalog.list(workDir ?? this.localSource.projectPath);
      return skills.map((skill) => this.toCapabilitySkill(skill));
    } catch (error) {
      warnings.push('Unable to scan local skills.');
      logger.warn('Failed to scan local skills for capability pack', error);
      return [];
    }
  }

  private async readProjectSkills(
    warnings: string[],
    projectPath?: string
  ): Promise<CapabilitySkill[]> {
    try {
      const skills = await this.skillsCatalog.list(projectPath ?? this.localSource.projectPath);
      return skills
        .filter((skill) => skill.scope !== 'user')
        .map((skill) => this.toCapabilitySkill(skill));
    } catch (error) {
      warnings.push('Unable to scan project skills.');
      logger.warn('Failed to scan project skills for capability pack', error);
      return [];
    }
  }

  private toCapabilitySkill(skill: SkillCatalogItem): CapabilitySkill {
    return {
      id: this.slugify(skill.folderName || skill.name),
      name: skill.name,
      description: skill.description,
      path: skill.skillDir,
    };
  }

  private async readLocalMcpServers(
    warnings: string[],
    workDir?: string
  ): Promise<CapabilityMcpServer[]> {
    try {
      const servers = await this.mcpReader.readConfigured(workDir ?? this.localSource.projectPath);
      return servers.map((server) => this.toCapabilityMcpServer(server));
    } catch (error) {
      warnings.push('Unable to scan local MCP servers.');
      logger.warn('Failed to scan local MCP servers for capability pack', error);
      return [];
    }
  }

  private async readProjectMcpServers(
    warnings: string[],
    projectPath?: string
  ): Promise<CapabilityMcpServer[]> {
    try {
      const servers = await this.mcpReader.readConfigured(
        projectPath ?? this.localSource.projectPath
      );
      return servers
        .filter((server) => server.scope !== 'user')
        .map((server) => this.toCapabilityMcpServer(server));
    } catch (error) {
      warnings.push('Unable to scan project MCP servers.');
      logger.warn('Failed to scan project MCP servers for capability pack', error);
      return [];
    }
  }

  private toCapabilityMcpServer(server: {
    name: string;
    scope: 'local' | 'user' | 'project';
    transport?: string;
    config?: Record<string, unknown>;
  }): CapabilityMcpServer {
    return {
      id: this.slugify(server.name),
      name: server.name,
      scope: server.scope,
      transport: server.transport,
      config: server.config,
    };
  }

  private async readLocalCronJobs(warnings: string[]): Promise<CapabilityCronJob[]> {
    if (!this.localSource.listCronJobs) return [];
    try {
      const jobs = await this.localSource.listCronJobs();
      return jobs.map((job) => ({
        id: this.slugify(job.id),
        name: job.description?.trim() || job.id,
        description: job.description,
        cronExpression: job.cron_expr,
        prompt: job.prompt,
        enabled: job.enabled,
        teamName: job.project,
      }));
    } catch (error) {
      warnings.push('Unable to scan local cron schedules.');
      logger.warn('Failed to scan local cron jobs for capability pack', error);
      return [];
    }
  }

  private async exportBuiltinPack(
    destination: string,
    runtime: CapabilityPackExportRuntime
  ): Promise<LoadedCapabilityPack> {
    const pack = await createBuiltinHermitOpsPack();
    await fs.mkdir(path.join(destination, 'workflows'), { recursive: true });
    for (const workflow of await listHermitWorkflows()) {
      await fs.writeFile(
        path.join(destination, 'workflows', workflow.filename),
        workflow.content,
        'utf8'
      );
    }
    await fs.writeFile(
      path.join(destination, MANIFEST_FILENAME),
      `${JSON.stringify(pack.manifest, null, 2)}\n`,
      'utf8'
    );
    await this.writeRuntimeExportDescriptor(destination, runtime, pack.manifest);
    return { ...pack, packDir: destination };
  }

  private async exportLocalPack(
    packId: string,
    destination: string,
    runtime: CapabilityPackExportRuntime
  ): Promise<LoadedCapabilityPack> {
    const localPacks = await this.createLocalCapabilityPacks();
    const pack = localPacks.find((entry) => entry.manifest.id === packId);
    if (!pack) {
      throw new Error(`Local capability pack ${packId} is not available`);
    }
    await fs.mkdir(destination, { recursive: true });
    await fs.mkdir(path.join(destination, 'skills'), { recursive: true });
    await fs.mkdir(path.join(destination, 'workflows'), { recursive: true });
    await fs.mkdir(path.join(destination, 'cron'), { recursive: true });
    await fs.mkdir(path.join(destination, 'mcp'), { recursive: true });

    const exportWarnings: string[] = [];
    for (const skill of pack.manifest.capabilities.skills ?? []) {
      if (!path.isAbsolute(skill.path) || !(await this.pathExists(skill.path))) continue;
      try {
        exportWarnings.push(
          ...(await this.copyDirectory(skill.path, path.join(destination, 'skills', skill.id)))
        );
      } catch (error) {
        exportWarnings.push(
          `Skipped skill ${skill.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    for (const workflow of await listHermitWorkflows()) {
      await fs.writeFile(
        path.join(destination, 'workflows', workflow.filename),
        workflow.content,
        'utf8'
      );
    }

    const exportManifest = this.toPortableExportManifest(pack.manifest);

    await Promise.all([
      fs.writeFile(
        path.join(destination, MANIFEST_FILENAME),
        `${JSON.stringify(exportManifest, null, 2)}\n`,
        'utf8'
      ),
      fs.writeFile(
        path.join(destination, 'cron', 'schedules.json'),
        `${JSON.stringify(exportManifest.capabilities.cron ?? [], null, 2)}\n`,
        'utf8'
      ),
      fs.writeFile(
        path.join(destination, 'mcp', 'servers.json'),
        `${JSON.stringify(exportManifest.capabilities.mcpServers ?? [], null, 2)}\n`,
        'utf8'
      ),
      this.writeRuntimeExportDescriptor(destination, runtime, exportManifest),
    ]);

    return { ...pack, manifest: exportManifest, packDir: destination, warnings: exportWarnings };
  }

  private toPortableExportManifest(manifest: CapabilityPackManifest): CapabilityPackManifest {
    return {
      ...manifest,
      capabilities: {
        ...manifest.capabilities,
        skills: (manifest.capabilities.skills ?? []).map((skill) => ({
          ...skill,
          path: `skills/${skill.id}`,
        })),
        mcpServers: (manifest.capabilities.mcpServers ?? []).map(
          ({ config: _config, ...server }) => server
        ),
      },
    };
  }

  private async writeRuntimeExportDescriptor(
    destination: string,
    runtime: CapabilityPackExportRuntime,
    manifest: CapabilityPackManifest
  ): Promise<void> {
    await fs.mkdir(path.join(destination, 'runtime'), { recursive: true });
    const payload = {
      runtime,
      schemaVersion: 1,
      packId: manifest.id,
      exportedAt: new Date().toISOString(),
      layout: {
        skills: 'skills/',
        cron: 'cron/schedules.json',
        workflows: 'workflows/',
        mcp: 'mcp/servers.json',
      },
      counts: {
        skills: manifest.capabilities.skills?.length ?? 0,
        cron: manifest.capabilities.cron?.length ?? 0,
        workflows: manifest.capabilities.workflows?.length ?? 0,
        mcpServers: manifest.capabilities.mcpServers?.length ?? 0,
      },
    };
    await fs.writeFile(
      path.join(destination, 'runtime', `${runtime}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8'
    );
  }

  private resolveExportDestinationRoot(
    destinationDir: string | undefined,
    runtime: CapabilityPackExportRuntime
  ): string {
    if (!destinationDir) {
      return path.join(getHermitHome(), 'exports', 'capability-packs', runtime);
    }

    const validatedDestination = validateOpenPathUserSelected(destinationDir);
    if (!validatedDestination.valid || !validatedDestination.normalizedPath) {
      throw new Error(validatedDestination.error ?? 'Invalid export destination');
    }
    return validatedDestination.normalizedPath;
  }

  private normalizeExportRuntime(
    runtime: CapabilityPackExportRequest['runtime']
  ): CapabilityPackExportRuntime {
    if (!runtime) return 'claudecode';
    if (!SUPPORTED_EXPORT_RUNTIMES.has(runtime)) {
      throw new Error(`Unsupported export runtime: ${runtime}`);
    }
    return runtime;
  }

  private slugify(value: string): string {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'capability';
  }

  private async validateReferencedFiles(
    packDir: string,
    manifest: CapabilityPackManifest
  ): Promise<string[]> {
    const warnings: string[] = [];
    const references = [
      ...(manifest.capabilities.commands ?? []).map((command) => command.prompt),
      ...(manifest.capabilities.skills ?? []).map((skill) => skill.path),
      ...(manifest.capabilities.workflows ?? []).map((workflow) => workflow.path),
    ];

    for (const relativePath of references) {
      if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
        warnings.push(`Ignored unsafe path reference: ${relativePath}`);
        continue;
      }
      if (!(await this.pathExists(path.join(packDir, relativePath)))) {
        warnings.push(`Missing referenced file or folder: ${relativePath}`);
      }
    }

    return warnings;
  }

  private async copyDirectory(sourceDir: string, targetDir: string): Promise<string[]> {
    const { files, warnings } = await this.walkDirectory(sourceDir);
    await fs.mkdir(targetDir, { recursive: true });
    for (const file of files) {
      const targetPath = path.join(targetDir, file.relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(file.absolutePath, targetPath);
    }
    return warnings;
  }

  private async walkDirectory(rootDir: string): Promise<{
    files: {
      absolutePath: string;
      relativePath: string;
    }[];
    warnings: string[];
  }> {
    const allFiles: { absolutePath: string; relativePath: string }[] = [];
    const warnings: string[] = [];
    let totalBytes = 0;

    const visit = async (currentDir: string): Promise<void> => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isSymbolicLink()) {
          warnings.push(
            `Skipped symbolic link: ${path.relative(rootDir, fullPath).replace(/\\/g, '/')}`
          );
          continue;
        }

        if (entry.isDirectory()) {
          await visit(fullPath);
          continue;
        }

        const stat = await fs.stat(fullPath);
        totalBytes += stat.size;
        if (allFiles.length + 1 > MAX_PACK_FILE_COUNT) {
          throw new Error(`Capability pack has too many files (max ${MAX_PACK_FILE_COUNT})`);
        }
        if (totalBytes > MAX_PACK_TOTAL_BYTES) {
          throw new Error(
            `Capability pack is too large (max ${Math.floor(MAX_PACK_TOTAL_BYTES / (1024 * 1024))} MB)`
          );
        }

        allFiles.push({
          absolutePath: fullPath,
          relativePath: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
        });
      }
    };

    await visit(rootDir);
    return {
      files: allFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      warnings,
    };
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
