import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CollaborationOrchestrator,
  CollaborationWorkspaceService,
  electCaptain,
} from '@features/team-collaboration/main';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CollaborationMemberSnapshot,
  CollaborationRun,
} from '@features/team-collaboration/shared/contracts';
import type { DirectCliEvent } from '@main/services/direct-cli';
import type { TeamProvisioningService } from '@main/services/team-management';
import type { Task, TeamManifest } from '@main/services/team-management/TeamWorkspaceService';

const temporaryDirectories: string[] = [];

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for collaboration run');
}

class FakeDirectCli extends EventEmitter {
  readonly prompts: string[] = [];

  send(sessionKey: string, params: { messageId: string; text: string }): Promise<void> {
    this.prompts.push(params.text);
    let text: string;
    if (sessionKey.includes(':roundtable:agent-a')) {
      text = JSON.stringify({
        nomineeTeamSlug: 'agent-a',
        statement: '任务需要统一规划和最终整合。',
        suggestedContribution: '负责规划与整合',
      });
    } else if (sessionKey.includes(':roundtable:agent-b')) {
      text = JSON.stringify({
        nomineeTeamSlug: 'agent-a',
        statement: 'A 更适合协调，我负责资料研究。',
        suggestedContribution: '负责资料研究',
      });
    } else if (sessionKey.includes(':planning:')) {
      text = JSON.stringify({
        summary: 'A 统筹，B 研究。',
        workItems: [
          {
            title: '资料研究',
            description: '查清核心事实并形成结论。',
            assigneeTeamSlug: 'agent-b',
            expectedOutput: 'Markdown 研究结果',
          },
        ],
      });
    } else if (sessionKey.includes(':work-')) {
      text = '# 资料研究结果\n\n已经形成可以直接使用的事实与结论。';
    } else if (sessionKey.includes(':integration:')) {
      text = '# 最终交付物\n\n这是队长整合后的正式成果。';
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

function createManifest(
  slug: string,
  displayName: string,
  root: string,
  harness = 'claudecode'
): TeamManifest {
  return {
    schemaVersion: 2,
    slug,
    displayName,
    bindProject: slug,
    harness,
    workDir: path.join(root, slug),
    collaboration: true,
    rootPath: path.join(root, slug),
    createdAt: new Date().toISOString(),
  };
}

describe('CollaborationOrchestrator', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  it('elects by votes and resolves a tie by member order', () => {
    const members: CollaborationMemberSnapshot[] = [
      { teamSlug: 'a', displayName: 'A', harness: 'claudecode', workDir: '/a' },
      { teamSlug: 'b', displayName: 'B', harness: 'claudecode', workDir: '/b' },
    ];
    expect(
      electCaptain(members, [
        {
          memberTeamSlug: 'a',
          memberDisplayName: 'A',
          nomineeTeamSlug: 'b',
          statement: 'B',
          suggestedContribution: 'A work',
          receivedAt: new Date().toISOString(),
        },
        {
          memberTeamSlug: 'b',
          memberDisplayName: 'B',
          nomineeTeamSlug: 'a',
          statement: 'A',
          suggestedContribution: 'B work',
          receivedAt: new Date().toISOString(),
        },
      ]).teamSlug
    ).toBe('a');
  });

  it('automatically resumes in-flight runs after a local service restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcli-collaboration-recovery-'));
    temporaryDirectories.push(root);
    const workspace = new CollaborationWorkspaceService(root);
    const team = await workspace.createTeam({
      displayName: '恢复测试小队',
      memberTeamSlugs: ['agent-a', 'agent-b'],
    });
    const now = new Date().toISOString();
    const run: CollaborationRun = {
      schemaVersion: 1,
      id: 'run-interrupted',
      collaborationTeamSlug: team.slug,
      collaborationTeamDisplayName: team.displayName,
      title: '中断任务',
      phase: 'executing',
      members: [
        { teamSlug: 'agent-a', displayName: 'A', harness: 'claudecode', workDir: root },
        { teamSlug: 'agent-b', displayName: 'B', harness: 'claudecode', workDir: root },
      ],
      ballots: [],
      workItems: [
        {
          id: 'work-1',
          title: '执行工作',
          description: '处理中',
          assigneeTeamSlug: 'agent-a',
          assigneeDisplayName: 'A',
          expectedOutput: '结果',
          status: 'running',
          updatedAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await workspace.createRun(run);
    const orchestrator = new CollaborationOrchestrator({
      workspace,
      teams: {} as TeamProvisioningService,
      directCli: new FakeDirectCli(),
      workbenchUrl: 'http://127.0.0.1:5681',
    });

    const startSpy = vi.spyOn(orchestrator, 'start').mockImplementation(() => undefined);
    expect(await orchestrator.recoverInterruptedRuns()).toEqual([run.id]);
    const recovered = await workspace.readRun(run.id);
    expect(recovered.phase).toBe('executing');
    expect(recovered.error).toBeUndefined();
    expect(recovered.workItems[0]).toEqual(expect.objectContaining({ status: 'pending' }));
    expect(recovered.workItems[0]).not.toHaveProperty('error');
    expect(startSpy).toHaveBeenCalledWith(run.id);
    orchestrator.dispose();
  });

  it('reconciles an approved root task to a completed collaboration run after restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcli-collaboration-approved-'));
    temporaryDirectories.push(root);
    const workspace = new CollaborationWorkspaceService(root);
    const team = await workspace.createTeam({
      displayName: '审核同步小队',
      memberTeamSlugs: ['agent-a', 'agent-b'],
    });
    const now = new Date().toISOString();
    await workspace.createRun({
      schemaVersion: 1,
      id: 'run-approved',
      collaborationTeamSlug: team.slug,
      collaborationTeamDisplayName: team.displayName,
      title: '已审核任务',
      phase: 'review',
      members: [],
      ballots: [],
      rootTaskId: 'root-task',
      rootTaskTeamSlug: 'agent-a',
      workItems: [],
      finalResult: '完成结果',
      createdAt: now,
      updatedAt: now,
    });
    const teams = {
      readTasks: () =>
        Promise.resolve([
          {
            id: 'root-task',
            teamSlug: 'agent-a',
            title: '已审核任务',
            description: '',
            status: 'done',
            reviewState: 'approved',
            assignee: null,
            deliveries: [{ version: 1, result: '完成结果', deliveredAt: now }],
            createdAt: now,
            updatedAt: now,
            order: 0,
          } satisfies Task,
        ]),
    } as Pick<TeamProvisioningService, 'readTasks'>;
    const orchestrator = new CollaborationOrchestrator({
      workspace,
      teams: teams as TeamProvisioningService,
      directCli: new FakeDirectCli(),
      workbenchUrl: 'http://127.0.0.1:5681',
    });

    expect(await orchestrator.recoverInterruptedRuns()).toEqual([]);
    await expect(workspace.readRun('run-approved')).resolves.toMatchObject({ phase: 'completed' });
    orchestrator.dispose();
  });

