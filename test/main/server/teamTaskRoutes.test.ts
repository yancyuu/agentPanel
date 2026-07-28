/* eslint-disable @typescript-eslint/require-await -- async test doubles implement Promise-returning route dependencies. */

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTeamTaskRoutes } from '../../../src/main/routes/teamTaskRoutes';
import type { Task } from '../../../src/main/services/team-management/TeamWorkspaceService';

const apps: ReturnType<typeof Fastify>[] = [];
type Dependencies = Parameters<typeof registerTeamTaskRoutes>[1];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-12345678',
    teamSlug: 'team-a',
    title: 'Task title',
    description: 'Task description',
    status: 'todo',
    assignee: null,
    result: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    order: 0,
    ...overrides,
  };
}

function createHarness(overrides: Partial<Dependencies> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);

  const dependencies: Dependencies = {
    readTasks: vi.fn(async () => [task()]),
    createTask: vi.fn(async (_teamName, payload) =>
      task({
        title: payload.title,
        description: payload.description,
        assignee: payload.assignee,
        status: payload.status ?? 'todo',
      })
    ),
    patchTask: vi.fn(async (_teamName, _taskId, patch) => task(patch)),
    dispatchTask: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => [{ name: 'project-a' }, { name: 'project-b' }]),
    readTeamManifest: vi.fn(async (teamName) => ({
      slug: teamName === 'project-a' ? 'team-a' : teamName,
      displayName: teamName === 'project-a' ? 'Team Alpha' : teamName,
    })),
    reply500: (error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
    ...overrides,
  };

  registerTeamTaskRoutes(app, dependencies);
  return { app, dependencies };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('team task routes', () => {
  it('maps canonical list/create contracts and filters soft-deleted tasks', async () => {
    const readTasks = vi.fn(async () => [
      task(),
      task({ id: 'deleted-task', title: 'Deleted', result: '__deleted__' }),
    ]);
    const harness = createHarness({ readTasks });

    const list = await harness.app.inject({ method: 'GET', url: '/api/teams/team-a/tasks' });
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks',
      payload: {
        subject: 'Create me',
        description: 'Details',
        owner: 'team-b',
        status: 'in_progress',
      },
    });
    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks',
      payload: {},
    });

    expect(list.json()).toEqual([
      expect.objectContaining({
        id: 'task-12345678',
        displayId: 'task-123',
        subject: 'Task title',
        status: 'pending',
      }),
    ]);
    expect(harness.dependencies.createTask).toHaveBeenCalledWith('team-a', {
      title: 'Create me',
      description: 'Details',
      assignee: 'team-b',
      status: 'doing',
    });
    expect(created.json()).toEqual(
      expect.objectContaining({ subject: 'Create me', status: 'in_progress' })
    );
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'title/subject required' });
  });

  it('maps canonical patches and blocks manual exit or deletion while an agent is working', async () => {
    const readTasks = vi.fn(async () => [task({ status: 'doing' })]);
    const harness = createHarness({ readTasks });

    const blockedPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/tasks/task-12345678',
      payload: { subject: 'Renamed', status: 'completed', owner: 'team-b' },
    });
    const blockedDelete = await harness.app.inject({
      method: 'DELETE',
      url: '/api/teams/team-a/tasks/task-12345678',
    });

    expect(blockedPatch.statusCode).toBe(409);
    expect(blockedPatch.json()).toEqual({
      ok: false,
      error: 'Agent 正在处理中，不能手动完成或取消。请等待 agent 调用 complete_task。',
    });
    expect(blockedDelete.statusCode).toBe(409);
    expect(blockedDelete.json()).toEqual({
      ok: false,
      error: 'Agent 正在处理中，不能手动删除任务。',
    });
    expect(harness.dependencies.patchTask).not.toHaveBeenCalled();
  });

  it('preserves canonical patch mapping and soft-delete behavior', async () => {
    const harness = createHarness();

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/tasks/task-12345678',
      payload: {
        subject: 'Renamed',
        description: 'Changed',
        status: 'completed',
        owner: 'team-b',
        result: 'done',
      },
    });
    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/teams/team-a/tasks/task-12345678',
    });

    expect(patched.statusCode).toBe(200);
    expect(harness.dependencies.patchTask).toHaveBeenNthCalledWith(1, 'team-a', 'task-12345678', {
      title: 'Renamed',
      description: 'Changed',
      status: 'done',
      assignee: 'team-b',
      result: 'done',
    });
    expect(deleted.json()).toEqual({ ok: true });
    expect(harness.dependencies.patchTask).toHaveBeenNthCalledWith(2, 'team-a', 'task-12345678', {
      status: 'done',
      result: '__deleted__',
    });
  });

  it('aggregates active tasks across projects and degrades per project and globally', async () => {
    const readTasks = vi.fn(async (teamName: string) => {
      if (teamName === 'project-a') return [task({ teamSlug: teamName })];
      throw new Error('missing board');
    });
    const harness = createHarness({ readTasks });

    const partial = await harness.app.inject({ method: 'GET', url: '/api/teams/tasks' });
    expect(partial.json()).toEqual([
      expect.objectContaining({
        id: 'task-12345678',
        subject: 'Task title',
        teamName: 'team-a',
        teamDisplayName: 'Team Alpha',
        teamDeleted: false,
      }),
    ]);

    const failed = createHarness({
      listProjects: vi.fn(async () => {
        throw new Error('bridge offline');
      }),
    });
    expect((await failed.app.inject({ method: 'GET', url: '/api/teams/tasks' })).json()).toEqual(
      []
    );
  });

  it('keeps request-review and review alias behavior identical, including the doing guard', async () => {
    const harness = createHarness();

    const canonical = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/request-review',
    });
    const alias = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/review',
    });

    expect(canonical.json()).toEqual({
      ok: true,
      data: expect.objectContaining({ status: 'completed' }),
    });
    expect(alias.json()).toEqual(canonical.json());
    expect(harness.dependencies.patchTask).toHaveBeenNthCalledWith(1, 'team-a', 'task-12345678', {
      status: 'done',
    });
    expect(harness.dependencies.patchTask).toHaveBeenNthCalledWith(2, 'team-a', 'task-12345678', {
      status: 'done',
    });

    const blocked = createHarness({ readTasks: vi.fn(async () => [task({ status: 'doing' })]) });
    const blockedResponse = await blocked.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/review',
    });
    expect(blockedResponse.statusCode).toBe(409);
  });

  it('preserves status, owner, fields, and explicit start dispatch semantics', async () => {
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) =>
      task({ ...patch, assignee: patch.assignee === undefined ? 'team-b' : patch.assignee })
    );
    const harness = createHarness({ patchTask });

    await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/tasks/task-12345678/status',
      payload: { status: 'in_progress' },
    });
    await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/tasks/task-12345678/owner',
      payload: { owner: 'team-c' },
    });
    await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/tasks/task-12345678/fields',
      payload: { subject: 'Renamed', description: 'Changed', ignored: true },
    });
    const started = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/start',
    });
    const startedByUser = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/start-by-user',
    });

    expect(patchTask).toHaveBeenNthCalledWith(1, 'team-a', 'task-12345678', { status: 'doing' });
    expect(patchTask).toHaveBeenNthCalledWith(2, 'team-a', 'task-12345678', { assignee: 'team-c' });
    expect(patchTask).toHaveBeenNthCalledWith(3, 'team-a', 'task-12345678', {
      title: 'Renamed',
      description: 'Changed',
    });
    expect(started.json()).toEqual({ notifiedOwner: true });
    expect(startedByUser.json()).toEqual({ notifiedOwner: true });
    expect(harness.dependencies.dispatchTask).toHaveBeenCalledTimes(2);
  });

  it('preserves soft-delete, restore, and deleted-list contracts', async () => {
    const readTasks = vi.fn(async () => [
      task(),
      task({ id: 'deleted-task', status: 'done', result: '__deleted__' }),
    ]);
    const harness = createHarness({ readTasks });

    expect(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/api/teams/team-a/tasks/task-12345678/soft-delete',
        })
      ).json()
    ).toEqual({ ok: true });
    expect(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/api/teams/team-a/tasks/deleted-task/restore',
        })
      ).json()
    ).toEqual({ ok: true });
    expect(
      (
        await harness.app.inject({
          method: 'GET',
          url: '/api/teams/team-a/deleted-tasks',
        })
      ).json()
    ).toEqual([
      expect.objectContaining({ id: 'deleted-task', status: 'completed', result: '__deleted__' }),
    ]);

    expect(harness.dependencies.patchTask).toHaveBeenNthCalledWith(1, 'team-a', 'task-12345678', {
      status: 'done',
      result: '__deleted__',
    });
    expect(harness.dependencies.patchTask).toHaveBeenNthCalledWith(2, 'team-a', 'deleted-task', {
      status: 'todo',
      result: null,
    });
  });

  it('keeps kanban aliases as no-op compatibility routes while task collaboration routes persist data', async () => {
    let stored = task();
    const harness = createHarness({
      readTasks: vi.fn(async () => [stored]),
      patchTask: vi.fn(async (_teamName, _taskId, patch) => {
        stored = { ...stored, ...patch, updatedAt: '2026-01-01T00:00:02.000Z' };
        return stored;
      }),
    });
    const kanban = await harness.app.inject({ method: 'GET', url: '/api/teams/team-a/kanban' });
    const presence = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/task-change-presence',
    });
    const comment = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/comments',
      payload: {
        text: 'Please check TASK-1',
        taskRefs: [{ taskId: 'task-1', displayId: 'TASK-1', teamName: 'team-a' }],
        attachments: [
          {
            id: 'attachment-1',
            filename: 'note.txt',
            mimeType: 'text/plain',
            base64Data: Buffer.from('hello').toString('base64'),
          },
        ],
      },
    });
    await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/clarification',
      payload: { value: 'lead' },
    });
    await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/relationships',
      payload: { targetId: 'task-2', type: 'blockedBy' },
    });
    const afterAdd = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/tasks',
    });
    await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/task-clarification/task-12345678',
      payload: { value: 'user' },
    });
    await harness.app.inject({
      method: 'DELETE',
      url: '/api/teams/team-a/tasks/task-12345678/relationships',
      payload: { targetId: 'task-2', type: 'blockedBy' },
    });

    expect(kanban.json()).toEqual({ teamName: 'team-a', reviewers: [], tasks: {} });
    expect(presence.json()).toEqual({});
    expect(comment.statusCode).toBe(200);
    expect(comment.json()).toEqual(
      expect.objectContaining({
        author: 'user',
        text: 'Please check TASK-1',
        type: 'regular',
        taskRefs: [{ taskId: 'task-1', displayId: 'TASK-1', teamName: 'team-a' }],
        attachments: [
          expect.objectContaining({
            id: 'attachment-1',
            filename: 'note.txt',
            mimeType: 'text/plain',
            size: 5,
            filePath: null,
          }),
        ],
      })
    );
    expect(afterAdd.json()).toEqual([
      expect.objectContaining({
        comments: [expect.objectContaining({ text: 'Please check TASK-1' })],
        needsClarification: 'lead',
        blockedBy: ['task-2'],
      }),
    ]);
    expect(stored.needsClarification).toBe('user');
    expect(stored.blockedBy).toBeUndefined();
    expect(harness.dependencies.dispatchTask).not.toHaveBeenCalled();
  });
});
