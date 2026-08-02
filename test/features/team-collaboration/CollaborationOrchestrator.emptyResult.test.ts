import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CollaborationOrchestrator } from '@features/team-collaboration/main/CollaborationOrchestrator';
import { CollaborationWorkspaceService } from '@features/team-collaboration/main/CollaborationWorkspaceService';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DirectCliEvent } from '@main/services/direct-cli';
import type { CollaborationRun } from '@features/team-collaboration/shared/contracts';
import type { TeamProvisioningService } from '@main/services/team-management';
import type { Task } from '@main/services/team-management/TeamWorkspaceService';

const temporaryDirectories: string[] = [];

/** work 阶段返回内容可变的 fake direct CLI（模拟成员产出为空 → 返工后产出正常） */
class FakeDirectCli extends EventEmitter {
  readonly prompts: string[] = [];
  workText = '   ';

  send(sessionKey: string, params: { messageId: string; text: string }): Promise<void> {
    this.prompts.push(params.text);
    let text: string;
    if (sessionKey.includes(':roundtable:')) {
      const slug = sessionKey.split(':roundtable:')[1];
      text = JSON.stringify({
        nomineeTeamSlug: 'agent-a',
        statement: '统一规划。',
        suggestedContribution: slug === 'agent-a' ? '规划整合' : '资料研究',
      });
    } else if (sessionKey.includes(':planning:')) {
      text = JSON.stringify({
        summary: 'A 统筹，B 研究。',
        workItems: [
          {
            title: '结构化购买报告',
            description: '产出面向消费者的结构化购买报告。',
            assigneeTeamSlug: 'agent-b',
            expectedOutput: 'Markdown 报告',
          },
        ],
      });
    } else if (sessionKey.includes(':work-')) {
      text = this.workText;
    } else if (sessionKey.includes(':integration:')) {
      text = '# 最终交付物\n\n队长整合后的正式成果。';
    } else {
      throw new Error(`unexpected session ${sessionKey}`);
    }
    queueMicrotask(() => {
      this.emit('event', {
        kind: 'complete',
        sessionKey,
        messageId: params.messageId,
        text,
      } satisfies DirectCliEvent);
    });
    return Promise.resolve();
  }
}

function createManifest(teamSlug: string, displayName: string, workDir: string) {
  return {
    slug: teamSlug,
    displayName,
    harness: 'claudecode',
    workDir,
    bindProject: teamSlug,
  };
}

async function waitFor(check: () => Promise<boolean>, attempts = 60, intervalMs = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor condition not met in time');
}

