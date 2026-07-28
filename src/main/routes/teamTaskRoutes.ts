import type { Task, TaskStatus } from '../services/team-management/TeamWorkspaceService';
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

export interface TeamTaskResponse {
  id: string;
  displayId: string;
  subject: string;
  description: string;
  status: string;
  owner?: string;
  createdAt: string;
  updatedAt: string;
  result?: string;
}

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
  const statusMap: Record<string, string> = {
    todo: 'pending',
    doing: 'in_progress',
    done: 'completed',
  };
  return {
    id: task.id,
    displayId: task.id.slice(0, 8),
    subject: legacyTask.title ?? legacyTask.subject ?? '',
    description: task.description ?? '',
    status: statusMap[task.status] ?? 'pending',
    owner: task.assignee ?? undefined,
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
          error: 'Agent 正在处理中，不能手动完成或取消。请等待 agent 调用 complete_task。',
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
          error: 'Agent 正在处理中，不能手动提交审核。请等待 agent 调用 complete_task。',
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
      const allTasks: TeamTaskResponse[] = [];
      const projects = await dependencies.listProjects();
      for (const project of projects) {
        try {
          const tasks = activeTasks(await dependencies.readTasks(project.name));
          allTasks.push(...tasks.map(toTeamTask));
        } catch {
          // Skip projects without a readable local task board.
        }
      }
      return allTasks;
    } catch {
      return [];
    }
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
            error: 'Agent 正在处理中，不能手动完成或取消。请等待 agent 调用 complete_task。',
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
    Body: { text?: string; taskRefs?: unknown[] };
  }>('/api/teams/:name/tasks/:id/comments', async () => ({ ok: true }));

  app.post<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id/clarification',
    async () => ({ ok: true })
  );

  app.post<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id/relationships',
    async () => ({ ok: true })
  );
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

function registerLateAliasRoutes(app: FastifyInstance): void {
  app.post<{ Params: { name: string; taskId: string } }>(
    '/api/teams/:name/task-clarification/:taskId',
    async () => ({ ok: true })
  );

  app.delete<{ Params: { name: string; id: string } }>(
    '/api/teams/:name/tasks/:id/relationships',
    async () => ({ ok: true })
  );
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
  if (routes.has('late-aliases')) registerLateAliasRoutes(app);
}
