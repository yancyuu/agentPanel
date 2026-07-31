/**
 * TeamWorkspaceService — 团队本地存储管理。
 *
 * 设计（v2）:
 *   - 一个 Team = 一个 cc-connect project
 *   - 无 Member 子层级，team 本身就是 agent
 *   - 渠道（platform）配置在 cc-connect project 上，hermit 不重复存储
 *
 * 目录布局 (~/.hermit/teams/<team-slug>/):
 *   ├─ team.json              # 团队元数据
 *   ├─ messages/group.jsonl   # 消息记录
 *   └─ tasks/board.json       # 任务看板
 */

import { resolveExternalPlatformSessionTeamSlug } from '@main/utils/externalPlatformSessionRouting';
import { createLogger } from '@shared/utils/logger';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  AgentCapability,
  DiscoverableTeam,
  SourceMessageSnapshot,
  TaskAttachmentMeta,
  TaskComment,
  TaskHistoryEvent,
  TaskRef,
  TaskWorkInterval,
  TeamReviewState,
} from '@shared/types/team';

const logger = createLogger('TeamWorkspace');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 团队元数据，存储在 team.json */
export interface TeamManifest {
  schemaVersion: 2;
  slug: string;
  displayName: string;
  /** cc-connect project name — 渠道和 agent 运行时的载体 */
  bindProject: string;
  /** agent 类型，用于 MCP 配置注入等 harness 特定逻辑 */
  harness: string;
  /** agent runtime 工作目录（cc-connect project work_dir） */
  workDir: string;
  color?: string;
  description?: string;
  language?: string;
  permissionMode?: string;
  showContextIndicator?: boolean;
  replyFooter?: boolean;
  injectSender?: boolean;
  managedSources?: string;
  disabledCommands?: string[];
  platformAllowFrom?: Record<string, string>;
  /** 群聊允许的 chat ID（按平台） */
  platformAllowChat?: Record<string, string>;
  /** ISO timestamp — set when the team is soft-deleted. */
  deletedAt?: string;
  pendingDelete?: boolean;
  restartRequired?: boolean;
  /**
   * 协同模式开关（默认 true）。
   * true  = 团队可作为任务 assignee 接收其他团队派发的任务（Task Dispatcher 推消息）。
   * false = 独立作战，不接收跨团队任务派发，也不对外派发。
   */
  collaboration?: boolean;
  /** 平台/渠道类型（默认 bridge） */
  platform?: string;
  /** 平台特定选项 */
  platformOptions?: Record<string, string>;
  rootPath: string;
  createdAt: string;
}

export interface CreateTeamInput {
  displayName: string;
  /** cc-connect project name */
  bindProject: string;
  harness: string;
  workDir: string;
  color?: string;
  description?: string;
  language?: string;
  /** 协同模式，默认 true */
  collaboration?: boolean;
  /** 平台/渠道类型 */
  platform?: string;
  /** 平台特定选项 */
  platformOptions?: Record<string, string>;
}

export interface GroupMessage {
  id: string;
  ts: string;
  from: string;
  to: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  meta?: Record<string, unknown> | null;
}

interface HiddenSessionRecord {
  sessionId: string;
  hiddenAt: string;
  reason: 'archived';
}

interface HiddenSessionsIndex {
  version: 1;
  updatedAt: string;
  sessions: Record<string, HiddenSessionRecord>;
}

export interface AppendGroupMessageInput {
  id?: string;
  from: string;
  to?: string;
  role?: GroupMessage['role'];
  content: string;
  meta?: Record<string, unknown> | null;
}

export type TaskStatus = 'todo' | 'doing' | 'done';

