/* eslint-disable @typescript-eslint/require-await -- async test doubles implement Promise-returning route dependencies. */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  redispatchWaitingAgentTasks,
  registerTeamTaskRoutes,
  toTeamTask,
} from '../../../src/main/routes/teamTaskRoutes';
import type { Task } from '../../../src/main/services/team-management/TeamWorkspaceService';

const apps: ReturnType<typeof Fastify>[] = [];
const tempDirs: string[] = [];
const originalHermitHome = process.env.HERMIT_HOME;
type Dependencies = Parameters<typeof registerTeamTaskRoutes>[1];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-12345678',
    teamSlug: 'team-a',
    title: 'Task title',
    description: 'Task description',
    status: 'todo',
    assignee: null,
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
    addDelivery: vi.fn(async (_teamName, _taskId, input) => ({
      task: task(),
      delivery: {
        version: 1,
        result: input.result,
        deliveredAt: '2026-01-01T00:00:02.000Z',
      },
      skippedFeedbackIds: [] as string[],
    })),
    addFeedbackItem: vi.fn(async (_teamName, _taskId, input) => ({
      id: 'f_test',
      text: input.text,
      status: 'open' as const,
      createdAt: '2026-01-01T00:00:02.000Z',
    })),
    appendTaskHistoryEvent: vi.fn(async (_teamName, _taskId, event) =>
      task({ historyEvents: [event] })
    ),
    dispatchTask: vi.fn(async () => ({ delivered: true })),
    listProjects: vi.fn(async () => [{ name: 'project-a' }, { name: 'project-b' }]),
    readTeamManifest: vi.fn(async (teamName) => ({
      slug: teamName === 'project-a' ? 'team-a' : teamName,
      displayName: teamName === 'project-a' ? 'Team Alpha' : teamName,
    })),
    broadcastTaskChange: vi.fn(),
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
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  if (originalHermitHome === undefined) delete process.env.HERMIT_HOME;
  else process.env.HERMIT_HOME = originalHermitHome;
});