  it('closes the roundtable, delegated work and captain integration loop', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcli-collaboration-'));
    temporaryDirectories.push(root);
    const workspace = new CollaborationWorkspaceService(root);
    const manifests = new Map([
      ['agent-a', createManifest('agent-a', '产品经理', root)],
      ['agent-b', createManifest('agent-b', '研究员', root, 'pi')],
    ]);
    const tasks: Task[] = [];
    const teams = {
      readTeamManifest(teamSlug: string) {
        const manifest = manifests.get(teamSlug);
        return manifest ? Promise.resolve(manifest) : Promise.reject(new Error('not found'));
      },
      createTask(teamSlug: string, payload: Record<string, unknown>) {
        const now = new Date().toISOString();
        const title = typeof payload.title === 'string' ? payload.title : '';
        const description = typeof payload.description === 'string' ? payload.description : '';
        const task: Task = {
          id: `t_${tasks.length + 1}`,
          teamSlug,
          title,
          description,
          status: (payload.status as Task['status']) ?? 'todo',
          assignee: (payload.assignee as string | null | undefined) ?? null,
          assigneeAgentId: payload.assigneeAgentId as string | undefined,
          parentTaskId: payload.parentTaskId as string | undefined,
          collaborationRunId: payload.collaborationRunId as string | undefined,
          taskKind: payload.taskKind as Task['taskKind'],
          createdBy: payload.createdBy as string | undefined,
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
    } as unknown as Pick<
      TeamProvisioningService,
      'readTeamManifest' | 'createTask' | 'patchTask' | 'addDelivery' | 'readTasks'
    >;
    const directCli = new FakeDirectCli();
    const orchestrator = new CollaborationOrchestrator({
      workspace,
      teams,
      directCli,
      workbenchUrl: 'http://127.0.0.1:5681',
      responseTimeoutMs: 1000,
    });

    const team = await workspace.createTeam({
      displayName: '测试协作团队',
      memberTeamSlugs: ['agent-a', 'agent-b'],
    });
    const run = await orchestrator.createRun(team.slug, {
      title: '完成一份研究报告',
      description: '需要研究员提供事实，队长整合。',
      attachments: [
        {
          filename: '用户资料.md',
          mimeType: 'text/plain',
          base64Data: Buffer.from('用户提供的研究资料', 'utf8').toString('base64'),
        },
      ],
    });

    await waitFor(async () => (await workspace.readRun(run.id)).phase === 'review');
    const completed = await workspace.readRun(run.id);
    expect(completed.captainTeamSlug).toBe('agent-a');
    expect(completed.ballots).toHaveLength(2);
    expect(completed.inputFiles).toHaveLength(1);
    expect(Object.keys(completed.inputFiles?.[0]?.pathsByMember ?? {})).toEqual([
      'agent-a',
      'agent-b',
    ]);
    expect(
      await fs.readFile(completed.inputFiles?.[0]?.pathsByMember['agent-b'] ?? '', 'utf8')
    ).toBe('用户提供的研究资料');
    expect(completed.workItems).toHaveLength(1);
    expect(completed.workItems[0]).toMatchObject({
      assigneeTeamSlug: 'agent-b',
      status: 'completed',
    });
    expect(completed.finalResult).toContain('最终交付物');
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.taskKind === 'subtask')).toMatchObject({
      parentTaskId: completed.rootTaskId,
      status: 'done',
    });
    expect(tasks.find((task) => task.taskKind === 'root')).toMatchObject({
      status: 'done',
      reviewState: 'review',
      comments: [
        expect.objectContaining({
          author: '产品经理',
          text: '小队已完成协作并提交最终成果，请检查结果。',
        }),
      ],
    });

    const promptsBeforeFailedPersistence = directCli.prompts.length;
    await expect(
      orchestrator.requestChanges(run.id, '这次持久化会失败', async () => {
        throw new Error('task persistence failed');
      })
    ).rejects.toThrow('task persistence failed');
    const rolledBack = await workspace.readRun(run.id);
    expect(rolledBack).toMatchObject({
      phase: 'review',
      finalResult: '# 最终交付物\n\n这是队长整合后的正式成果。',
    });
    expect(rolledBack.revisionNumber).toBeUndefined();
    expect(directCli.prompts).toHaveLength(promptsBeforeFailedPersistence);

    await orchestrator.requestChanges(run.id, '请补充风险和下一步建议');
    await waitFor(async () => {
      const revised = await workspace.readRun(run.id);
      return revised.phase === 'review' && revised.revisionNumber === 1;
    });
    const revised = await workspace.readRun(run.id);
    expect(revised).toMatchObject({
      phase: 'review',
      revisionNumber: 1,
      revisionFeedback: '请补充风险和下一步建议',
    });
    expect(tasks).toHaveLength(2);
    expect(directCli.prompts.some((prompt) => prompt.includes('请补充风险和下一步建议'))).toBe(
      true
    );

    orchestrator.dispose();
  });
});
