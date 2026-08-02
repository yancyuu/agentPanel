/**
 * Tests: MCP Server tools (executeMcpTool via TeamWorkspaceService + TeamProvisioningService)
 *
 * 直接调用 mcpTaskTools.executeMcpTool 的真实实现（in-process，不起 HTTP server），
 * 基建沿用 TeamWorkspaceService + TeamProvisioningService + 临时 HERMIT_HOME。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { executeMcpTool } from '@main/services/team-management/mcpTaskTools';
import { TeamProvisioningService } from '@main/services/team-management/TeamProvisioningService';
import { TeamWorkspaceService } from '@main/services/team-management/TeamWorkspaceService';

// ---------------------------------------------------------------------------

let tmpDir: string;
let workspace: TeamWorkspaceService;
let svc: TeamProvisioningService;
let exec: (toolName: string, args: Record<string, unknown>) => ReturnType<typeof executeMcpTool>;
let teamSlug: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-mcp-test-'));
  process.env.HERMIT_HOME = tmpDir;
  workspace = new TeamWorkspaceService();
  svc = new TeamProvisioningService(
    { createProject: vi.fn(), restart: vi.fn() } as never,
    { sendUserMessage: vi.fn() } as never,
    workspace
  );
  exec = (toolName, args) => executeMcpTool(svc, toolName, args);

  const { slug } = await svc.createTeam({
    displayName: 'mcp-test',
    bindProject: 'mcp-cc',
    harness: 'claudecode',
    workDir: path.join(tmpDir, 'work'),
    createCcProject: false,
  });
  teamSlug = slug;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HERMIT_HOME;
});

// ---------------------------------------------------------------------------
describe('MCP tool: list_tasks', () => {
  it('returns empty array when no tasks', async () => {
    const [result] = await exec('list_tasks', { team_slug: teamSlug });
    const tasks = JSON.parse(result.text);
    expect(tasks).toEqual([]);
  });

  it('returns tasks after creation', async () => {
    await svc.createTask(teamSlug, { title: 'task-a' });
    await svc.createTask(teamSlug, { title: 'task-b' });
    const [result] = await exec('list_tasks', { team_slug: teamSlug });
    const tasks = JSON.parse(result.text);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe('task-a');
  });
});

// ---------------------------------------------------------------------------
describe('MCP tool: claim_task', () => {
  it('sets status to doing and records a status_changed event', async () => {
    const task = await svc.createTask(teamSlug, { title: 'claimable' });
    const [result] = await exec('claim_task', { team_slug: teamSlug, task_id: task.id });
    const claimed = JSON.parse(result.text);
    expect(claimed.status).toBe('doing');
    expect(claimed.id).toBe(task.id);
    expect(claimed.historyEvents.at(-1)).toMatchObject({
      type: 'status_changed',
      from: 'pending',
      to: 'in_progress',
      actor: 'agent',
    });
  });

  it('throws for non-existent task id', async () => {
    await expect(exec('claim_task', { team_slug: teamSlug, task_id: 'bad-id' })).rejects.toThrow(
      'task not found: bad-id'
    );
  });
});

// ---------------------------------------------------------------------------
describe('MCP tool: complete_task', () => {
  it('sets status to done without a delivery when no result is given', async () => {
    const task = await svc.createTask(teamSlug, { title: 'completable' });
    const [result] = await exec('complete_task', { team_slug: teamSlug, task_id: task.id });
    const done = JSON.parse(result.text);
    expect(done.status).toBe('done');
    expect(done.deliveries).toBeUndefined();
    expect(done.historyEvents.at(-1)).toMatchObject({
      type: 'status_changed',
      from: 'in_progress',
      to: 'completed',
      actor: 'agent',
    });
  });

  it('records the result as a delivery instead of a result field', async () => {
    const task = await svc.createTask(teamSlug, { title: 'with result' });
    const [result] = await exec('complete_task', {
      team_slug: teamSlug,
      task_id: task.id,
      result: 'PR #99 merged',
    });
    const done = JSON.parse(result.text);
    expect(done.status).toBe('done');
    expect(done.deliveries).toHaveLength(1);
    expect(done.deliveries[0]).toMatchObject({ version: 1, result: 'PR #99 merged' });
  });
});

// ---------------------------------------------------------------------------
describe('MCP tool: create_task', () => {
  it('creates task with title only', async () => {
    const [result] = await exec('create_task', { team_slug: teamSlug, title: 'new task' });
    const task = JSON.parse(result.text);
    expect(task.id).toMatch(/^t_/);
    expect(task.title).toBe('new task');
    expect(task.status).toBe('todo');
  });

  it('creates task with description and assignee', async () => {
    // Create target team first so assignee is valid slug
    await svc.createTeam({
      displayName: 'backend',
      bindProject: 'backend-cc',
      harness: 'codex',
      workDir: path.join(tmpDir, 'backend'),
      createCcProject: false,
    });

    const [result] = await exec('create_task', {
      team_slug: teamSlug,
      title: 'backend work',
      description: '需要后端处理',
      assignee: 'backend',
    });
    const task = JSON.parse(result.text);
    expect(task.assignee).toBe('backend');
    expect(task.description).toBe('需要后端处理');
  });
});

// ---------------------------------------------------------------------------
describe('MCP tool: deliver_task', () => {
  it('first delivery gets version=1, moves the task to review and echoes dispatch_id', async () => {
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    const [result] = await exec('deliver_task', {
      team_slug: teamSlug,
      dispatch_id: task.id,
      result: '# 第一版报告',
    });
    const payload = JSON.parse(result.text);
    expect(payload.dispatch_id).toBe(task.id);
    expect(payload.delivery).toMatchObject({ version: 1, result: '# 第一版报告' });
    expect(payload.status).toBe('done');
    expect(payload.reviewState).toBe('review');
    expect(payload.needsHumanIntervention).toBe(false);
    expect(payload.historyEvents.at(-1)).toMatchObject({
      type: 'review_requested',
      to: 'review',
      actor: 'agent',
    });
    expect(payload.skippedFeedbackIds).toBeUndefined();
  });

  it('交付写入 runtime_delivery 线程消息并广播 inbox SSE', async () => {
    const appendMessage = vi.fn().mockResolvedValue({});
    const broadcastInboxChange = vi.fn();
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    await executeMcpTool(
      svc,
      'deliver_task',
      { team_slug: teamSlug, dispatch_id: task.id, result: '# 第一版报告' },
      { appendMessage, broadcastInboxChange }
    );

    expect(appendMessage).toHaveBeenCalledTimes(1);
    const [slugArg, input] = appendMessage.mock.calls[0];
    expect(slugArg).toBe(teamSlug);
    expect(input.to).toBe('user');
    expect(input.content).toContain('交付 第 1 版');
    expect(input.content).toContain('# 第一版报告');
    expect(input.meta).toMatchObject({
      source: 'runtime_delivery',
      conversationId: `task:${task.id}`,
    });
    expect(input.meta.taskRefs).toEqual([
      expect.objectContaining({ taskId: task.id, teamName: teamSlug }),
    ]);
    expect(broadcastInboxChange).toHaveBeenCalledWith(teamSlug);
  });

  it('再次交付聚合为同一线程并带本版变更摘要', async () => {
    const appendMessage = vi.fn().mockResolvedValue({});
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    await executeMcpTool(
      svc,
      'deliver_task',
      { team_slug: teamSlug, dispatch_id: task.id, result: 'v1' },
      { appendMessage }
    );
    await executeMcpTool(
      svc,
      'deliver_task',
      { team_slug: teamSlug, dispatch_id: task.id, result: 'v2', summary: '补充风险分析' },
      { appendMessage }
    );

    expect(appendMessage).toHaveBeenCalledTimes(2);
    const [, second] = appendMessage.mock.calls[1];
    expect(second.meta.conversationId).toBe(`task:${task.id}`);
    expect(second.meta.summary).toBe('补充风险分析');
    expect(second.content).toContain('交付 第 2 版');
    expect(second.content).toContain('【本版变更摘要】补充风险分析');
  });

  it('消息写入失败不阻塞交付本身', async () => {
    const appendMessage = vi.fn().mockRejectedValue(new Error('disk full'));
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    const [result] = await executeMcpTool(
      svc,
      'deliver_task',
      { team_slug: teamSlug, dispatch_id: task.id, result: '# 第一版报告' },
      { appendMessage }
    );
    const payload = JSON.parse(result.text);
    expect(payload.delivery).toMatchObject({ version: 1 });
    expect(payload.reviewState).toBe('review');
  });

  it('requires a summary when the task already has deliveries', async () => {
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    await exec('deliver_task', { team_slug: teamSlug, dispatch_id: task.id, result: 'v1' });
    await expect(
      exec('deliver_task', { team_slug: teamSlug, dispatch_id: task.id, result: 'v2' })
    ).rejects.toThrow('该任务已有历史交付，再次交付时必须提供 summary（本轮变更摘要）。');
  });

  it('accepts a follow-up delivery with summary as version=2', async () => {
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    await exec('deliver_task', { team_slug: teamSlug, dispatch_id: task.id, result: 'v1' });
    const [result] = await exec('deliver_task', {
      team_slug: teamSlug,
      dispatch_id: task.id,
      result: 'v2',
      summary: '补充风险分析',
    });
    const payload = JSON.parse(result.text);
    expect(payload.delivery).toMatchObject({ version: 2, result: 'v2', summary: '补充风险分析' });
    expect(payload.historyEvents.at(-1)).toMatchObject({
      type: 'review_requested',
      note: '补充风险分析',
    });
  });

  it('resolves addressed open feedback and reports skipped ids', async () => {
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    const item = await svc.addFeedbackItem(teamSlug, task.id, { text: '请补充数据来源' });
    const [result] = await exec('deliver_task', {
      team_slug: teamSlug,
      dispatch_id: task.id,
      result: 'v1',
      addressed_feedback_ids: [item.id, 'f_missing'],
    });
    const payload = JSON.parse(result.text);
    expect(payload.skippedFeedbackIds).toEqual(['f_missing']);
    expect(payload.feedbackItems).toEqual([
      expect.objectContaining({ id: item.id, status: 'resolved', resolvedAt: expect.any(String) }),
    ]);
  });

  it('clears needsHumanIntervention on a new delivery', async () => {
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    for (let round = 1; round <= 3; round += 1) {
      await exec('reject_result', {
        team_slug: teamSlug,
        dispatch_id: task.id,
        feedback: `第 ${round} 次退回`,
      });
    }
    let stored = (await svc.readTasks(teamSlug)).find((entry) => entry.id === task.id);
    expect(stored?.needsHumanIntervention).toBe(true);

    const [result] = await exec('deliver_task', {
      team_slug: teamSlug,
      dispatch_id: task.id,
      result: '修复版',
      summary: '一次性处理三条反馈',
    });
    const payload = JSON.parse(result.text);
    expect(payload.needsHumanIntervention).toBe(false);
    stored = (await svc.readTasks(teamSlug)).find((entry) => entry.id === task.id);
    expect(stored?.needsHumanIntervention).toBe(false);
  });

  it('throws for unknown dispatch id', async () => {
    await expect(
      exec('deliver_task', { team_slug: teamSlug, dispatch_id: 'missing', result: 'x' })
    ).rejects.toThrow('task not found: missing');
  });
});

// ---------------------------------------------------------------------------
describe('MCP tool: approve_task', () => {
  it('rejects approval while open feedback remains and does not patch the task', async () => {
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    await exec('deliver_task', { team_slug: teamSlug, dispatch_id: task.id, result: 'v1' });
    await exec('reject_result', {
      team_slug: teamSlug,
      dispatch_id: task.id,
      feedback: '请补充数据来源',
    });

    await expect(
      exec('approve_task', { team_slug: teamSlug, dispatch_id: task.id })
    ).rejects.toThrow(/仍有 1 条未处理的反馈，不能审核通过/);

    const stored = (await svc.readTasks(teamSlug)).find((entry) => entry.id === task.id);
    expect(stored).toMatchObject({ status: 'doing', reviewState: 'needsFix', revisionCount: 1 });
  });

  it('approves when no open feedback remains, resetting counters and recording review_approved', async () => {
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    await exec('deliver_task', { team_slug: teamSlug, dispatch_id: task.id, result: 'v1' });
    await exec('reject_result', {
      team_slug: teamSlug,
      dispatch_id: task.id,
      feedback: '改一版',
    });
    const openId = (await svc.readTasks(teamSlug)).find((entry) => entry.id === task.id)
      ?.feedbackItems?.[0]?.id as string;
    await exec('deliver_task', {
      team_slug: teamSlug,
      dispatch_id: task.id,
      result: 'v2',
      summary: '处理反馈',
      addressed_feedback_ids: [openId],
    });

    const [result] = await exec('approve_task', { team_slug: teamSlug, dispatch_id: task.id });
    const payload = JSON.parse(result.text);
    expect(payload.dispatch_id).toBe(task.id);
    expect(payload.revisionCount).toBe(0);
    expect(payload.needsHumanIntervention).toBe(false);
    expect(payload.reviewState).toBe('approved');
    expect(payload.historyEvents.at(-1)).toMatchObject({
      type: 'review_approved',
      to: 'approved',
      actor: 'reviewer',
    });
  });
});

// ---------------------------------------------------------------------------
describe('MCP tool: reject_result', () => {
  it('creates an open feedback item with anchor and sends the task back to doing', async () => {
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    await exec('deliver_task', { team_slug: teamSlug, dispatch_id: task.id, result: 'v1' });

    const [result] = await exec('reject_result', {
      team_slug: teamSlug,
      dispatch_id: task.id,
      feedback: '第三段结论需要数据支撑',
      anchor: { kind: 'quote', quote: '第三段结论' },
    });
    const payload = JSON.parse(result.text);
    expect(payload.dispatch_id).toBe(task.id);
    expect(payload.feedbackItem).toMatchObject({
      text: '第三段结论需要数据支撑',
      status: 'open',
      anchor: { kind: 'quote', quote: '第三段结论' },
    });
    expect(payload.feedbackItem.id).toMatch(/^f_/);
    expect(payload.status).toBe('doing');
    expect(payload.revisionCount).toBe(1);
    expect(payload.reviewState).toBe('needsFix');
    expect(payload.humanInterventionRequired).toBeUndefined();
    expect(payload.historyEvents.at(-1)).toMatchObject({
      type: 'review_changes_requested',
      to: 'needsFix',
      actor: 'reviewer',
      note: '第三段结论需要数据支撑',
    });
  });

  it('flags human intervention after three rejections', async () => {
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    let payload: Record<string, unknown> = {};
    for (let round = 1; round <= 3; round += 1) {
      const [result] = await exec('reject_result', {
        team_slug: teamSlug,
        dispatch_id: task.id,
        feedback: `第 ${round} 次退回`,
      });
      payload = JSON.parse(result.text) as Record<string, unknown>;
    }
    expect(payload.revisionCount).toBe(3);
    expect(payload.needsHumanIntervention).toBe(true);
    expect(payload.humanInterventionRequired).toBe(true);
    expect(payload.note).toBe('该任务交付已退回 3 次（>= 3），需要人工介入处理。');
  });

  it('rejects empty feedback', async () => {
    const task = await svc.createTask(teamSlug, { title: 'deliverable' });
    await expect(
      exec('reject_result', { team_slug: teamSlug, dispatch_id: task.id, feedback: '  ' })
    ).rejects.toThrow('feedback is required');
  });
});

// ---------------------------------------------------------------------------
describe('MCP tool: unknown tool', () => {
  it('throws for unknown tool name', async () => {
    await expect(exec('do_magic', { team_slug: teamSlug })).rejects.toThrow('Unknown tool: do_magic');
  });
});