describe('team task routes', () => {
  it('presents submitted legacy tasks as waiting for review instead of still in progress', () => {
    expect(toTeamTask(task({ status: 'doing', reviewState: 'review' })).status).toBe('completed');
  });

  it('maps canonical list/create contracts and filters soft-deleted tasks', async () => {
    const readTasks = vi.fn(async () => [
      task(),
      task({
        id: 'deleted-task',
        title: 'Deleted',
        status: 'done',
        deletedAt: '2026-01-02T00:00:00.000Z',
      }),
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
    const pendingUploadTask = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks',
      payload: {
        subject: 'Create with files',
        owner: 'team-b',
        startImmediately: false,
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
      descriptionTaskRefs: undefined,
      prompt: undefined,
      promptTaskRefs: undefined,
      assignee: 'team-b',
      status: 'doing',
      blockedBy: undefined,
      related: undefined,
      createdBy: 'user',
    });
    expect(harness.dependencies.dispatchTask).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.dispatchTask).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({ title: 'Create me', assignee: 'team-b', status: 'doing' })
    );
    expect(created.json()).toEqual(
      expect.objectContaining({ subject: 'Create me', status: 'in_progress' })
    );
    expect(pendingUploadTask.json()).toEqual(
      expect.objectContaining({ subject: 'Create with files', status: 'pending' })
    );
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'title/subject required' });
  });

  it('缺省 owner 创建时默认分配给团队 displayName，显式 owner 不被覆盖', async () => {
    const harness = createHarness({
      readTeamManifest: vi.fn(async (teamName) => ({
        slug: teamName,
        displayName: '阿尔法团队',
      })),
    });

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks',
      payload: { subject: 'smoke task', description: 'no owner' },
    });
    const explicit = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks',
      payload: { subject: 'assigned task', owner: '指定员工' },
    });

    // 缺省 → 团队自身（displayName），并按既有规则立即开工
    expect(harness.dependencies.createTask).toHaveBeenNthCalledWith(
      1,
      'team-a',
      expect.objectContaining({ assignee: '阿尔法团队', status: 'doing' })
    );
    expect(created.json()).toEqual(
      expect.objectContaining({ owner: '阿尔法团队', status: 'in_progress' })
    );
    // 显式 owner 原样透传
    expect(harness.dependencies.createTask).toHaveBeenNthCalledWith(
      2,
      'team-a',
      expect.objectContaining({ assignee: '指定员工' })
    );
    expect(explicit.json()).toEqual(expect.objectContaining({ owner: '指定员工' }));
    expect(harness.dependencies.dispatchTask).toHaveBeenCalledTimes(2);
  });

  it('uploads, reads, and deletes task attachments in browser mode', async () => {
    const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentcli-task-attachments-'));
    tempDirs.push(hermitHome);
    process.env.HERMIT_HOME = hermitHome;
    let currentTask = task();
    const readTasks = vi.fn(async () => [currentTask]);
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) => {
      currentTask = { ...currentTask, ...patch };
      return currentTask;
    });
    const harness = createHarness({ readTasks, patchTask });
    const base64Data = Buffer.from('attachment-data').toString('base64');

    const uploaded = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/attachments',
      payload: {
        attachmentId: 'attachment-1',
        filename: 'proof.png',
        mimeType: 'image/png',
        base64Data,
      },
    });
    const downloaded = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/tasks/task-12345678/attachments/attachment-1',
    });
    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/teams/team-a/tasks/task-12345678/attachments/attachment-1',
    });

    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toEqual(
      expect.objectContaining({
        id: 'attachment-1',
        filename: 'proof.png',
        mimeType: 'image/png',
        size: Buffer.from('attachment-data').length,
      })
    );
    expect(downloaded.json()).toEqual({ base64Data });
    expect(deleted.json()).toEqual({ ok: true });
    expect(currentTask.attachments).toEqual([]);
  });

  it('accepts local document inputs for a task', async () => {
    const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentcli-task-doc-input-'));
    tempDirs.push(hermitHome);
    process.env.HERMIT_HOME = hermitHome;
    let currentTask = task();
    const harness = createHarness({
      readTasks: vi.fn(async () => [currentTask]),
      patchTask: vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) => {
        currentTask = { ...currentTask, ...patch };
        return currentTask;
      }),
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/attachments',
      payload: {
        attachmentId: 'attachment-docx',
        filename: '客户资料.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        base64Data: Buffer.from('document-data').toString('base64'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(currentTask.attachments?.[0]).toEqual(
      expect.objectContaining({ filename: '客户资料.docx' })
    );
  });

  it('approves and archives the latest deliverable through the kanban action', async () => {
    const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentcli-approval-'));
    tempDirs.push(hermitHome);
    process.env.HERMIT_HOME = hermitHome;
    let currentTask = task({
      status: 'done',
      assignee: 'research-assistant',
      reviewState: 'review',
      revisionCount: 2,
      needsHumanIntervention: true,
      deliveries: [
        {
          version: 1,
          result: '# 正式交付\n\n已完成。',
          deliveredAt: '2026-01-01T00:00:01.000Z',
        },
      ],
    });
    const readTasks = vi.fn(async () => [currentTask]);
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) => {
      currentTask = { ...currentTask, ...patch };
      return currentTask;
    });
    const harness = createHarness({ readTasks, patchTask });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'set_column', column: 'approved' },
    });

    expect(response.statusCode).toBe(200);
    expect(patchTask).toHaveBeenCalledWith('team-a', 'task-12345678', {
      status: 'done',
      reviewState: 'approved',
      revisionCount: 0,
      needsHumanIntervention: false,
    });
    expect(harness.dependencies.appendTaskHistoryEvent).toHaveBeenCalledWith(
      'team-a',
      'task-12345678',
      expect.objectContaining({ type: 'review_approved', to: 'approved', actor: 'reviewer' })
    );
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.task).toEqual(
      expect.objectContaining({ status: 'completed', reviewState: 'approved', revisionCount: 0 })
    );
    expect(body.task.historyEvents.at(-1)).toEqual(
      expect.objectContaining({ type: 'review_approved', actor: 'reviewer' })
    );
    const outputRoot = path.join(hermitHome, 'teams', 'team-a', 'outputs');
    const folders = await readdir(outputRoot);
    expect(folders).toHaveLength(1);
    const manifest = JSON.parse(
      await readFile(path.join(outputRoot, folders[0], 'manifest.json'), 'utf8')
    ) as { versions: Array<{ deliveryVersion: number }> };
    expect(manifest.versions).toEqual([expect.objectContaining({ deliveryVersion: 1 })]);
    expect(patchTask.mock.calls[0][2]).not.toHaveProperty('comments');
  });

  it('restores review fields when deliverable archival fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentcli-approval-failure-'));
    tempDirs.push(root);
    const invalidHermitHome = path.join(root, 'not-a-directory');
    await writeFile(invalidHermitHome, 'blocked');
    process.env.HERMIT_HOME = invalidHermitHome;

    let currentTask = task({
      status: 'done',
      reviewState: 'review',
      revisionCount: 2,
      needsHumanIntervention: true,
      deliveries: [{ version: 1, result: '正式交付', deliveredAt: '2026-01-01T00:00:01.000Z' }],
    });
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) => {
      currentTask = { ...currentTask, ...patch };
      return currentTask;
    });
    const harness = createHarness({
      readTasks: vi.fn(async () => [currentTask]),
      patchTask,
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'set_column', column: 'approved' },
    });

    expect(response.statusCode).toBe(500);
    expect(patchTask).toHaveBeenCalledTimes(2);
    expect(currentTask).toMatchObject({
      status: 'done',
      reviewState: 'review',
      revisionCount: 2,
      needsHumanIntervention: true,
    });
    expect(harness.dependencies.appendTaskHistoryEvent).not.toHaveBeenCalled();
  });

  it('rejects approval when the task has no delivery or has open feedback', async () => {
    const noDelivery = task({ status: 'done', reviewState: 'review' });
    const noDeliveryHarness = createHarness({ readTasks: vi.fn(async () => [noDelivery]) });
    const noDeliveryResponse = await noDeliveryHarness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'set_column', column: 'approved' },
    });
    expect(noDeliveryResponse.statusCode).toBe(409);
    expect(noDeliveryHarness.dependencies.patchTask).not.toHaveBeenCalled();

    const openFeedback = task({
      status: 'done',
      reviewState: 'review',
      deliveries: [{ version: 1, result: '交付', deliveredAt: '2026-01-01T00:00:01.000Z' }],
      feedbackItems: [
        {
          id: 'f_open',
          text: '仍需修改',
          status: 'open',
          createdAt: '2026-01-01T00:00:02.000Z',
        },
      ],
    });
    const openFeedbackHarness = createHarness({
      readTasks: vi.fn(async () => [openFeedback]),
    });
    const openFeedbackResponse = await openFeedbackHarness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'set_column', column: 'approved' },
    });
    expect(openFeedbackResponse.statusCode).toBe(409);
    expect(openFeedbackHarness.dependencies.patchTask).not.toHaveBeenCalled();
  });

  it('归档后追加沉淀建议消息，同一任务只建议一次', async () => {
    const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentcli-suggestion-'));
    tempDirs.push(hermitHome);
    process.env.HERMIT_HOME = hermitHome;
    let currentTask = task({
      status: 'done',
      assignee: 'research-assistant',
      reviewState: 'review',
      deliveries: [
        { version: 1, result: '# 正式交付\n\n已完成。', deliveredAt: '2026-01-01T00:00:01.000Z' },
      ],
    });
    const appended: Array<{ meta?: Record<string, unknown> | null }> = [];
    const harness = createHarness({
      readTasks: vi.fn(async () => [currentTask]),
      patchTask: vi.fn(async (_teamName, _taskId, patch) => {
        currentTask = { ...currentTask, ...patch };
        return currentTask;
      }),
      appendInboxMessage: vi.fn(async (_teamName, input) => {
        appended.push(input as { meta?: Record<string, unknown> | null });
        return {};
      }),
      readInboxMessages: vi.fn(async () => appended),
    });

    const approve = () =>
      harness.app.inject({
        method: 'PATCH',
        url: '/api/teams/team-a/kanban/task-12345678',
        payload: { op: 'set_column', column: 'approved' },
      });

    const first = await approve();
    expect(first.statusCode).toBe(200);
    const suggestions = appended.filter(
      (message) => message.meta?.source === 'precipitation_suggestion'
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.meta).toMatchObject({
      conversationId: 'task:task-12345678',
      taskRefs: [expect.objectContaining({ taskId: 'task-12345678', teamName: 'team-a' })],
    });
    expect(String((suggestions[0] as { content?: string }).content)).toContain('沉淀一下');

    // 二次归档：线程已有建议消息 → 不再追加
    const second = await approve();
    expect(second.statusCode).toBe(200);
    expect(
      appended.filter((message) => message.meta?.source === 'precipitation_suggestion')
    ).toHaveLength(1);
  });

  it('sends requested changes back to the same task instead of creating another task', async () => {
    let currentTask = task({
      status: 'done',
      assignee: 'research-assistant',
      reviewState: 'review',
    });
    const readTasks = vi.fn(async () => [currentTask]);
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) => {
      currentTask = { ...currentTask, ...patch };
      return currentTask;
    });
    const harness = createHarness({ readTasks, patchTask });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'request_changes', comment: '请补充英国站费用。' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({ ok: true, revisionCount: 1, needsHumanIntervention: false })
    );
    expect(currentTask).toMatchObject({
      status: 'doing',
      reviewState: 'needsFix',
      revisionCount: 1,
      needsHumanIntervention: false,
    });
    // 反馈建成 open 的 FeedbackItem，不再写成评论
    expect(harness.dependencies.addFeedbackItem).toHaveBeenCalledWith('team-a', 'task-12345678', {
      text: '请补充英国站费用。',
    });
    expect(harness.dependencies.appendTaskHistoryEvent).toHaveBeenCalledWith(
      'team-a',
      'task-12345678',
      expect.objectContaining({
        type: 'review_changes_requested',
        to: 'needsFix',
        actor: 'reviewer',
        note: '请补充英国站费用。',
      })
    );
    expect(harness.dependencies.dispatchTask).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({ id: 'task-12345678', status: 'doing' })
    );
    expect(harness.dependencies.createTask).not.toHaveBeenCalled();
  });

  it('increments the revision count without a feedback item when request_changes has no comment', async () => {
    let currentTask = task({
      status: 'done',
      assignee: 'research-assistant',
      reviewState: 'review',
      revisionCount: 2,
    });
    const readTasks = vi.fn(async () => [currentTask]);
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) => {
      currentTask = { ...currentTask, ...patch };
      return currentTask;
    });
    const harness = createHarness({ readTasks, patchTask });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'request_changes' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({ ok: true, revisionCount: 3, needsHumanIntervention: true })
    );
    expect(harness.dependencies.addFeedbackItem).not.toHaveBeenCalled();
    expect(patchTask).toHaveBeenCalledWith('team-a', 'task-12345678', {
      status: 'doing',
      reviewState: 'needsFix',
      needsClarification: undefined,
      revisionCount: 3,
      needsHumanIntervention: true,
    });
    const event = vi.mocked(harness.dependencies.appendTaskHistoryEvent).mock.calls[0][2];
    expect(event).toMatchObject({
      type: 'review_changes_requested',
      to: 'needsFix',
      actor: 'reviewer',
    });
    expect(event).not.toHaveProperty('note');
  });

  // ---------------------------------------------------------------------------
  // 派发可靠性（dispatch-reliability）
  // ---------------------------------------------------------------------------

  function needsFixTask(overrides: Partial<Task> = {}): Task {
    return task({
      status: 'doing',
      assignee: 'research-assistant',
      reviewState: 'needsFix',
      revisionCount: 1,
      feedbackItems: [
        { id: 'f1', text: '第一条意见', status: 'open', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      historyEvents: [
        {
          id: 'e_needsfix',
          type: 'review_changes_requested',
          from: 'review',
          to: 'needsFix',
          timestamp: '2026-01-01T00:00:00.000Z',
          actor: 'reviewer',
        },
      ],
      ...overrides,
    });
  }

  const requestChanges = (harness: ReturnType<typeof createHarness>, comment: string) =>
    harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'request_changes', comment },
    });

  it('needsFix 态下 agent 无活动时新反馈触发重派（携带全部 open 反馈），revisionCount 不变', async () => {
    const harness = createHarness({
      readTasks: vi.fn(async () => [needsFixTask()]),
      hasLiveAgentSession: vi.fn(() => false),
      readInboxMessages: vi.fn(async () => [
        // needsFix 之后只有用户自己的反馈消息，不算 agent 活动
        {
          from: 'user',
          ts: '2026-01-01T00:10:00.000Z',
          meta: { conversationId: 'task:task-12345678', source: 'user_sent' },
        },
      ]),
    });

    const response = await requestChanges(harness, '再补一条。');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ ok: true, revisionCount: 1 }));
    expect(harness.dependencies.dispatchTask).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.dispatchTask).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        id: 'task-12345678',
        feedbackItems: [expect.objectContaining({ text: '第一条意见' })],
      })
    );
    // 同轮退回不重复累计退回次数
    expect(harness.dependencies.patchTask).not.toHaveBeenCalledWith(
      'team-a',
      'task-12345678',
      expect.objectContaining({ revisionCount: 2 })
    );
  });

  it('needsFix 态下会话存活（agent 有活动）时只追加反馈不重派', async () => {
    const harness = createHarness({
      readTasks: vi.fn(async () => [needsFixTask()]),
      hasLiveAgentSession: vi.fn(() => true),
    });

    const response = await requestChanges(harness, '补充第二条。');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ ok: true, revisionCount: 1 }));
    expect(harness.dependencies.dispatchTask).not.toHaveBeenCalled();
    // 反馈条目照记
    expect(harness.dependencies.addFeedbackItem).toHaveBeenCalledWith('team-a', 'task-12345678', {
      text: '补充第二条。',
    });
  });

  it('活动判定看任务线程 agent 消息时间：needsFix 后有 agent 消息不重派，之前则重派', async () => {
    const staleThreadHarness = createHarness({
      readTasks: vi.fn(async () => [needsFixTask()]),
      hasLiveAgentSession: vi.fn(() => false),
      readInboxMessages: vi.fn(async () => [
        // agent 消息早于进入 needsFix 的时间 → 不算活动
        {
          from: 'research-assistant',
          ts: '2025-12-31T23:00:00.000Z',
          meta: { conversationId: 'task:task-12345678', source: 'runtime_delivery' },
        },
      ]),
    });
    const activeThreadHarness = createHarness({
      readTasks: vi.fn(async () => [needsFixTask()]),
      hasLiveAgentSession: vi.fn(() => false),
      readInboxMessages: vi.fn(async () => [
        // agent 消息晚于进入 needsFix 的时间 → 有活动
        {
          from: 'research-assistant',
          ts: '2026-01-01T01:00:00.000Z',
          meta: { conversationId: 'task:task-12345678', source: 'runtime_delivery' },
        },
      ]),
    });

    await requestChanges(staleThreadHarness, '再来一条。');
    await requestChanges(activeThreadHarness, '再来一条。');

    expect(staleThreadHarness.dependencies.dispatchTask).toHaveBeenCalledTimes(1);
    expect(activeThreadHarness.dependencies.dispatchTask).not.toHaveBeenCalled();
  });

  it('创建任务派发未送达时标记等待智能体上线（waitingForAgent + lastDispatchAt）', async () => {
    const dispatchTask = vi.fn(async () => ({ delivered: false }));
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) =>
      task({ ...patch })
    );
    const harness = createHarness({ dispatchTask, patchTask });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks',
      payload: { subject: '离线任务', owner: 'team-a' },
    });

    expect(dispatchTask).toHaveBeenCalledTimes(1);
    expect(patchTask).toHaveBeenCalledWith(
      'team-a',
      'task-12345678',
      expect.objectContaining({ waitingForAgent: true, lastDispatchAt: expect.any(String) })
    );
    expect(response.json()).toEqual(expect.objectContaining({ waitingForAgent: true }));
  });

  it('request_changes 派发未送达置等待标记，补发送达后清除', async () => {
    let currentTask = task({
      status: 'done',
      assignee: 'research-assistant',
      reviewState: 'review',
    });
    const readTasks = vi.fn(async () => [currentTask]);
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) => {
      currentTask = { ...currentTask, ...patch };
      return currentTask;
    });
    const dispatchTask = vi.fn(async () => ({ delivered: false }));
    const harness = createHarness({
      readTasks,
      patchTask,
      dispatchTask,
      hasLiveAgentSession: vi.fn(() => false),
      readInboxMessages: vi.fn(async () => []),
    });

    const first = await requestChanges(harness, '请补充英国站费用。');
    expect(first.json().task).toEqual(expect.objectContaining({ waitingForAgent: true }));
    expect(currentTask).toMatchObject({ waitingForAgent: true });
    expect(typeof currentTask.lastDispatchAt).toBe('string');

    // 用户再次反馈（needsFix 轮内、仍无 agent 活动）→ 触发补发；送达后清除等待标记
    currentTask = {
      ...currentTask,
      historyEvents: [
        {
          id: 'e_needsfix',
          type: 'review_changes_requested',
          from: 'review',
          to: 'needsFix',
          timestamp: '2026-01-01T00:00:00.000Z',
          actor: 'reviewer',
        },
      ],
    };
    dispatchTask.mockResolvedValue({ delivered: true });
    const second = await requestChanges(harness, '再补一条。');
    expect(second.statusCode).toBe(200);
    expect(dispatchTask).toHaveBeenCalledTimes(2);
    expect(currentTask).toMatchObject({ waitingForAgent: false });
    expect(second.json().task).toEqual(expect.objectContaining({ waitingForAgent: false }));
  });

  it('redispatchWaitingAgentTasks 只补发等待中的任务并按结果刷新标记', async () => {
    const waiting = task({
      id: 'task-wait',
      assignee: 'research-assistant',
      status: 'doing',
      waitingForAgent: true,
    });
    const normal = task({ id: 'task-ok', assignee: 'research-assistant', status: 'doing' });
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) =>
      task({ ...patch })
    );
    const dispatchTask = vi.fn(async () => ({ delivered: true }));
    const harness = createHarness({
      readTasks: vi.fn(async () => [waiting, normal]),
      patchTask,
      dispatchTask,
    });

    await redispatchWaitingAgentTasks(harness.dependencies, 'team-a');

    expect(dispatchTask).toHaveBeenCalledTimes(1);
    expect(dispatchTask).toHaveBeenCalledWith('team-a', expect.objectContaining({ id: 'task-wait' }));
    expect(patchTask).toHaveBeenCalledWith(
      'team-a',
      'task-wait',
      expect.objectContaining({ waitingForAgent: false, lastDispatchAt: expect.any(String) })
    );
  });

  it('resolves leftover open feedback when approval is forced', async () => {
    const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentcli-approval-force-'));
    tempDirs.push(hermitHome);
    process.env.HERMIT_HOME = hermitHome;
    let currentTask = task({
      status: 'done',
      assignee: 'research-assistant',
      reviewState: 'review',
      deliveries: [
        {
          version: 1,
          result: '# 正式交付\n\n已完成。',
          deliveredAt: '2026-01-01T00:00:01.000Z',
        },
      ],
      feedbackItems: [
        { id: 'f_open', text: '遗留问题', status: 'open', createdAt: '2026-01-01T00:00:02.000Z' },
        {
          id: 'f_done',
          text: '已改问题',
          status: 'resolved',
          createdAt: '2026-01-01T00:00:02.000Z',
          resolvedAt: '2026-01-01T00:00:03.000Z',
        },
      ],
    });
    const readTasks = vi.fn(async () => [currentTask]);
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) => {
      currentTask = { ...currentTask, ...patch };
      return currentTask;
    });
    const appendInboxMessage = vi.fn(async () => ({}));
    const broadcastInboxChange = vi.fn();
    const harness = createHarness({
      readTasks,
      patchTask,
      appendInboxMessage,
      broadcastInboxChange,
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'set_column', column: 'approved', force: true },
    });

    expect(response.statusCode).toBe(200);
    // 归档收尾消息写入同一线程
    expect(appendInboxMessage).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        from: 'user',
        content: '已通过并归档（第 1 版交付）',
        meta: expect.objectContaining({ conversationId: 'task:task-12345678' }),
      })
    );
    expect(broadcastInboxChange).toHaveBeenCalledWith('team-a');
    const patchPayload = patchTask.mock.calls[0][2];
    expect(patchPayload).toMatchObject({ status: 'done', reviewState: 'approved' });
    const feedbackItems = patchPayload.feedbackItems ?? [];
    expect(feedbackItems).toHaveLength(2);
    expect(feedbackItems[0]).toMatchObject({ id: 'f_open', status: 'resolved' });
    expect(typeof feedbackItems[0]?.resolvedAt).toBe('string');
    expect(feedbackItems[1]).toMatchObject({
      id: 'f_done',
      status: 'resolved',
      resolvedAt: '2026-01-01T00:00:03.000Z',
    });
  });

  it('passes the anchor through to the feedback item on request_changes', async () => {
    let currentTask = task({
      status: 'done',
      assignee: 'research-assistant',
      reviewState: 'review',
    });
    const appendInboxMessage = vi.fn(async () => ({}));
    const broadcastInboxChange = vi.fn();
    const harness = createHarness({
      readTasks: vi.fn(async () => [currentTask]),
      patchTask: vi.fn(async (_teamName, _taskId, patch) => {
        currentTask = { ...currentTask, ...patch };
        return currentTask;
      }),
      appendInboxMessage,
      broadcastInboxChange,
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: {
        op: 'request_changes',
        comment: '这句话需要改写。',
        anchor: { kind: 'quote', quote: '原文片段' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(harness.dependencies.addFeedbackItem).toHaveBeenCalledWith('team-a', 'task-12345678', {
      text: '这句话需要改写。',
      anchor: { kind: 'quote', quote: '原文片段' },
    });
    // 退回意见写入 from=user 的线程回复消息（quote 进引用块）并广播 inbox
    expect(appendInboxMessage).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        from: 'user',
        content: '> 原文片段\n\n这句话需要改写。',
        meta: expect.objectContaining({
          source: 'user_sent',
          conversationId: 'task:task-12345678',
        }),
      })
    );
    expect(broadcastInboxChange).toHaveBeenCalledWith('team-a');

    const invalid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: {
        op: 'request_changes',
        comment: '这句话需要改写。',
        anchor: { kind: 'quote' },
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('only appends a feedback item when requesting changes on an already-rejected task', async () => {
    const currentTask = task({
      status: 'doing',
      assignee: 'research-assistant',
      reviewState: 'needsFix',
      revisionCount: 1,
    });
    const patchTask = vi.fn();
    const harness = createHarness({
      readTasks: vi.fn(async () => [currentTask]),
      patchTask,
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'request_changes', comment: '同一轮再补一条意见。' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({ ok: true, revisionCount: 1, needsHumanIntervention: false })
    );
    expect(harness.dependencies.addFeedbackItem).toHaveBeenCalledWith('team-a', 'task-12345678', {
      text: '同一轮再补一条意见。',
    });
    expect(patchTask).not.toHaveBeenCalled();
    expect(harness.dependencies.appendTaskHistoryEvent).not.toHaveBeenCalled();
    expect(harness.dependencies.dispatchTask).not.toHaveBeenCalled();
    expect(harness.dependencies.broadcastTaskChange).toHaveBeenCalledWith(
      'team-a',
      'task-12345678'
    );
  });

  it('returns squad deliveries to the collaboration state machine for rework', async () => {
    let currentTask = task({
      status: 'done',
      assignee: 'captain',
      reviewState: 'review',
      collaborationRunId: 'run-1',
      taskKind: 'root',
    });
    const requestCollaborationChanges = vi.fn(
      async (_runId: string, _feedback: string, beforeStart?: () => Promise<void>) => {
        await beforeStart?.();
      }
    );
    const harness = createHarness({
      readTasks: vi.fn(async () => [currentTask]),
      patchTask: vi.fn(async (_teamName, _taskId, patch) => {
        currentTask = { ...currentTask, ...patch };
        return currentTask;
      }),
      requestCollaborationChanges,
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'request_changes', comment: '请让全队补充风险分析。' },
    });

    expect(response.statusCode).toBe(200);
    expect(requestCollaborationChanges).toHaveBeenCalledWith(
      'run-1',
      '请让全队补充风险分析。',
      expect.any(Function)
    );
    expect(harness.dependencies.dispatchTask).not.toHaveBeenCalled();
  });

  it('does not mutate the root task when the collaboration orchestrator rejects rework', async () => {
    const currentTask = task({
      status: 'done',
      assignee: 'captain',
      reviewState: 'review',
      collaborationRunId: 'run-1',
      taskKind: 'root',
    });
    const patchTask = vi.fn();
    const harness = createHarness({
      readTasks: vi.fn(async () => [currentTask]),
      patchTask,
      requestCollaborationChanges: vi.fn(async () => {
        throw new Error('当前协作任务不能返工');
      }),
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/kanban/task-12345678',
      payload: { op: 'request_changes', comment: '请补充。' },
    });

    expect(response.statusCode).toBe(500);
    expect(patchTask).not.toHaveBeenCalled();
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
      error: 'Agent 正在处理中，不能手动完成或取消。请等待 Agent 通过 AgentCLI 提交结果。',
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
    // PATCH 不再接受 body.result
    expect(harness.dependencies.patchTask).toHaveBeenNthCalledWith(1, 'team-a', 'task-12345678', {
      title: 'Renamed',
      description: 'Changed',
      status: 'done',
      assignee: 'team-b',
    });
    expect(deleted.json()).toEqual({ ok: true });
    expect(harness.dependencies.patchTask).toHaveBeenNthCalledWith(2, 'team-a', 'task-12345678', {
      status: 'done',
      deletedAt: expect.any(String),
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

  it('includes task boards owned by local intelligent agents even when they are not bridge projects', async () => {
    const collaborationRoot = task({
      id: 'collaboration-root',
      teamSlug: 'captain-agent',
      title: '小队最终交付',
      taskKind: 'root',
      collaborationRunId: 'run-1',
      status: 'done',
      reviewState: 'review',
    });
    const harness = createHarness({
      listProjects: vi.fn(async () => []),
      listTeams: vi.fn(async () => [{ slug: 'captain-agent' }]),
      readTasks: vi.fn(async (teamName: string) =>
        teamName === 'captain-agent' ? [collaborationRoot] : []
      ),
      readTeamManifest: vi.fn(async () => ({
        slug: 'captain-agent',
        displayName: '小队队长',
      })),
    });

    expect((await harness.app.inject({ method: 'GET', url: '/api/teams/tasks' })).json()).toEqual([
      expect.objectContaining({
        id: collaborationRoot.id,
        teamName: 'captain-agent',
        teamDisplayName: '小队队长',
        collaborationRunId: 'run-1',
        reviewState: 'review',
      }),
    ]);
  });

  it('provides a team-scoped CLI task bus for list, claim, comment, clarification, and completion', async () => {
    let stored = task({ assignee: 'team-b' });
    const patchTask = vi.fn(async (_teamName: string, _taskId: string, patch: Partial<Task>) => {
      stored = { ...stored, ...patch, updatedAt: '2026-01-01T00:00:02.000Z' };
      return stored;
    });
    const harness = createHarness({
      listProjects: vi.fn(async () => [{ name: 'project-a' }]),
      readTasks: vi.fn(async () => [stored]),
      patchTask,
    });

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/task-bus/tasks?team=team-b',
    });
    expect(listed.json()).toEqual([
      expect.objectContaining({ id: stored.id, owner: 'team-b', teamName: 'team-a' }),
    ]);

    const forbidden = await harness.app.inject({
      method: 'POST',
      url: `/api/task-bus/tasks/${stored.id}/claim`,
      payload: { team: 'team-c' },
    });
    expect(forbidden.statusCode).toBe(403);

    const claimed = await harness.app.inject({
      method: 'POST',
      url: `/api/task-bus/tasks/${stored.id.slice(0, 12)}/claim`,
      payload: { team: 'team-b' },
    });
    expect(claimed.json()).toEqual(
      expect.objectContaining({
        ok: true,
        task: expect.objectContaining({ status: 'in_progress' }),
      })
    );
    expect(harness.dependencies.appendTaskHistoryEvent).toHaveBeenCalledWith(
      'project-a',
      stored.id,
      expect.objectContaining({
        type: 'status_changed',
        from: 'pending',
        to: 'in_progress',
        actor: 'agent',
      })
    );

    const clarified = await harness.app.inject({
      method: 'POST',
      url: `/api/task-bus/tasks/${stored.id}/clarification`,
      payload: { team: 'team-b', target: 'user' },
    });
    expect(clarified.json()).toEqual(
      expect.objectContaining({
        ok: true,
        task: expect.objectContaining({ needsClarification: 'user' }),
      })
    );

    const completed = await harness.app.inject({
      method: 'POST',
      url: `/api/task-bus/tasks/${stored.id}/complete`,
      payload: { team: 'team-b', result: '任务已完成' },
    });
    expect(completed.json()).toEqual(
      expect.objectContaining({
        ok: true,
        task: expect.objectContaining({ status: 'completed', reviewState: 'review' }),
      })
    );
    // 完成时的 result 记录为一条 delivery，不再写任务上的 result 字段
    expect(harness.dependencies.addDelivery).toHaveBeenCalledWith('project-a', stored.id, {
      result: '任务已完成',
    });
    expect(harness.dependencies.appendTaskHistoryEvent).toHaveBeenCalledWith(
      'project-a',
      stored.id,
      expect.objectContaining({
        type: 'status_changed',
        from: 'in_progress',
        to: 'completed',
        actor: 'agent',
      })
    );
    expect(stored.status).toBe('done');
    expect(harness.dependencies.broadcastTaskChange).toHaveBeenCalledTimes(3);
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
      task({ id: 'deleted-task', status: 'done', deletedAt: '2026-01-02T00:00:00.000Z' }),
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
      expect.objectContaining({
        id: 'deleted-task',
        status: 'completed',
        deletedAt: '2026-01-02T00:00:00.000Z',
      }),
    ]);

    expect(harness.dependencies.patchTask).toHaveBeenNthCalledWith(1, 'team-a', 'task-12345678', {
      status: 'done',
      deletedAt: expect.any(String),
    });
    expect(harness.dependencies.patchTask).toHaveBeenNthCalledWith(2, 'team-a', 'deleted-task', {
      status: 'todo',
      deletedAt: null,
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
    expect(afterAdd.json()).toEqual([
      expect.objectContaining({
        needsClarification: 'lead',
        blockedBy: ['task-2'],
      }),
    ]);
    expect(stored.needsClarification).toBe('user');
    expect(stored.blockedBy).toBeUndefined();
    expect(harness.dependencies.dispatchTask).not.toHaveBeenCalled();
  });

  it('任务评论接口已移除：原评论路由返回 404', async () => {
    const harness = createHarness();
    const teamComment = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/tasks/task-12345678/comments',
      payload: { text: '行，继续处理' },
    });
    const busComment = await harness.app.inject({
      method: 'POST',
      url: '/api/task-bus/tasks/task-12345678/comments',
      payload: { team: 'team-b', text: '正在处理' },
    });

    expect(teamComment.statusCode).toBe(404);
    expect(busComment.statusCode).toBe(404);
    expect(harness.dependencies.patchTask).not.toHaveBeenCalled();
    expect(harness.dependencies.dispatchTask).not.toHaveBeenCalled();
  });

  it('validates every clarification and relationship handler before board mutation', async () => {
    const harness = createHarness();
    const requests = [
      harness.app.inject({
        method: 'POST',
        url: '/api/teams/team-a/tasks/task-12345678/clarification',
        payload: { value: 'admin' },
      }),
      harness.app.inject({
        method: 'POST',
        url: '/api/teams/team-a/task-clarification/task-12345678',
        payload: {},
      }),
      harness.app.inject({
        method: 'POST',
        url: '/api/teams/team-a/tasks/task-12345678/relationships',
        payload: { targetId: 'task-2', type: 'comments' },
      }),
      harness.app.inject({
        method: 'DELETE',
        url: '/api/teams/team-a/tasks/task-12345678/relationships',
        payload: { targetId: '   ', type: 'blockedBy' },
      }),
    ];

    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);
    expect(harness.dependencies.readTasks).not.toHaveBeenCalled();
    expect(harness.dependencies.patchTask).not.toHaveBeenCalled();
  });
});
