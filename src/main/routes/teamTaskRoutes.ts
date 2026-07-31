import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TEXT_FILE_EXTENSIONS } from '@shared/constants/attachments';
import { getDerivedReviewState } from '@shared/utils/taskHistory';

import {
  asFeedbackAnchor,
  historyEventId,
  HUMAN_INTERVENTION_REVISION_THRESHOLD,
} from '../services/team-management/mcpTaskTools';
import { archiveTaskDeliverable } from '../services/team-management/TaskDeliverableArchiveService';
import {
  type Task,
  type TaskStatus,
  teamRoot,
} from '../services/team-management/TeamWorkspaceService';

import type {
  FeedbackAnchor,
  GlobalTask,
  TaskAttachmentMeta,
  TaskComment,
  TaskHistoryEvent,
  TaskRef,
  TeamReviewState,
  TeamTask,
  TeamTaskStatus,
  UpdateKanbanPatch,
} from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

interface TeamTaskRouteDependencies {
  readTasks(teamName: string): Promise<Task[]>;
  createTask(
    teamName: string,
    payload: {
      title: string;
      description?: string;
      descriptionTaskRefs?: TaskRef[];
      prompt?: string;
      promptTaskRefs?: TaskRef[];
      assignee?: string | null;
      status?: TaskStatus;
      blockedBy?: string[];
      related?: string[];
      createdBy?: string;
    }
  ): Promise<Task>;
  patchTask(teamName: string, taskId: string, patch: Partial<Task>): Promise<Task>;
  addDelivery(
    teamName: string,
    taskId: string,
    input: { result: string; summary?: string; addressedFeedbackIds?: string[] }
  ): Promise<unknown>;
  addFeedbackItem(
    teamName: string,
    taskId: string,
    input: { text: string; anchor?: FeedbackAnchor }
  ): Promise<unknown>;
  appendTaskHistoryEvent(teamName: string, taskId: string, event: TaskHistoryEvent): Promise<Task>;
  dispatchTask(teamName: string, task: Task): Promise<void>;
  listProjects(): Promise<{ name: string }[]>;
  listTeams?(): Promise<{ slug: string }[]>;
  readTeamManifest(teamName: string): Promise<{
    slug: string;
    displayName?: string;
    deletedAt?: string;
  }>;
  broadcastTaskChange?(teamName: string, taskId: string): void;
  requestCollaborationChanges?(
    runId: string,
    feedback: string,
    beforeStart?: () => Promise<void>
  ): Promise<unknown>;
  reply500(error: unknown): { ok: boolean; error: string };
}

type TeamTaskRouteSection =
  | 'core'
  | 'compatibility'
  | 'actions'
  | 'review-aliases'
  | 'late-aliases';

interface TeamTaskRouteOptions {
  routes?: TeamTaskRouteSection[];
}

