import { randomUUID } from 'node:crypto';

import type { Task, TaskStatus } from '../services/team-management/TeamWorkspaceService';
import type {
  GlobalTask,
  TaskComment,
  TaskRef,
  TeamTask,
  TeamTaskStatus,
} from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

interface TeamTaskRouteDependencies {
  readTasks(teamName: string): Promise<Task[]>;
  createTask(
    teamName: string,
    payload: {
      title: string;
      description?: string;
      assignee?: string | null;
      status?: TaskStatus;
    }
  ): Promise<Task>;
  patchTask(teamName: string, taskId: string, patch: Partial<Task>): Promise<Task>;
  dispatchTask(teamName: string, task: Task): Promise<void>;
  listProjects(): Promise<{ name: string }[]>;
  readTeamManifest(teamName: string): Promise<{
    slug: string;
    displayName?: string;
    deletedAt?: string;
  }>;
  broadcastTaskChange?(teamName: string, taskId: string): void;
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
  result?: string;
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
    status: statusMap[task.status] ?? 'pending',
    owner: task.assignee ?? undefined,
    createdBy: task.createdBy,
    workIntervals: task.workIntervals,
    historyEvents: task.historyEvents,
    blocks: task.blocks,
    blockedBy: task.blockedBy,
    related: task.related,
    comments: task.comments,
    needsClarification: task.needsClarification,
    deletedAt: task.deletedAt,
    attachments: task.attachments,
    reviewState: task.reviewState,
    sourceMessageId: task.sourceMessageId,
    sourceMessage: task.sourceMessage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    result: task.result ?? undefined,
  };
}

function isSoftDeletedTask(task: Pick<Task, 'result'>): boolean {
  return task.result === '__deleted__';
}

export function activeTasks<T extends Pick<Task, 'result'>>(tasks: T[]): T[] {
  return tasks.filter((task) => !isSoftDeletedTask(task));
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
  const projects = await dependencies.listProjects();
  for (const project of projects) {
    try {
      const [tasks, manifest] = await Promise.all([
        dependencies.readTasks(project.name),
        dependencies.readTeamManifest(project.name).catch(() => null),
      ]);
      for (const task of activeTasks(tasks)) {
        if (task.id === taskId || task.id.startsWith(taskId)) {
          matches.push({
            task,
            ownerTeamName: project.name,
            ownerTeamSlug: manifest?.slug || task.teamSlug || project.name,
          });
        }
      }
    } catch {
      // Ignore projects without a readable local task board.
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous';
  return matches[0];
}

function canReadTaskBusTask(match: TaskBusMatch, actorTeam: string): boolean {
  return match.ownerTeamSlug === actorTeam || match.task.assignee === actorTeam;
}

function canExecuteTaskBusTask(match: TaskBusMatch, actorTeam: string): boolean {
  return (match.task.assignee ?? match.ownerTeamSlug) === actorTeam;
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
      const task = await dependencies.createTask(request.params.name, {
        title,
        description: body.description as string | undefined,
        assignee: (body.owner ?? body.assignee) as string | null | undefined,
        status: body.status ? toTaskStatus(body.status as string) : 'todo',
      });
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
      if (body.result !== undefined) patch.result = body.result as string | null;

      const tasks = await dependencies.readTasks(request.params.name);
      const existingTask = tasks.find((task) => task.id === request.params.id);
      if (isManualInProgressExitBlocked(existingTask?.status, nextStatus)) {
        return reply.code(409).send({
          ok: false,
          error: 'Agent 正在处理中，不能手动完成或取消。请等待 agent 通过 Hermit CLI 提交结果。',
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
          result: '__deleted__',
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
          error: 'Agent 正在处理中，不能手动提交审核。请等待 agent 通过 Hermit CLI 提交结果。',
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

function registerActionRoutes(app: FastifyInstance, dependencies: TeamTaskRouteDependencies): void {
  app.get('/api/teams/tasks', async () => {
    try {
      const allTasks: GlobalTaskResponse[] = [];
      const projects = await dependencies.listProjects();
      for (const project of projects) {
        try {
          const tasks = activeTasks(await dependencies.readTasks(project.name));
          const manifest = await dependencies.readTeamManifest(project.name).catch(() => null);
          for (const task of tasks) {
            const teamName = manifest?.slug || task.teamSlug || project.name;
            allTasks.push({
              ...toTeamTask(task),
              teamName,
              teamDisplayName: manifest?.displayName || teamName,
              teamDeleted: Boolean(manifest?.deletedAt),
            });
          }
        } catch {
          // Skip projects without a readable local task board.
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
      const projects = await dependencies.listProjects();
      for (const project of projects) {
        try {
          const [tasks, manifest] = await Promise.all([
            dependencies.readTasks(project.name),
            dependencies.readTeamManifest(project.name).catch(() => null),
          ]);
          const ownerTeamSlug = manifest?.slug || project.name;
          for (const task of activeTasks(tasks)) {
            const match = { task, ownerTeamName: project.name, ownerTeamSlug };
            if (!canReadTaskBusTask(match, actorTeam)) continue;
            visibleTasks.push({
              ...toTeamTask(task),
              teamName: ownerTeamSlug,
              teamDisplayName: manifest?.displayName || ownerTeamSlug,
              teamDeleted: Boolean(manifest?.deletedAt),
            });
          }
        } catch {
          // Ignore projects without a readable local task board.
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
    const task =
      match.task.status === 'doing'
        ? match.task
        : await dependencies.patchTask(match.ownerTeamName, match.task.id, { status: 'doing' });
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
      author: actorTeam,
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
    const task = await dependencies.patchTask(match.ownerTeamName, match.task.id, {
      status: 'done',
      result,
      needsClarification: undefined,
    });
    dependencies.broadcastTaskChange?.(match.ownerTeamSlug, match.task.id);
    return { ok: true, task: toTeamTask(task), teamName: match.ownerTeamSlug };
  });

  app.post<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id/request-review',
    createRequestReviewHandler(dependencies)
  );

  app.patch<{ Params: { name: string; id: string }; Body: Record<string, unknown> }>(
    '/api/teams/:name/tasks/:id/kanban',
    async () => ({ ok: true })
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
            error: 'Agent 正在处理中，不能手动完成或取消。请等待 agent 通过 Hermit CLI 提交结果。',
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
          result: '__deleted__',
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
          result: null,
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
    Body: { text?: string; taskRefs?: unknown[]; attachments?: unknown[] };
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
      const comment: TaskComment = {
        id: randomUUID(),
        author: 'user',
        text,
        createdAt,
        type: 'regular',
        taskRefs: normalizeTaskRefs(request.body?.taskRefs),
      };
      await dependencies.patchTask(request.params.name, request.params.id, {
        comments: [...(existingTask.comments ?? []), comment],
      });
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

  app.patch<{ Params: { name: string; id: string }; Body: Record<string, unknown> }>(
    '/api/teams/:name/kanban/:id',
    async () => ({ ok: true })
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