function createTeams(tasks: Task[], appendedMessages: Record<string, unknown>[]) {
  return {
    readTeamManifest(teamSlug: string) {
      const manifest =
        teamSlug === 'agent-a'
          ? createManifest('agent-a', '产品经理', '/tmp/a')
          : createManifest('agent-b', '研究员', '/tmp/b');
      return Promise.resolve(manifest);
    },
    createTask(teamSlug: string, payload: Record<string, unknown>) {
      const now = new Date().toISOString();
      const task: Task = {
        id: `t_${tasks.length + 1}`,
        teamSlug,
        title: String(payload.title ?? ''),
        description: payload.description as string | undefined,
        status: (payload.status as Task['status']) ?? 'todo',
        assignee: (payload.assignee as string | null | undefined) ?? null,
        parentTaskId: payload.parentTaskId as string | undefined,
        collaborationRunId: payload.collaborationRunId as string | undefined,
        taskKind: payload.taskKind as Task['taskKind'],
        createdAt: now,
        updatedAt: now,
        order: tasks.length,
      };
      tasks.push(task);
      return Promise.resolve(task);
    },
    patchTask(_teamSlug: string, taskId: string, patch: Partial<Task>) {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) return Promise.reject(new Error('not found'));
      Object.assign(task, patch, { updatedAt: new Date().toISOString() });
      return Promise.resolve(task);
    },
    addDelivery(_teamSlug: string, taskId: string, input: { result: string }) {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) return Promise.reject(new Error('not found'));
      const delivery = {
        version: (task.deliveries?.length ?? 0) + 1,
        result: input.result,
        deliveredAt: new Date().toISOString(),
      };
      task.deliveries = [...(task.deliveries ?? []), delivery];
      return Promise.resolve({ task, delivery, skippedFeedbackIds: [] as string[] });
    },
    readTasks() {
      return Promise.resolve(tasks);
    },
    appendMessage(_teamSlug: string, input: Record<string, unknown>) {
      appendedMessages.push(input);
      return Promise.resolve({});
    },
    readMessages() {
      return Promise.resolve([]);
    },
  } as unknown as Pick<
    TeamProvisioningService,
    | 'readTeamManifest'
    | 'createTask'
    | 'patchTask'
    | 'addDelivery'
    | 'readTasks'
    | 'appendMessage'
    | 'readMessages'
  >;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('空结果工作项不标 completed 且 retry 可恢复', () => {
  it('空结果标 failed（含任务名报错），retry 重新派发后完成', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcli-collab-empty-'));
    temporaryDirectories.push(root);
    const workspace = new CollaborationWorkspaceService(root);
    const tasks: Task[] = [];
    const appendedMessages: Record<string, unknown>[] = [];
    const teams = createTeams(tasks, appendedMessages);
    const directCli = new FakeDirectCli();
    const orchestrator = new CollaborationOrchestrator({
      workspace,
      teams,
      directCli,
      workbenchUrl: 'http://127.0.0.1:5690',
      responseTimeoutMs: 1000,
    });

    const team = await workspace.createTeam({
      displayName: '测试协作团队',
      memberTeamSlugs: ['agent-a', 'agent-b'],
    });
    const run = await orchestrator.createRun(team.slug, {
      title: '完成一份购买报告',
      description: '成员产出结构化内容。',
    });

    // 成员产出为空 → run 失败，报错点名具体工作项
    await waitFor(async () => (await workspace.readRun(run.id)).phase === 'failed');
    const failed = await workspace.readRun(run.id);
    expect(failed.error).toContain('未产出内容');
    expect(failed.workItems[0]).toMatchObject({
      title: '结构化购买报告',
      status: 'failed',
    });
    expect(failed.workItems[0]?.result).toBeUndefined();
    // 空结果不得落 delivery
    const subtask = tasks.find((task) => task.taskKind === 'subtask');
    expect(subtask?.deliveries ?? []).toHaveLength(0);

    // 成员恢复产出后 retry：failed 项被重新派发并完成整合
    directCli.workText = '# 结构化购买报告\n\n恢复后的正式产出。';
    orchestrator.start(run.id);
    await waitFor(async () => (await workspace.readRun(run.id)).phase === 'review');
    const recovered = await workspace.readRun(run.id);
    expect(recovered.workItems[0]).toMatchObject({
      status: 'completed',
      result: expect.stringContaining('恢复后的正式产出'),
    });
    expect(recovered.finalResult).toContain('最终交付物');
    orchestrator.dispose();
  });

  it('历史卡死 run（completed 但 result 为空）retry 时被视同未完成重新派发', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcli-collab-stuck-'));
    temporaryDirectories.push(root);
    const workspace = new CollaborationWorkspaceService(root);
    const tasks: Task[] = [];
    const appendedMessages: Record<string, unknown>[] = [];
    const teams = createTeams(tasks, appendedMessages);
    const directCli = new FakeDirectCli();
    const orchestrator = new CollaborationOrchestrator({
      workspace,
      teams,
      directCli,
      workbenchUrl: 'http://127.0.0.1:5690',
      responseTimeoutMs: 1000,
    });

    const team = await workspace.createTeam({
      displayName: '测试协作团队',
      memberTeamSlugs: ['agent-a', 'agent-b'],
    });
    // 卡死 run 对应的成员任务与根任务（真实现场里它们存在于看板）
    tasks.push(
      {
        id: 't_stuck',
        teamSlug: 'root-team',
        title: '结构化购买报告',
        status: 'done',
        assignee: '研究员',
        parentTaskId: 't_root',
        collaborationRunId: 'cr_stuck',
        taskKind: 'subtask',
        deliveries: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        order: 0,
      },
      {
        id: 't_root',
        teamSlug: 'root-team',
        title: '历史卡死任务',
        status: 'doing',
        assignee: '产品经理',
        collaborationRunId: 'cr_stuck',
        taskKind: 'root',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        order: 1,
      }
    );
    const runSeed = {
      schemaVersion: 1,
      id: 'cr_stuck',
      collaborationTeamSlug: team.slug,
      collaborationTeamDisplayName: team.displayName,
      title: '历史卡死任务',
      phase: 'failed',
      captainTeamSlug: 'agent-a',
      captainDisplayName: '产品经理',
      ballots: [
        {
          memberTeamSlug: 'agent-a',
          memberDisplayName: '产品经理',
          nomineeTeamSlug: 'agent-a',
          statement: 's',
          suggestedContribution: 'c',
          receivedAt: new Date().toISOString(),
        },
        {
          memberTeamSlug: 'agent-b',
          memberDisplayName: '研究员',
          nomineeTeamSlug: 'agent-a',
          statement: 's',
          suggestedContribution: 'c',
          receivedAt: new Date().toISOString(),
        },
      ],
      workItems: [
        {
          id: 'wi_stuck',
          title: '结构化购买报告',
          description: '产出结构化报告',
          assigneeTeamSlug: 'agent-b',
          assigneeDisplayName: '研究员',
          taskId: 't_stuck',
          status: 'completed',
          // 卡死证据：completed 但 result 为空
          result: '  ',
          updatedAt: new Date().toISOString(),
        },
      ],
      error: '仍有成员工作项未完成，不能开始队长整合',
      members: [
        { teamSlug: 'agent-a', displayName: '产品经理', workDir: '/tmp/a' },
        { teamSlug: 'agent-b', displayName: '研究员', workDir: '/tmp/b' },
      ],
      rootTaskId: 't_root',
      rootTaskTeamSlug: 'root-team',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as CollaborationRun;
    await workspace.createRun(runSeed);
    const run = { id: runSeed.id };

    // retry：completed 空结果被视同未完成 → 重新派发（fake 现在产出正常）
    directCli.workText = '# 结构化购买报告\n\n重新派发后的产出。';
    orchestrator.start(run.id);
    await waitFor(async () => (await workspace.readRun(run.id)).phase === 'review');
    const recovered = await workspace.readRun(run.id);
    expect(recovered.workItems[0]).toMatchObject({
      status: 'completed',
      result: expect.stringContaining('重新派发后的产出'),
    });
    expect(recovered.finalResult).toContain('最终交付物');
    expect(directCli.prompts.some((prompt) => prompt.includes('结构化购买报告'))).toBe(true);
    orchestrator.dispose();
  });
});