export type TeamTaskResponse = TeamTask & {
  displayId: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

type GlobalTaskResponse = TeamTaskResponse &
  Pick<GlobalTask, 'teamName' | 'teamDisplayName' | 'teamDeleted'>;

/** TeamTask status → internal Task status. */
export function toTaskStatus(status: string): TaskStatus {
  if (status === 'in_progress') return 'doing';
  if (status === 'completed') return 'done';
  return 'todo';
}

function isManualInProgressExitBlocked(
  currentStatus: string | undefined,
  nextStatus: TaskStatus | undefined
): boolean {
  return currentStatus === 'doing' && nextStatus !== undefined && nextStatus !== 'doing';
}

/** Internal Task → TeamTask shape consumed by the renderer. */
export function toTeamTask(task: Task): TeamTaskResponse {
  const legacyTask = task as Task & { title?: string; subject?: string };
  const statusMap: Record<TaskStatus, TeamTaskStatus> = {
    todo: 'pending',
    doing: 'in_progress',
    done: 'completed',
  };
  return {
    id: task.id,
    displayId: task.id.slice(0, 8),
    subject: legacyTask.title ?? legacyTask.subject ?? '',
    description: task.description ?? '',
    descriptionTaskRefs: task.descriptionTaskRefs,
    activeForm: task.activeForm,
    prompt: task.prompt,
    promptTaskRefs: task.promptTaskRefs,
    status:
      task.reviewState === 'review' || task.reviewState === 'approved'
        ? 'completed'
        : (statusMap[task.status] ?? 'pending'),
    owner: task.assignee ?? undefined,
    ownerAgentId: task.assigneeAgentId,
    parentTaskId: task.parentTaskId,
    collaborationRunId: task.collaborationRunId,
    taskKind: task.taskKind,
    createdBy: task.createdBy,
    workIntervals: task.workIntervals,
    historyEvents: task.historyEvents,
    blocks: task.blocks,
    blockedBy: task.blockedBy,
    related: task.related,
    comments: task.comments,
    needsClarification: task.needsClarification,
    deletedAt: task.deletedAt ?? undefined,
    attachments: task.attachments?.map(({ filePath: _filePath, ...attachment }) => attachment),
    reviewState: task.reviewState,
    sourceMessageId: task.sourceMessageId,
    sourceMessage: task.sourceMessage,
    deliveries: task.deliveries,
    feedbackItems: task.feedbackItems,
    revisionCount: task.revisionCount,
    needsHumanIntervention: task.needsHumanIntervention,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function isSoftDeletedTask(task: Pick<Task, 'deletedAt'>): boolean {
  return Boolean(task.deletedAt);
}

export function activeTasks<T extends Pick<Task, 'deletedAt'>>(tasks: T[]): T[] {
  return tasks.filter((task) => !isSoftDeletedTask(task));
}

/** 当前评审状态：优先从 historyEvents 推导，无事件时回退到任务上的 reviewState */
function currentReviewState(task: Pick<Task, 'historyEvents' | 'reviewState'>): TeamReviewState {
  const derived = getDerivedReviewState({ historyEvents: task.historyEvents });
  if (derived !== 'none') return derived;
  return task.reviewState ?? 'none';
}

function isTaskCancellationComment(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/[\s，。！？、,.!?]/gu, '')
    .toLocaleLowerCase();
  return new Set(['任务取消', '取消任务', '不用做了', '停止任务', '终止任务']).has(normalized);
}

async function listTaskBoardNames(dependencies: TeamTaskRouteDependencies): Promise<string[]> {
  const [projects, teams] = await Promise.all([
    dependencies.listProjects(),
    dependencies.listTeams?.() ?? Promise.resolve([]),
  ]);
  return [
    ...new Set([...projects.map((project) => project.name), ...teams.map((team) => team.slug)]),
  ];
}

interface TaskBusMatch {
  task: Task;
  ownerTeamName: string;
  ownerTeamSlug: string;
}

async function resolveTaskBusTask(
  dependencies: TeamTaskRouteDependencies,
  taskId: string
): Promise<TaskBusMatch | 'ambiguous' | null> {
  const matches: TaskBusMatch[] = [];
  const taskBoardNames = await listTaskBoardNames(dependencies);
  for (const taskBoardName of taskBoardNames) {
    try {
      const [tasks, manifest] = await Promise.all([
        dependencies.readTasks(taskBoardName),
        dependencies.readTeamManifest(taskBoardName).catch(() => null),
      ]);
      for (const task of activeTasks(tasks)) {
        if (task.id === taskId || task.id.startsWith(taskId)) {
          matches.push({
            task,
            ownerTeamName: taskBoardName,
            ownerTeamSlug: manifest?.slug || task.teamSlug || taskBoardName,
          });
        }
      }
    } catch {
      // Ignore teams without a readable local task board.
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous';
  return matches[0];
}

function taskAssigneeIdentity(task: Task): string | null | undefined {
  return task.assigneeAgentId ?? task.assignee;
}

function canReadTaskBusTask(match: TaskBusMatch, actorTeam: string): boolean {
  return match.ownerTeamSlug === actorTeam || taskAssigneeIdentity(match.task) === actorTeam;
}

function canExecuteTaskBusTask(match: TaskBusMatch, actorTeam: string): boolean {
  return taskAssigneeIdentity(match.task) === actorTeam || match.ownerTeamSlug === actorTeam;
}

function normalizeTaskBusActor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const actor = value.trim();
  return /^[a-zA-Z0-9:_-]+$/.test(actor) ? actor : null;
}

function normalizeTaskBusText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

function normalizeTaskRefs(value: unknown): TaskRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.taskId !== 'string' ||
      typeof record.displayId !== 'string' ||
      typeof record.teamName !== 'string'
    ) {
      return [];
    }
    return [
      {
        taskId: record.taskId,
        displayId: record.displayId,
        teamName: record.teamName,
      } satisfies TaskRef,
    ];
  });
  return refs.length > 0 ? refs : undefined;
}

const CLARIFICATION_VALUES = new Set<unknown>(['lead', 'user', null]);
const RELATIONSHIP_TYPES = new Set<unknown>(['blockedBy', 'blocks', 'related']);

type ClarificationValue = 'lead' | 'user' | null;
type RelationshipType = 'blockedBy' | 'blocks' | 'related';

function isClarificationValue(value: unknown): value is ClarificationValue {
  return CLARIFICATION_VALUES.has(value);
}

function isRelationshipType(value: unknown): value is RelationshipType {
  return RELATIONSHIP_TYPES.has(value);
}

function hasUnsupportedCommentAttachments(value: unknown): boolean {
  return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

const TASK_ATTACHMENT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/octet-stream',
]);
const TASK_ATTACHMENT_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'docx',
  'xlsx',
  'pptx',
  'zip',
]);

function isSupportedTaskAttachment(filename: string, mimeType: string): boolean {
  const extension = filename.split('.').pop()?.toLocaleLowerCase() ?? '';
  return (
    TASK_ATTACHMENT_MIME_TYPES.has(mimeType) &&
    (TASK_ATTACHMENT_EXTENSIONS.has(extension) || TEXT_FILE_EXTENSIONS.has(extension))
  );
}
const MAX_TASK_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function isSafeAttachmentToken(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/u.test(value);
}

function taskAttachmentPath(teamName: string, taskId: string, attachmentId: string): string {
  if (![teamName, taskId, attachmentId].every(isSafeAttachmentToken)) {
    throw new Error('invalid attachment path');
  }
  const root = path.resolve(teamRoot(teamName), 'tasks', 'attachments');
  const filePath = path.resolve(root, taskId, `${attachmentId}.data`);
  if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error('invalid attachment path');
  return filePath;
}

function appendUnique(values: string[] | undefined, value: string): string[] {
  return values?.includes(value) ? values : [...(values ?? []), value];
}

function removeValue(values: string[] | undefined, value: string): string[] | undefined {
  const next = values?.filter((entry) => entry !== value);
  return next && next.length > 0 ? next : undefined;
}