export interface Task {
  id: string;
  teamSlug: string;
  title: string;
  description?: string;
  descriptionTaskRefs?: TaskRef[];
  activeForm?: string;
  prompt?: string;
  promptTaskRefs?: TaskRef[];
  status: TaskStatus;
  /** 面向用户展示的负责人名称。 */
  assignee?: string | null;
  /** 实际执行数字员工的稳定 team slug，用于协作任务路由。 */
  assigneeAgentId?: string;
  /** 协作总任务的父任务 ID。 */
  parentTaskId?: string;
  /** 所属多 Agent 协作运行 ID。 */
  collaborationRunId?: string;
  /** 协作任务类型。 */
  taskKind?: 'root' | 'subtask';
  createdBy?: string;
  workIntervals?: TaskWorkInterval[];
  historyEvents?: TaskHistoryEvent[];
  blocks?: string[];
  blockedBy?: string[];
  related?: string[];
  comments?: TaskComment[];
  needsClarification?: 'lead' | 'user';
  deletedAt?: string;
  attachments?: TaskAttachmentMeta[];
  reviewState?: TeamReviewState;
  sourceMessageId?: string;
  sourceMessage?: SourceMessageSnapshot;
  /** agent 完成任务后写入的结果摘要 */
  result?: string | null;
  createdAt: string;
  updatedAt: string;
  order: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hermitHome(): string {
  return process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit');
}

export function toSlug(input: string, fallback = 'team'): string {
  const ascii = String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return ascii || fallback;
}

export function isValidBindProject(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function assertValidBindProject(value: string): void {
  if (!isValidBindProject(value)) {
    throw new Error(
      'bindProject must contain only lowercase ASCII letters, digits, hyphens, and underscores, and start with a letter or digit'
    );
  }
}

export function teamsRoot(): string {
  return path.join(hermitHome(), 'teams');
}

export function teamRoot(teamSlug: string): string {
  return path.join(teamsRoot(), teamSlug);
}

function isExternalPlatformSlug(teamSlug: string): boolean {
  return /^(feishu|lark|weixin|telegram|discord|slack):/.test(teamSlug);
}

export function groupSessionKey(teamSlug: string): string {
  return `hermit:${teamSlug}:session`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    // File missing or corrupted JSON — return fallback silently
    return fallback;
  }
}

async function writeJson(p: string, data: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  // Include a random suffix so two concurrent writes to the same board (same
  // pid) don't share one tmp path and silently clobber each other's data.
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.promises.rename(tmp, p);
}

function nextIsoTimestamp(previous?: string): string {
  const previousTime = previous ? Date.parse(previous) : NaN;
  const nextTime = Number.isFinite(previousTime)
    ? Math.max(Date.now(), previousTime + 1)
    : Date.now();
  return new Date(nextTime).toISOString();
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TeamWorkspaceService {
  private readonly boardMutationTail = new Map<string, Promise<unknown>>();

  private async serializeBoardMutation<T>(
    teamSlug: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.boardMutationTail.get(teamSlug) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.boardMutationTail.set(teamSlug, current);
    try {
      return await current;
    } finally {
      if (this.boardMutationTail.get(teamSlug) === current) this.boardMutationTail.delete(teamSlug);
    }
  }

  private async readTeamManifestByStorageSlug(storageSlug: string): Promise<TeamManifest> {
    const root = teamRoot(storageSlug);
    const manifest = await readJson<TeamManifest | null>(path.join(root, 'team.json'), null);
    if (!manifest) {
      if (!(await pathExists(root))) {
        throw new Error(`团队 "${storageSlug}" 不存在 (${root})`);
      }
      const stat = await fs.promises.stat(root).catch(() => null);
      return {
        schemaVersion: 2,
        slug: storageSlug,
        displayName: storageSlug,
        bindProject: storageSlug,
        harness: 'claudecode',
        workDir: '',
        collaboration: true,
        rootPath: root,
        createdAt: (stat?.birthtime ?? stat?.mtime ?? new Date()).toISOString(),
      };
    }
    return manifest;
  }

  private async resolveStorageSlug(teamSlug: string): Promise<string> {
    if (await pathExists(path.join(teamRoot(teamSlug), 'team.json'))) {
      return teamSlug;
    }
    const teams = await this.listTeams();
    const directMatch = teams.find((manifest) => manifest.bindProject === teamSlug);
    if (directMatch) return directMatch.slug;
    if (isExternalPlatformSlug(teamSlug)) {
      const platformMatch = resolveExternalPlatformSessionTeamSlug(teamSlug, teams);
      if (platformMatch) return platformMatch;
    }
    return teamSlug;
  }

  private async createUniqueStorageSlug(bindProject: string): Promise<string> {
    assertValidBindProject(bindProject);
    const baseSlug = bindProject;
    let slug = baseSlug;
    let suffix = 2;
    while (await pathExists(path.join(teamRoot(slug), 'team.json'))) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    return slug;
  }

  async createTeam(
    input: CreateTeamInput
  ): Promise<{ slug: string; root: string; manifest: TeamManifest }> {
    const displayName = input.displayName.trim();
    const bindProject = input.bindProject.trim();
    if (!displayName) throw new Error('displayName is required');
    if (!bindProject) throw new Error('bindProject is required');
    if (!input.workDir) throw new Error('workDir is required');
    assertValidBindProject(bindProject);

    const slug = await this.createUniqueStorageSlug(bindProject);
    const root = teamRoot(slug);

    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.mkdir(path.join(root, 'messages'), { recursive: true });
    await fs.promises.mkdir(path.join(root, 'tasks'), { recursive: true });

    const manifest: TeamManifest = {
      schemaVersion: 2,
      slug,
      displayName,
      bindProject,
      harness: input.harness,
      workDir: input.workDir,
      color: input.color,
      description: input.description,
      language: input.language,
      collaboration: input.collaboration ?? true,
      platform: input.platform,
      platformOptions: input.platformOptions,
      rootPath: root,
      createdAt: new Date().toISOString(),
    };

    await writeJson(path.join(root, 'team.json'), manifest);
    logger.info(`created team ${slug} → cc-project:${bindProject}`);
    return { slug, root, manifest };
  }

  async readTeamManifest(teamSlug: string): Promise<TeamManifest> {
    const storageSlug = await this.resolveStorageSlug(teamSlug);
    return this.readTeamManifestByStorageSlug(storageSlug);
  }

  async readTeamManifestByProject(projectName: string): Promise<TeamManifest> {
    return this.readTeamManifest(projectName);
  }

  async listTeams(): Promise<TeamManifest[]> {
    const dir = teamsRoot();
    if (!(await pathExists(dir))) return [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const out: TeamManifest[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      try {
        out.push(await this.readTeamManifestByStorageSlug(e.name));
      } catch {
        // skip broken dirs
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Discover local teams for the /api/workers endpoint (Digital Workers).
   * Migrated from TaskDispatchService when cross-team/Redis was removed.
   */
  async discoverTeams(): Promise<DiscoverableTeam[]> {
    const localTeams = await this.listTeams();
    return localTeams.map((team) => ({
      slug: team.slug,
      displayName: team.displayName ?? team.slug,
      location: 'local' as const,
      status: 'online' as const,
      collaboration: team.collaboration !== false,
      description: team.description,
      harness: team.harness,
      capabilities: this.inferCapabilities(team),
      workDir: team.workDir,
    }));
  }

  private inferCapabilities(team: TeamManifest): AgentCapability[] {
    const caps: AgentCapability[] = [];
    if (team.harness) {
      caps.push({ skill: team.harness, description: `${team.harness} agent` });
    }
    if (team.description) {
      caps.push({ skill: 'general', description: team.description });
    }
    return caps;
  }

  async updateTeam(
    teamSlug: string,
    patch: Partial<
      Pick<
        TeamManifest,
        | 'displayName'
        | 'bindProject'
        | 'color'
        | 'description'
        | 'collaboration'
        | 'harness'
        | 'workDir'
        | 'language'
        | 'permissionMode'
        | 'showContextIndicator'
        | 'replyFooter'
        | 'injectSender'
        | 'managedSources'
        | 'disabledCommands'
        | 'platform'
        | 'platformOptions'
        | 'platformAllowFrom'
        | 'platformAllowChat'
        | 'deletedAt'
        | 'pendingDelete'
        | 'restartRequired'
      >
    >
  ): Promise<TeamManifest> {
    const manifest = await this.readTeamManifest(teamSlug);
    const updated: TeamManifest = { ...manifest, ...patch };
    await writeJson(path.join(manifest.rootPath, 'team.json'), updated);
    return updated;
  }

  async deleteTeam(teamSlug: string, opts: { deleteFiles?: boolean } = {}): Promise<void> {
    const manifest = await this.readTeamManifest(teamSlug);
    const root = manifest.rootPath;
    if (opts.deleteFiles) {
      await fs.promises.rm(root, { recursive: true, force: true });
      logger.info(`permanently deleted team ${manifest.slug}`);
      return;
    }

    const updated: TeamManifest = {
      ...manifest,
      deletedAt: manifest.deletedAt ?? new Date().toISOString(),
      pendingDelete: false,
      restartRequired: false,
    };
    await writeJson(path.join(root, 'team.json'), updated);
    logger.info(`soft-deleted team ${manifest.slug}`);
  }

  async restoreTeam(teamSlug: string): Promise<void> {
    const manifest = await this.readTeamManifest(teamSlug);
    const {
      deletedAt: _deletedAt,
      pendingDelete: _pendingDelete,
      restartRequired: _restartRequired,
      ...rest
    } = manifest;
    await writeJson(path.join(manifest.rootPath, 'team.json'), rest);
    logger.info(`restored team ${manifest.slug}`);
  }

  // ---- 会话归档 ----

  private async hiddenSessionsIndexPath(teamSlug: string): Promise<string> {
    const storageSlug = await this.resolveStorageSlug(teamSlug);
    return path.join(teamRoot(storageSlug), 'sessions', 'hidden.json');
  }

  async readHiddenSessionIds(teamSlug: string): Promise<Set<string>> {
    const file = await this.hiddenSessionsIndexPath(teamSlug);
    const index = await readJson<HiddenSessionsIndex>(file, {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      sessions: {},
    });
    return new Set(
      Object.values(index.sessions ?? {})
        .map((record) => record.sessionId?.trim())
        .filter((sessionId): sessionId is string => Boolean(sessionId))
    );
  }

  async hideSession(teamSlug: string, sessionId: string): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) throw new Error('sessionId is required');

    const file = await this.hiddenSessionsIndexPath(teamSlug);
    const existing = await readJson<HiddenSessionsIndex>(file, {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      sessions: {},
    });
    const now = new Date().toISOString();
    await writeJson(file, {
      version: 1,
      updatedAt: now,
      sessions: {
        ...(existing.sessions ?? {}),
        [normalizedSessionId]: {
          sessionId: normalizedSessionId,
          hiddenAt: existing.sessions?.[normalizedSessionId]?.hiddenAt ?? now,
          reason: 'archived',
        },
      },
    } satisfies HiddenSessionsIndex);
  }

  // ---- 消息记录 ----

  async appendMessage(teamSlug: string, msg: AppendGroupMessageInput): Promise<GroupMessage> {
    const storageSlug = await this.resolveStorageSlug(teamSlug);
    if (storageSlug === teamSlug && isExternalPlatformSlug(teamSlug)) {
      throw new Error(`外部平台 session_key 不能作为 AgentCLI team slug 写入消息: ${teamSlug}`);
    }
    const file = path.join(teamRoot(storageSlug), 'messages', 'group.jsonl');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const entry: GroupMessage = {
      id: msg.id || `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      from: msg.from,
      to: msg.to || 'team',
      role: msg.role || (msg.from === 'user' ? 'user' : 'agent'),
      content: msg.content,
      meta: msg.meta ?? null,
    };
    await fs.promises.appendFile(file, JSON.stringify(entry) + '\n');
    return entry;
  }

  private async readGroupMessageFile(file: string): Promise<GroupMessage[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const lines = raw.split(/\n+/).filter(Boolean);
    const all: GroupMessage[] = [];
    for (const line of lines) {
      try {
        all.push(JSON.parse(line) as GroupMessage);
      } catch {
        /* skip */
      }
    }
    return all;
  }

  private async findLegacyExternalMessageFiles(storageSlug: string): Promise<string[]> {
    const dir = teamsRoot();
    if (!(await pathExists(dir))) return [];
    const manifests = await this.listTeams();
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isExternalPlatformSlug(entry.name))
      .filter(
        (entry) => resolveExternalPlatformSessionTeamSlug(entry.name, manifests) === storageSlug
      )
      .map((entry) => path.join(dir, entry.name, 'messages', 'group.jsonl'));
  }

  async readMessages(teamSlug: string, opts: { limit?: number } = {}): Promise<GroupMessage[]> {
    const limit = opts.limit ?? 200;
    const storageSlug = await this.resolveStorageSlug(teamSlug);
    if (storageSlug === teamSlug && isExternalPlatformSlug(teamSlug)) return [];

    const files = [
      path.join(teamRoot(storageSlug), 'messages', 'group.jsonl'),
      ...(await this.findLegacyExternalMessageFiles(storageSlug)),
    ];
    const all = (await Promise.all(files.map((file) => this.readGroupMessageFile(file)))).flat();
    all.sort((a, b) => a.ts.localeCompare(b.ts));
    return all.length <= limit ? all : all.slice(all.length - limit);
  }

  // ---- 任务看板 ----

  private async readBoard(teamSlug: string): Promise<{ tasks: Task[] }> {
    const storageSlug = await this.resolveStorageSlug(teamSlug);
    return readJson<{ tasks: Task[] }>(path.join(teamRoot(storageSlug), 'tasks', 'board.json'), {
      tasks: [],
    });
  }

  private async writeBoard(teamSlug: string, board: { tasks: Task[] }): Promise<void> {
    const storageSlug = await this.resolveStorageSlug(teamSlug);
    await writeJson(path.join(teamRoot(storageSlug), 'tasks', 'board.json'), board);
  }

  async readTasks(teamSlug: string): Promise<Task[]> {
    const board = await this.readBoard(teamSlug);
    return Array.isArray(board.tasks) ? board.tasks : [];
  }

  async createTask(
    teamSlug: string,
    payload: {
      title: string;
      description?: string;
      descriptionTaskRefs?: TaskRef[];
      prompt?: string;
      promptTaskRefs?: TaskRef[];
      assignee?: string | null;
      assigneeAgentId?: string;
      parentTaskId?: string;
      collaborationRunId?: string;
      taskKind?: 'root' | 'subtask';
      status?: TaskStatus;
      blockedBy?: string[];
      related?: string[];
      createdBy?: string;
    }
  ): Promise<Task> {
    if (!payload?.title) throw new Error('title is required');
    return this.serializeBoardMutation(teamSlug, async () => {
      const board = await this.readBoard(teamSlug);
      const status: TaskStatus = payload.status || 'todo';
      const sameCol = (board.tasks || []).filter((task) => task.status === status);
      const order =
        sameCol.length > 0 ? Math.max(...sameCol.map((task) => task.order || 0)) + 1 : 0;
      const now = new Date().toISOString();
      const task: Task = {
        id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        teamSlug,
        title: payload.title,
        description: payload.description || '',
        descriptionTaskRefs: payload.descriptionTaskRefs,
        prompt: payload.prompt,
        promptTaskRefs: payload.promptTaskRefs,
        status,
        assignee: payload.assignee ?? null,
        assigneeAgentId: payload.assigneeAgentId,
        parentTaskId: payload.parentTaskId,
        collaborationRunId: payload.collaborationRunId,
        taskKind: payload.taskKind,
        blockedBy: payload.blockedBy,
        related: payload.related,
        createdBy: payload.createdBy,
        result: null,
        createdAt: now,
        updatedAt: now,
        order,
      };
      board.tasks = [...(board.tasks || []), task];
      await this.writeBoard(teamSlug, board);
      return task;
    });
  }

  async patchTask(teamSlug: string, taskId: string, patch: Partial<Task>): Promise<Task> {
    return this.serializeBoardMutation(teamSlug, async () => {
      const board = await this.readBoard(teamSlug);
      const index = (board.tasks || []).findIndex((task) => task.id === taskId);
      if (index < 0) throw new Error(`task not found: ${taskId}`);
      const existing = board.tasks[index];
      const next: Task = {
        ...existing,
        ...patch,
        id: existing.id,
        teamSlug: existing.teamSlug,
        updatedAt: nextIsoTimestamp(existing.updatedAt),
      };
      board.tasks[index] = next;
      await this.writeBoard(teamSlug, board);
      return next;
    });
  }

  async deleteTask(teamSlug: string, taskId: string): Promise<boolean> {
    return this.serializeBoardMutation(teamSlug, async () => {
      const board = await this.readBoard(teamSlug);
      const before = (board.tasks || []).length;
      board.tasks = (board.tasks || []).filter((task) => task.id !== taskId);
      if (board.tasks.length === before) return false;
      await this.writeBoard(teamSlug, board);
      return true;
    });
  }
}