function registerCoreRoutes(app: FastifyInstance, dependencies: TeamTaskRouteDependencies): void {
  app.get<{ Params: { name: string } }>('/api/teams/:name/tasks', async (request) => {
    try {
      const tasks = activeTasks(await dependencies.readTasks(request.params.name));
      return tasks.map(toTeamTask);
    } catch {
      return [];
    }
  });

  app.post<{ Params: { name: string }; Body: Record<string, unknown> }>(
    '/api/teams/:name/tasks',
    async (request, reply) => {
      const body = request.body ?? {};
      const title = (body.subject ?? body.title) as string | undefined;
      if (!title) return reply.code(400).send({ error: 'title/subject required' });
      const assignee = (body.owner ?? body.assignee) as string | null | undefined;
      const shouldStart = Boolean(assignee) && body.startImmediately !== false;
      const task = await dependencies.createTask(request.params.name, {
        title,
        description: body.description as string | undefined,
        descriptionTaskRefs: normalizeTaskRefs(body.descriptionTaskRefs),
        prompt: body.prompt as string | undefined,
        promptTaskRefs: normalizeTaskRefs(body.promptTaskRefs),
        assignee,
        status: shouldStart ? 'doing' : body.status ? toTaskStatus(body.status as string) : 'todo',
        blockedBy: Array.isArray(body.blockedBy)
          ? body.blockedBy.filter((value): value is string => typeof value === 'string')
          : undefined,
        related: Array.isArray(body.related)
          ? body.related.filter((value): value is string => typeof value === 'string')
          : undefined,
        createdBy: 'user',
      });
      if (shouldStart) await dependencies.dispatchTask(request.params.name, task).catch(() => {});
      dependencies.broadcastTaskChange?.(request.params.name, task.id);
      return toTeamTask(task);
    }
  );

  app.patch<{ Params: { name: string; id: string }; Body: Record<string, unknown> }>(
    '/api/teams/:name/tasks/:id',
    async (request, reply) => {
      const body = request.body ?? {};
      const patch: Partial<Task> = {};
      const nextStatus =
        body.status !== undefined ? toTaskStatus(body.status as string) : undefined;
      if (body.subject !== undefined) patch.title = body.subject as string;
      if (body.title !== undefined) patch.title = body.title as string;
      if (body.description !== undefined) patch.description = body.description as string;
      if (nextStatus !== undefined) patch.status = nextStatus;
      if (body.owner !== undefined) patch.assignee = body.owner as string | null;
      if (body.assignee !== undefined) patch.assignee = body.assignee as string | null;

      const tasks = await dependencies.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (isManualInProgressExitBlocked(existingTask?.status, nextStatus)) {
        return reply.code(409).send({
          ok: false,
          error: 'Agent 正在处理中，不能手动完成或取消。请等待 Agent 通过 AgentCLI 提交结果。',
        });
      }

      const task = await dependencies.patchTask(request.params.name, request.params.id, patch);
      return toTeamTask(task);
    }
  );

  app.delete<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id',
    async (request, reply) => {
      try {
        const tasks = await dependencies.readTasks(request.params.name);
        const existingTask = tasks.find((task) => task.id === request.params.id);
        if (existingTask?.status === 'doing') {
          return reply.code(409).send({
            ok: false,
            error: 'Agent 正在处理中，不能手动删除任务。',
          });
        }
        await dependencies.patchTask(request.params.name, request.params.id, {
          status: 'done',
          deletedAt: new Date().toISOString(),
        });
        return { ok: true };
      } catch {
        return reply.code(404).send({ error: 'not found' });
      }
    }
  );
}

function registerCompatibilityRoutes(app: FastifyInstance): void {
  app.get<{ Params: { name: string } }>('/api/teams/:name/kanban', async (request) => ({
    teamName: request.params.name,
    reviewers: [],
    tasks: {},
  }));

  app.get<{ Params: { name: string } }>('/api/teams/:name/task-change-presence', async () => ({}));

  app.post<{ Params: { name: string } }>('/api/teams/:name/kanban-column-order', async () => ({
    ok: true,
  }));
}

type RequestReviewHandler = (
  request: { params: { name: string; id: string } },
  reply: { code(statusCode: number): { send(payload: unknown): unknown } }
) => Promise<unknown>;

function createRequestReviewHandler(dependencies: TeamTaskRouteDependencies): RequestReviewHandler {
  return async (request, reply): Promise<unknown> => {
    try {
      const tasks = await dependencies.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (existingTask?.status === 'doing') {
        return reply.code(409).send({
          ok: false,
          error: 'Agent 正在处理中，不能手动提交审核。请等待 Agent 通过 AgentCLI 提交结果。',
        });
      }
      const task = await dependencies.patchTask(request.params.name, request.params.id, {
        status: 'done',
      });
      return { ok: true, data: toTeamTask(task) };
    } catch {
      return { ok: true };
    }
  };
}

type UpdateKanbanHandler = (
  request: { params: { name: string; id: string }; body?: unknown },
  reply: { code(statusCode: number): { send(payload: unknown): unknown } }
) => Promise<unknown>;

function isUpdateKanbanPatch(value: unknown): value is UpdateKanbanPatch {
  if (!value || typeof value !== 'object') return false;
  const patch = value as Record<string, unknown>;
  if (patch.op === 'remove') return true;
  if (patch.op === 'set_column') {
    return patch.column === 'review' || patch.column === 'approved';
  }
  return patch.op === 'request_changes';
}

function createUpdateKanbanHandler(dependencies: TeamTaskRouteDependencies): UpdateKanbanHandler {
  return async (request, reply): Promise<unknown> => {
    if (!isUpdateKanbanPatch(request.body)) {
      return reply.code(400).send({ ok: false, error: 'invalid kanban update' });
    }
    const tasks = await dependencies.readTasks(request.params.name);
    const existingTask = tasks.find((task) => task.id === request.params.id);
    if (!existingTask) return reply.code(404).send({ ok: false, error: 'task not found' });

    const timestamp = new Date().toISOString();

    if (request.body.op === 'remove') {
      if (existingTask.status === 'doing') {
        return reply.code(409).send({ ok: false, error: 'Agent 正在处理中，不能删除任务。' });
      }
      await dependencies.patchTask(request.params.name, existingTask.id, {
        status: 'done',
        deletedAt: timestamp,
      });
      dependencies.broadcastTaskChange?.(request.params.name, existingTask.id);
      return { ok: true };
    }

    if (request.body.op === 'set_column') {
      const column = request.body.column;
      if (column === 'approved') {
        const openFeedback = (existingTask.feedbackItems ?? []).filter(
          (item) => item.status === 'open'
        );
        if (openFeedback.length > 0) {
          return reply.code(409).send({
            ok: false,
            error: `仍有 ${openFeedback.length} 条未处理的反馈，不能归档。`,
          });
        }
        if (!(existingTask.deliveries?.at(-1)?.result.trim() ?? '')) {
          return reply.code(409).send({ ok: false, error: '任务还没有可归档的交付结果。' });
        }
      }

      const task = await dependencies.patchTask(request.params.name, existingTask.id, {
        status: 'done',
        reviewState: column,
        ...(column === 'approved' ? { revisionCount: 0, needsHumanIntervention: false } : {}),
      });
      if (column === 'approved') {
        try {
          await archiveTaskDeliverable({
            teamName: request.params.name,
            task,
            approvedAt: new Date(timestamp),
          });
        } catch (error) {
          await dependencies.patchTask(request.params.name, existingTask.id, {
            status: existingTask.status,
            reviewState: existingTask.reviewState,
            revisionCount: existingTask.revisionCount,
            needsHumanIntervention: existingTask.needsHumanIntervention,
          });
          throw error;
        }
      }
      const from = currentReviewState(existingTask);
      const event: TaskHistoryEvent =
        column === 'approved'
          ? {
              id: historyEventId(),
              type: 'review_approved',
              from,
              to: 'approved',
              timestamp,
              actor: 'reviewer',
            }
          : {
              id: historyEventId(),
              type: 'review_requested',
              from,
              to: 'review',
              timestamp,
              actor: 'reviewer',
            };
      await dependencies.appendTaskHistoryEvent(request.params.name, existingTask.id, event);
      dependencies.broadcastTaskChange?.(request.params.name, existingTask.id);
      return {
        ok: true,
        task: toTeamTask({ ...task, historyEvents: [...(task.historyEvents ?? []), event] }),
      };
    }

    // request_changes — 与 MCP reject_result 同语义：
    // 有 comment 时创建 open 的 FeedbackItem（不再把反馈写成评论），
    // 无 comment 时不建条目但退回计数照旧；status 回 doing、revisionCount+1，
    // >= 3 次置 needsHumanIntervention。
    const comment = request.body.comment?.trim() ?? '';
    if (comment) {
      await dependencies.addFeedbackItem(request.params.name, existingTask.id, { text: comment });
    }
    const revisionCount = (existingTask.revisionCount ?? 0) + 1;
    const needsHumanIntervention = revisionCount >= HUMAN_INTERVENTION_REVISION_THRESHOLD;
    const persistReworkTask = (): Promise<Task> =>
      dependencies.patchTask(request.params.name, existingTask.id, {
        status: existingTask.assignee ? 'doing' : 'todo',
        reviewState: 'needsFix',
        needsClarification: undefined,
        revisionCount,
        needsHumanIntervention,
      });
    let task: Task;
    if (existingTask.collaborationRunId && dependencies.requestCollaborationChanges) {
      let persistedTask: Task | undefined;
      await dependencies.requestCollaborationChanges(
        existingTask.collaborationRunId,
        comment || '请根据反馈修改当前交付结果。',
        async () => {
          persistedTask = await persistReworkTask();
        }
      );
      if (!persistedTask) throw new Error('小队返工任务未能持久化');
      task = persistedTask;
    } else {
      task = await persistReworkTask();
    }
    const event: TaskHistoryEvent = {
      id: historyEventId(),
      type: 'review_changes_requested',
      from: currentReviewState(existingTask),
      to: 'needsFix',
      timestamp,
      actor: 'reviewer',
      ...(comment ? { note: comment } : {}),
    };
    await dependencies.appendTaskHistoryEvent(request.params.name, existingTask.id, event);
    if (!task.collaborationRunId && task.assignee) {
      await dependencies.dispatchTask(request.params.name, task);
    }
    dependencies.broadcastTaskChange?.(request.params.name, existingTask.id);
    return {
      ok: true,
      task: toTeamTask({ ...task, historyEvents: [...(task.historyEvents ?? []), event] }),
      revisionCount,
      needsHumanIntervention,
    };
  };
}

function registerActionRoutes(app: FastifyInstance, dependencies: TeamTaskRouteDependencies): void {
  app.get('/api/teams/tasks', async () => {
    try {
      const allTasks: GlobalTaskResponse[] = [];
      const taskBoardNames = await listTaskBoardNames(dependencies);
      for (const taskBoardName of taskBoardNames) {
        try {
          const tasks = activeTasks(await dependencies.readTasks(taskBoardName));
          const manifest = await dependencies.readTeamManifest(taskBoardName).catch(() => null);
          for (const task of tasks) {
            if (task.taskKind === 'subtask') continue;
            const teamName = manifest?.slug || task.teamSlug || taskBoardName;
            allTasks.push({
              ...toTeamTask(task),
              teamName,
              teamDisplayName: manifest?.displayName || teamName,
              teamDeleted: Boolean(manifest?.deletedAt),
            });
          }
        } catch {
          // Skip teams without a readable local task board.
        }
      }
      return allTasks;
    } catch {
      return [];
    }
  });

  app.get<{ Querystring: { team?: string } }>('/api/task-bus/tasks', async (request, reply) => {
    const actorTeam = normalizeTaskBusActor(request.query?.team);
    if (!actorTeam) return reply.code(400).send({ ok: false, error: 'team required' });
    try {
      const visibleTasks: GlobalTaskResponse[] = [];
      const taskBoardNames = await listTaskBoardNames(dependencies);
      for (const taskBoardName of taskBoardNames) {
        try {
          const [tasks, manifest] = await Promise.all([
            dependencies.readTasks(taskBoardName),
            dependencies.readTeamManifest(taskBoardName).catch(() => null),
          ]);
          const ownerTeamSlug = manifest?.slug || taskBoardName;
          for (const task of activeTasks(tasks)) {
            const match = { task, ownerTeamName: taskBoardName, ownerTeamSlug };
            if (!canReadTaskBusTask(match, actorTeam)) continue;
            visibleTasks.push({
              ...toTeamTask(task),
              teamName: ownerTeamSlug,
              teamDisplayName: manifest?.displayName || ownerTeamSlug,
              teamDeleted: Boolean(manifest?.deletedAt),
            });
          }
        } catch {
          // Ignore teams without a readable local task board.
        }
      }
      return visibleTasks;
    } catch (error) {
      return reply.code(500).send(dependencies.reply500(error));
    }
  });

  app.post<{
    Params: { id: string };
    Body: { team?: string };
  }>('/api/task-bus/tasks/:id/claim', async (request, reply) => {
    const actorTeam = normalizeTaskBusActor(request.body?.team);
    if (!actorTeam) return reply.code(400).send({ ok: false, error: 'team required' });
    const match = await resolveTaskBusTask(dependencies, request.params.id);
    if (!match) return reply.code(404).send({ ok: false, error: 'task not found' });
    if (match === 'ambiguous') {
      return reply.code(409).send({ ok: false, error: 'task id is ambiguous' });
    }
    if (!canExecuteTaskBusTask(match, actorTeam)) {
      return reply.code(403).send({ ok: false, error: 'task is not assigned to this team' });
    }
    if (match.task.status === 'done') {
      return reply.code(409).send({ ok: false, error: 'completed task cannot be claimed' });
    }
    let task = match.task;
    if (match.task.status !== 'doing') {
      task = await dependencies.patchTask(match.ownerTeamName, match.task.id, { status: 'doing' });
      const event: TaskHistoryEvent = {
        id: historyEventId(),
        type: 'status_changed',
        from: 'pending',
        to: 'in_progress',
        timestamp: new Date().toISOString(),
        actor: 'agent',
      };
      await dependencies.appendTaskHistoryEvent(match.ownerTeamName, match.task.id, event);
      task = { ...task, historyEvents: [...(task.historyEvents ?? []), event] };
    }
    dependencies.broadcastTaskChange?.(match.ownerTeamSlug, match.task.id);
    return { ok: true, task: toTeamTask(task), teamName: match.ownerTeamSlug };
  });

  app.post<{
    Params: { id: string };
    Body: { team?: string; text?: string };
  }>('/api/task-bus/tasks/:id/comments', async (request, reply) => {
    const actorTeam = normalizeTaskBusActor(request.body?.team);
    const text = normalizeTaskBusText(request.body?.text);
    if (!actorTeam || !text) {
      return reply.code(400).send({ ok: false, error: 'team and text required' });
    }
    const match = await resolveTaskBusTask(dependencies, request.params.id);
    if (!match) return reply.code(404).send({ ok: false, error: 'task not found' });
    if (match === 'ambiguous') {
      return reply.code(409).send({ ok: false, error: 'task id is ambiguous' });
    }
    if (!canReadTaskBusTask(match, actorTeam)) {
      return reply.code(403).send({ ok: false, error: 'task is not visible to this team' });
    }
    const comment: TaskComment = {
      id: randomUUID(),
      author: match.task.assignee ?? actorTeam,
      text,
      createdAt: new Date().toISOString(),
      type: 'regular',
    };
    const task = await dependencies.patchTask(match.ownerTeamName, match.task.id, {
      comments: [...(match.task.comments ?? []), comment],
    });
    dependencies.broadcastTaskChange?.(match.ownerTeamSlug, match.task.id);
    return { ok: true, comment, task: toTeamTask(task), teamName: match.ownerTeamSlug };
  });

  app.post<{
    Params: { id: string };
    Body: { team?: string; target?: 'lead' | 'user' | 'none' };
  }>('/api/task-bus/tasks/:id/clarification', async (request, reply) => {
    const actorTeam = normalizeTaskBusActor(request.body?.team);
    const target = request.body?.target;
    if (!actorTeam || !target || !['lead', 'user', 'none'].includes(target)) {
      return reply
        .code(400)
        .send({ ok: false, error: 'team and target (lead, user, none) required' });
    }
    const match = await resolveTaskBusTask(dependencies, request.params.id);
    if (!match) return reply.code(404).send({ ok: false, error: 'task not found' });
    if (match === 'ambiguous') {
      return reply.code(409).send({ ok: false, error: 'task id is ambiguous' });
    }
    if (!canReadTaskBusTask(match, actorTeam)) {
      return reply.code(403).send({ ok: false, error: 'task is not visible to this team' });
    }
    const task = await dependencies.patchTask(match.ownerTeamName, match.task.id, {
      needsClarification: target === 'none' ? undefined : target,
    });
    dependencies.broadcastTaskChange?.(match.ownerTeamSlug, match.task.id);
    return { ok: true, task: toTeamTask(task), teamName: match.ownerTeamSlug };
  });

  app.post<{
    Params: { id: string };
    Body: { team?: string; result?: string };
  }>('/api/task-bus/tasks/:id/complete', async (request, reply) => {
    const actorTeam = normalizeTaskBusActor(request.body?.team);
    const result = normalizeTaskBusText(request.body?.result);
    if (!actorTeam || !result) {
      return reply.code(400).send({ ok: false, error: 'team and result required' });
    }
    const match = await resolveTaskBusTask(dependencies, request.params.id);
    if (!match) return reply.code(404).send({ ok: false, error: 'task not found' });
    if (match === 'ambiguous') {
      return reply.code(409).send({ ok: false, error: 'task id is ambiguous' });
    }
    if (!canExecuteTaskBusTask(match, actorTeam)) {
      return reply.code(403).send({ ok: false, error: 'task is not assigned to this team' });
    }
    if (match.task.status !== 'doing') {
      return reply.code(409).send({ ok: false, error: 'task must be claimed before completion' });
    }
    // 带 result 时记录为一条交付成果（delivery）
    await dependencies.addDelivery(match.ownerTeamName, match.task.id, { result });
    const patched = await dependencies.patchTask(match.ownerTeamName, match.task.id, {
      status: 'done',
      needsClarification: undefined,
      reviewState: 'review',
    });
    const event: TaskHistoryEvent = {
      id: historyEventId(),
      type: 'status_changed',
      from: 'in_progress',
      to: 'completed',
      timestamp: new Date().toISOString(),
      actor: 'agent',
    };
    await dependencies.appendTaskHistoryEvent(match.ownerTeamName, match.task.id, event);
    const task = { ...patched, historyEvents: [...(patched.historyEvents ?? []), event] };
    dependencies.broadcastTaskChange?.(match.ownerTeamSlug, match.task.id);
    return { ok: true, task: toTeamTask(task), teamName: match.ownerTeamSlug };
  });

  app.post<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id/request-review',
    createRequestReviewHandler(dependencies)
  );

  app.patch<{ Params: { name: string; id: string }; Body: UpdateKanbanPatch }>(
    '/api/teams/:name/tasks/:id/kanban',
    createUpdateKanbanHandler(dependencies)
  );

  app.patch<{ Params: { name: string; id: string }; Body: { status?: string } }>(
    '/api/teams/:name/tasks/:id/status',
    async (request, reply) => {
      try {
        const { status } = request.body ?? {};
        const nextStatus = status ? toTaskStatus(status) : undefined;
        const tasks = await dependencies.readTasks(request.params.name);
        const existingTask = tasks.find((task) => task.id === request.params.id);
        if (isManualInProgressExitBlocked(existingTask?.status, nextStatus)) {
          return reply.code(409).send({
            ok: false,
            error: 'Agent 正在处理中，不能手动完成或取消。请等待 Agent 通过 AgentCLI 提交结果。',
          });
        }
        const task = await dependencies.patchTask(request.params.name, request.params.id, {
          status: nextStatus,
        });
        return toTeamTask(task);
      } catch {
        return { ok: true };
      }
    }
  );

  app.patch<{ Params: { name: string; id: string }; Body: { owner?: string } }>(
    '/api/teams/:name/tasks/:id/owner',
    async (request) => {
      try {
        const body = request.body ?? {};
        const task = await dependencies.patchTask(request.params.name, request.params.id, {
          assignee: body.owner ?? null,
        });
        return toTeamTask(task);
      } catch {
        return { ok: true };
      }
    }
  );

  app.patch<{ Params: { name: string; id: string }; Body: Record<string, unknown> }>(
    '/api/teams/:name/tasks/:id/fields',
    async (request) => {
      try {
        const body = request.body ?? {};
        const patch: Partial<Task> = {};
        if (body.subject !== undefined) patch.title = body.subject as string;
        if (body.description !== undefined) patch.description = body.description as string;
        const task = await dependencies.patchTask(request.params.name, request.params.id, patch);
        return toTeamTask(task);
      } catch {
        return { ok: true };
      }
    }
  );

  const startTask = async (request: {
    params: { name: string; id: string };
  }): Promise<{ notifiedOwner: boolean }> => {
    try {
      const task = await dependencies.patchTask(request.params.name, request.params.id, {
        status: 'doing',
      });
      if (task.assignee) {
        await dependencies.dispatchTask(request.params.name, task).catch(() => {});
        return { notifiedOwner: true };
      }
      return { notifiedOwner: false };
    } catch {
      return { notifiedOwner: false };
    }
  };

  app.post<{ Params: { name: string; id: string } }>('/api/teams/:name/tasks/:id/start', startTask);
  app.post<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id/start-by-user',
    startTask
  );

  app.post<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id/soft-delete',
    async (request, reply) => {
      try {
        const tasks = await dependencies.readTasks(request.params.name);
        const existingTask = tasks.find((task) => task.id === request.params.id);
        if (existingTask?.status === 'doing') {
          return reply.code(409).send({
            ok: false,
            error: 'Agent 正在处理中，不能手动删除任务。',
          });
        }
        await dependencies.patchTask(request.params.name, request.params.id, {
          status: 'done',
          deletedAt: new Date().toISOString(),
        });
        return { ok: true };
      } catch (error) {
        return reply.code(404).send(dependencies.reply500(error));
      }
    }
  );

  app.post<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id/restore',
    async (request, reply) => {
      try {
        await dependencies.patchTask(request.params.name, request.params.id, {
          status: 'todo',
          deletedAt: null,
        });
        return { ok: true };
      } catch (error) {
        return reply.code(404).send(dependencies.reply500(error));
      }
    }
  );

  app.get<{ Params: { name: string } }>('/api/teams/:name/deleted-tasks', async (request) => {
    try {
      const tasks = await dependencies.readTasks(request.params.name);
      return tasks.filter(isSoftDeletedTask).map(toTeamTask);
    } catch {
      return [];
    }
  });

  app.post<{
    Params: { name: string; id: string };
    Body: {
      attachmentId?: string;
      filename?: string;
      mimeType?: string;
      base64Data?: string;
    };
  }>(
    '/api/teams/:name/tasks/:id/attachments',
    { bodyLimit: 30 * 1024 * 1024 },
    async (request, reply) => {
      const attachmentId = request.body?.attachmentId?.trim() ?? '';
      const filename = request.body?.filename?.trim() ?? '';
      const mimeType = request.body?.mimeType?.trim() ?? '';
      const base64Data = request.body?.base64Data?.trim() ?? '';
      if (
        !isSafeAttachmentToken(request.params.id) ||
        !isSafeAttachmentToken(attachmentId) ||
        !filename ||
        !isSupportedTaskAttachment(filename, mimeType) ||
        !base64Data
      ) {
        return reply.code(400).send({ error: 'invalid attachment payload' });
      }

      const data = Buffer.from(base64Data, 'base64');
      if (data.length === 0 || data.length > MAX_TASK_ATTACHMENT_BYTES) {
        return reply.code(400).send({ error: 'attachment must be between 1 byte and 20 MB' });
      }

      try {
        const tasks = await dependencies.readTasks(request.params.name);
        const existingTask = tasks.find((task) => task.id === request.params.id);
        if (!existingTask) return reply.code(404).send({ error: 'not found' });
        const filePath = taskAttachmentPath(request.params.name, request.params.id, attachmentId);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, data, { mode: 0o600 });
        const attachment: TaskAttachmentMeta = {
          id: attachmentId,
          filename,
          mimeType,
          size: data.length,
          addedAt: new Date().toISOString(),
          filePath,
        };
        await dependencies.patchTask(request.params.name, request.params.id, {
          attachments: [
            ...(existingTask.attachments ?? []).filter((item) => item.id !== attachmentId),
            attachment,
          ],
        });
        return {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          addedAt: attachment.addedAt,
        };
      } catch (error) {
        return reply.code(500).send(dependencies.reply500(error));
      }
    }
  );

  app.get<{ Params: { name: string; id: string; attachmentId: string } }>(
    '/api/teams/:name/tasks/:id/attachments/:attachmentId',
    async (request, reply) => {
      if (
        !isSafeAttachmentToken(request.params.id) ||
        !isSafeAttachmentToken(request.params.attachmentId)
      ) {
        return reply.code(400).send({ error: 'invalid attachment id' });
      }
      try {
        const tasks = await dependencies.readTasks(request.params.name);
        const task = tasks.find((entry) => entry.id === request.params.id);
        const attachment = task?.attachments?.find(
          (entry) => entry.id === request.params.attachmentId
        );
        if (!task || !attachment) return reply.code(404).send({ error: 'not found' });
        const data = await readFile(
          taskAttachmentPath(request.params.name, request.params.id, request.params.attachmentId)
        );
        return { base64Data: data.toString('base64') };
      } catch (error) {
        return reply.code(404).send(dependencies.reply500(error));
      }
    }
  );

  app.delete<{ Params: { name: string; id: string; attachmentId: string } }>(
    '/api/teams/:name/tasks/:id/attachments/:attachmentId',
    async (request, reply) => {
      if (
        !isSafeAttachmentToken(request.params.id) ||
        !isSafeAttachmentToken(request.params.attachmentId)
      ) {
        return reply.code(400).send({ error: 'invalid attachment id' });
      }
      try {
        const tasks = await dependencies.readTasks(request.params.name);
        const task = tasks.find((entry) => entry.id === request.params.id);
        if (!task) return reply.code(404).send({ error: 'not found' });
        const attachments = (task.attachments ?? []).filter(
          (entry) => entry.id !== request.params.attachmentId
        );
        await rm(
          taskAttachmentPath(request.params.name, request.params.id, request.params.attachmentId),
          { force: true }
        );
        await dependencies.patchTask(request.params.name, request.params.id, { attachments });
        return { ok: true };
      } catch (error) {
        return reply.code(500).send(dependencies.reply500(error));
      }
    }
  );

  app.post<{
    Params: { name: string; id: string };
    Body: { text?: string; taskRefs?: unknown[]; attachments?: unknown[]; anchor?: unknown };
  }>('/api/teams/:name/tasks/:id/comments', async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: 'text required' });
    if (hasUnsupportedCommentAttachments(request.body?.attachments)) {
      return reply.code(400).send({
        error: '浏览器模式暂不支持评论附件，请移除附件后重试。',
      });
    }
    try {
      const tasks = await dependencies.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (!existingTask) return reply.code(404).send({ error: 'not found' });
      const createdAt = new Date().toISOString();
      const anchor = asFeedbackAnchor(request.body?.anchor);
      const comment: TaskComment = {
        id: randomUUID(),
        author: 'user',
        text,
        createdAt,
        type: 'regular',
        ...(anchor ? { anchor } : {}),
        taskRefs: normalizeTaskRefs(request.body?.taskRefs),
      };
      const cancellationRequested = isTaskCancellationComment(text);
      const task = await dependencies.patchTask(request.params.name, request.params.id, {
        comments: [...(existingTask.comments ?? []), comment],
        needsClarification: undefined,
        ...(cancellationRequested
          ? { status: 'done', deletedAt: createdAt, reviewState: undefined }
          : { status: existingTask.assignee ? 'doing' : existingTask.status }),
      });
      if (task.assignee && !cancellationRequested) {
        await dependencies.dispatchTask(request.params.name, task).catch(() => {});
      }
      dependencies.broadcastTaskChange?.(request.params.name, request.params.id);
      return comment;
    } catch (error) {
      return reply.code(500).send(dependencies.reply500(error));
    }
  });

  app.post<{
    Params: { name: string; id: string };
    Body: { value?: 'lead' | 'user' | null };
  }>('/api/teams/:name/tasks/:id/clarification', async (request, reply) => {
    const value = request.body?.value;
    if (!isClarificationValue(value)) {
      return reply.code(400).send({ error: 'value must be lead, user, or null' });
    }
    try {
      await dependencies.patchTask(request.params.name, request.params.id, {
        needsClarification: value ?? undefined,
      });
      return { ok: true };
    } catch (error) {
      return reply.code(404).send(dependencies.reply500(error));
    }
  });

  app.post<{
    Params: { name: string; id: string };
    Body: { targetId?: string; type?: 'blockedBy' | 'blocks' | 'related' };
  }>('/api/teams/:name/tasks/:id/relationships', async (request, reply) => {
    const targetId = request.body?.targetId?.trim();
    const type = request.body?.type;
    if (!targetId || !isRelationshipType(type)) {
      return reply
        .code(400)
        .send({ error: 'targetId required and type must be blockedBy, blocks, or related' });
    }
    try {
      const tasks = await dependencies.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (!existingTask) return reply.code(404).send({ error: 'not found' });
      await dependencies.patchTask(request.params.name, request.params.id, {
        [type]: appendUnique(existingTask[type], targetId),
      });
      return { ok: true };
    } catch (error) {
      return reply.code(404).send(dependencies.reply500(error));
    }
  });
}

function registerReviewAliasRoutes(
  app: FastifyInstance,
  dependencies: TeamTaskRouteDependencies
): void {
  app.post<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id/review',
    createRequestReviewHandler(dependencies)
  );

  app.patch<{ Params: { name: string; id: string }; Body: UpdateKanbanPatch }>(
    '/api/teams/:name/kanban/:id',
    createUpdateKanbanHandler(dependencies)
  );

  app.put<{ Params: { name: string } }>('/api/teams/:name/kanban/column-order', async () => ({
    ok: true,
  }));
}

function registerLateAliasRoutes(
  app: FastifyInstance,
  dependencies: TeamTaskRouteDependencies
): void {
  app.post<{
    Params: { name: string; taskId: string };
    Body: { value?: 'lead' | 'user' | null };
  }>('/api/teams/:name/task-clarification/:taskId', async (request, reply) => {
    const value = request.body?.value;
    if (!isClarificationValue(value)) {
      return reply.code(400).send({ error: 'value must be lead, user, or null' });
    }
    try {
      await dependencies.patchTask(request.params.name, request.params.taskId, {
        needsClarification: value ?? undefined,
      });
      return { ok: true };
    } catch (error) {
      return reply.code(404).send(dependencies.reply500(error));
    }
  });

  app.delete<{
    Params: { name: string; id: string };
    Body: { targetId?: string; type?: 'blockedBy' | 'blocks' | 'related' };
  }>('/api/teams/:name/tasks/:id/relationships', async (request, reply) => {
    const targetId = request.body?.targetId?.trim();
    const type = request.body?.type;
    if (!targetId || !isRelationshipType(type)) {
      return reply
        .code(400)
        .send({ error: 'targetId required and type must be blockedBy, blocks, or related' });
    }
    try {
      const tasks = await dependencies.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (!existingTask) return reply.code(404).send({ error: 'not found' });
      await dependencies.patchTask(request.params.name, request.params.id, {
        [type]: removeValue(existingTask[type], targetId),
      });
      return { ok: true };
    } catch (error) {
      return reply.code(404).send(dependencies.reply500(error));
    }
  });
}

export function registerTeamTaskRoutes(
  app: FastifyInstance,
  dependencies: TeamTaskRouteDependencies,
  options: TeamTaskRouteOptions = {}
): void {
  const routes = new Set<TeamTaskRouteSection>(
    options.routes ?? ['core', 'compatibility', 'actions', 'review-aliases', 'late-aliases']
  );

  if (routes.has('core')) registerCoreRoutes(app, dependencies);
  if (routes.has('compatibility')) registerCompatibilityRoutes(app);
  if (routes.has('actions')) registerActionRoutes(app, dependencies);
  if (routes.has('review-aliases')) registerReviewAliasRoutes(app, dependencies);
  if (routes.has('late-aliases')) registerLateAliasRoutes(app, dependencies);
}
