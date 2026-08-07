import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { historyEventId } from '@main/services/team-management/mcpTaskTools';
import { buildDeliveryThreadMessage } from '@main/services/team-management/reviewThreadMessages';
import { getReviewStateFromTask } from '@shared/utils/reviewState';

import type {
  CollaborationMemberSnapshot,
  CollaborationRun,
  CollaborationRunInputFile,
  CollaborationWorkItem,
  CreateCollaborationRunRequest,
  RoundtableBallot,
} from '../shared/contracts';
import type { CollaborationWorkspaceService } from './CollaborationWorkspaceService';
import type { DirectCliEvent } from '@main/services/direct-cli';
import type { TeamProvisioningService } from '@main/services/team-management';
import type { Task } from '@main/services/team-management/TeamWorkspaceService';

interface DirectCliGateway {
  on(eventName: 'event', listener: (event: DirectCliEvent) => void): unknown;
  off(eventName: 'event', listener: (event: DirectCliEvent) => void): unknown;
  send(
    sessionKey: string,
    params: {
      text: string;
      messageId: string;
      workDir: string;
      teamSlug: string;
      workbenchUrl: string;
    }
  ): Promise<void>;
  kill?(sessionKey: string): void;
}

interface PendingResponse {
  sessionKey: string;
  resolve(text: string): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface CollaborationOrchestratorDependencies {
  workspace: CollaborationWorkspaceService;
  teams: Pick<
    TeamProvisioningService,
    | 'readTeamManifest'
    | 'createTask'
    | 'patchTask'
    | 'readTasks'
    | 'addDelivery'
    | 'appendMessage'
    | 'readMessages'
    | 'appendTaskHistoryEvent'
  >;
  directCli: DirectCliGateway;
  workbenchUrl: string;
  dispatchAgentMessage?(params: {
    teamName: string;
    sessionKey: string;
    workDir: string;
    from: string;
    to: string;
    text: string;
    messageId: string;
    conversationId: string;
  }): Promise<void>;
  broadcastRunChange?(runId: string): void;
  responseTimeoutMs?: number;
}

interface BallotPayload {
  nomineeTeamSlug: string;
  statement: string;
  suggestedContribution: string;
}

interface PlanPayload {
  summary?: string;
  workItems: {
    title: string;
    description: string;
    assigneeTeamSlug: string;
    expectedOutput: string;
  }[];
}

function extractJsonObject(text: string): unknown {
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  const candidate =
    objectStart >= 0 && objectEnd > objectStart ? text.slice(objectStart, objectEnd + 1) : '';
  if (!candidate) throw new Error('数字员工没有返回结构化结果');
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    throw new Error('数字员工返回的结构化结果无法解析', { cause: error });
  }
}

function parseBallot(text: string, validMemberSlugs: Set<string>): BallotPayload {
  const payload = extractJsonObject(text) as Partial<BallotPayload>;
  const nomineeTeamSlug = payload.nomineeTeamSlug?.trim() ?? '';
  const statement = payload.statement?.trim() ?? '';
  const suggestedContribution = payload.suggestedContribution?.trim() ?? '';
  if (!validMemberSlugs.has(nomineeTeamSlug)) throw new Error('提名了团队之外的成员');
  if (!statement || !suggestedContribution) throw new Error('圆桌发言缺少必要内容');
  return { nomineeTeamSlug, statement, suggestedContribution };
}

function parsePlan(
  text: string,
  members: CollaborationMemberSnapshot[],
  captainTeamSlug: string
): PlanPayload {
  const payload = extractJsonObject(text) as Partial<PlanPayload>;
  if (!Array.isArray(payload.workItems) || payload.workItems.length === 0) {
    throw new Error('队长没有返回有效分工');
  }
  const validMemberSlugs = new Set(members.map((member) => member.teamSlug));
  const workItems = payload.workItems.slice(0, 4).map((item) => {
    const title = item.title?.trim() ?? '';
    const description = item.description?.trim() ?? '';
    const assigneeTeamSlug = item.assigneeTeamSlug?.trim() ?? '';
    const expectedOutput = item.expectedOutput?.trim() || '提交可直接用于最终交付的 Markdown 成果';
    if (!title || !description || !validMemberSlugs.has(assigneeTeamSlug)) {
      throw new Error('队长返回的分工包含无效成员或空任务');
    }
    return { title, description, assigneeTeamSlug, expectedOutput };
  });
  if (members.length > 1 && workItems.every((item) => item.assigneeTeamSlug === captainTeamSlug)) {
    throw new Error('队长没有把任何工作分配给其他成员');
  }
  return { summary: payload.summary?.trim(), workItems };
}

export function electCaptain(
  members: CollaborationMemberSnapshot[],
  ballots: RoundtableBallot[]
): CollaborationMemberSnapshot {
  if (members.length === 0) throw new Error('团队没有成员');
  const counts = new Map(members.map((member) => [member.teamSlug, 0]));
  for (const ballot of ballots) {
    if (counts.has(ballot.nomineeTeamSlug)) {
      counts.set(ballot.nomineeTeamSlug, (counts.get(ballot.nomineeTeamSlug) ?? 0) + 1);
    }
  }
  return members.reduce((winner, candidate) => {
    const winnerVotes = counts.get(winner.teamSlug) ?? 0;
    const candidateVotes = counts.get(candidate.teamSlug) ?? 0;
    return candidateVotes > winnerVotes ? candidate : winner;
  }, members[0]);
}

function safeInputFilename(filename: string, fallback: string): string {
  const normalized = path
    .basename(filename)
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .trim();
  return normalized || fallback;
}

function reserveRunInputFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let index = 2;
  let candidate = `${stem}-${index}${extension}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${stem}-${index}${extension}`;
  }
  used.add(candidate);
  return candidate;
}

function resolveRunInputDirectory(workDir: string, runId: string): string {
  const projectRoot = path.resolve(workDir);
  const safeRunId = safeInputFilename(runId, 'collaboration-run');
  const inputDirectory = path.resolve(projectRoot, 'input', safeRunId);
  if (!inputDirectory.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error('协作任务输入目录超出当前项目范围');
  }
  return inputDirectory;
}

async function materializeRunInputs(
  runId: string,
  members: CollaborationMemberSnapshot[],
  attachments: CreateCollaborationRunRequest['attachments']
): Promise<CollaborationRunInputFile[]> {
  if (!attachments || attachments.length === 0) return [];
  const usedFilenames = new Set<string>();
  const prepared = attachments.map((attachment, index) => {
    const filename = reserveRunInputFilename(
      safeInputFilename(attachment.filename, `input-${index + 1}`),
      usedFilenames
    );
    const data = Buffer.from(attachment.base64Data, 'base64');
    if (data.length === 0 || data.length > 20 * 1024 * 1024) {
      throw new Error(`文件“${filename}”必须小于 20 MB且不能为空`);
    }
    return { attachment, filename, data };
  });
  return Promise.all(
    prepared.map(async ({ attachment, filename, data }) => {
      const memberPaths = await Promise.all(
        members.map(async (member) => {
          const inputDirectory = resolveRunInputDirectory(member.workDir, runId);
          await fs.mkdir(inputDirectory, { recursive: true });
          const targetPath = path.resolve(inputDirectory, filename);
          if (!targetPath.startsWith(`${inputDirectory}${path.sep}`)) {
            throw new Error('协作任务输入文件超出任务目录范围');
          }
          await fs.writeFile(targetPath, data, { mode: 0o600 });
          return [member.teamSlug, targetPath] as const;
        })
      );
      return {
        filename,
        mimeType: attachment.mimeType,
        size: data.length,
        pathsByMember: Object.fromEntries(memberPaths),
      };
    })
  );
}

function inputFilesForMember(run: CollaborationRun, memberTeamSlug: string): string {
  return (run.inputFiles ?? [])
    .map((file) => {
      const filePath = file.pathsByMember[memberTeamSlug];
      return filePath ? `- ${file.filename}: ${filePath}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function memberListForPrompt(members: CollaborationMemberSnapshot[]): string {
  return members
    .map((member) => {
      const description = member.description ? `：${member.description}` : '';
      return `- ${member.displayName}（teamSlug: ${member.teamSlug}）${description}`;
    })
    .join('\n');
}

/** 结果过短或疑似错误文本时告警（不阻断，仅提示可能混入了错误消息） */
function warnSuspiciousWorkResult(
  item: Pick<CollaborationWorkItem, 'title'>,
  result: string
): void {
  const trimmed = result.trim();
  const looksLikeError = /错误|失败|异常|无法|error|failed/i.test(trimmed);
  if (trimmed.length < 200 || (looksLikeError && trimmed.length < 500)) {
    console.warn(
      `[collaboration] 工作项「${item.title}」结果可疑（${trimmed.length} 字符${looksLikeError ? '，疑似错误文本' : ''}）：${trimmed.slice(0, 120)}`
    );
  }
}

export class CollaborationOrchestrator {
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly running = new Set<string>();
  private readonly responseTimeoutMs: number;
  private readonly handleDirectCliEvent = (event: DirectCliEvent): void => {
    if (event.kind === 'complete') {
      const pending = this.pendingResponses.get(event.messageId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(event.messageId);
      pending.resolve(event.text);
      return;
    }
    if (event.kind !== 'error') return;
    for (const [messageId, pending] of this.pendingResponses) {
      if (pending.sessionKey !== event.sessionKey) continue;
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(messageId);
      pending.reject(new Error(event.error));
    }
  };

  constructor(private readonly dependencies: CollaborationOrchestratorDependencies) {
    this.responseTimeoutMs = dependencies.responseTimeoutMs ?? 10 * 60_000;
    dependencies.directCli.on('event', this.handleDirectCliEvent);
  }

  dispose(): void {
    this.dependencies.directCli.off('event', this.handleDirectCliEvent);
    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('协作服务已停止'));
    }
    this.pendingResponses.clear();
  }

  private notify(runId: string): void {
    this.dependencies.broadcastRunChange?.(runId);
  }

  private async updateRun(
    runId: string,
    update: (current: CollaborationRun) => CollaborationRun
  ): Promise<CollaborationRun> {
    const run = await this.dependencies.workspace.updateRun(runId, (current) => ({
      ...update(current),
      updatedAt: new Date().toISOString(),
    }));
    this.notify(runId);
    return run;
  }

  async createRun(
    collaborationTeamSlug: string,
    request: CreateCollaborationRunRequest
  ): Promise<CollaborationRun> {
    const team = await this.dependencies.workspace.readTeam(collaborationTeamSlug);
    // 成员缺失/已删除不再硬报错：跳过并记录，剩余成员不足 2 人才判小队不可用
    const skippedMembers: { teamSlug: string; reason: string }[] = [];
    const members: CollaborationMemberSnapshot[] = [];
    for (const teamSlug of team.memberTeamSlugs) {
      let manifest;
      try {
        manifest = await this.dependencies.teams.readTeamManifest(teamSlug);
      } catch {
        skippedMembers.push({ teamSlug, reason: '团队已不存在' });
        continue;
      }
      if (manifest.deletedAt) {
        skippedMembers.push({ teamSlug, reason: `数字员工 ${manifest.displayName} 已删除` });
        continue;
      }
      if (!['claudecode', 'codex', 'pi'].includes(manifest.harness)) {
        skippedMembers.push({
          teamSlug,
          reason: `数字员工 ${manifest.displayName} 的运行方式暂不支持圆桌协作`,
        });
        continue;
      }
      if (!manifest.workDir.trim()) {
        skippedMembers.push({ teamSlug, reason: `数字员工 ${manifest.displayName} 没有工作目录` });
        continue;
      }
      members.push({
        teamSlug: manifest.slug,
        displayName: manifest.displayName,
        description: manifest.description,
        harness: manifest.harness,
        workDir: manifest.workDir,
      });
    }
    if (members.length < 2) {
      throw new Error(
        `小队「${team.displayName}」当前不可用：有效成员不足 2 人（${skippedMembers.map((m) => m.reason).join('；') || '请检查成员状态'}）`
      );
    }
    if (skippedMembers.length > 0) {
      console.warn(
        `[collaboration] 小队「${team.displayName}」有 ${skippedMembers.length} 名成员被跳过：${skippedMembers.map((m) => `${m.teamSlug}(${m.reason})`).join('、')}`
      );
    }
    const now = new Date().toISOString();
    const runId = `cr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const inputFiles = await materializeRunInputs(runId, members, request.attachments);
    const run: CollaborationRun = {
      schemaVersion: 1,
      id: runId,
      collaborationTeamSlug: team.slug,
      collaborationTeamDisplayName: team.displayName,
      title: request.title.trim(),
      description: request.description?.trim() || undefined,
      phase: 'roundtable',
      members,
      inputFiles: inputFiles.length > 0 ? inputFiles : undefined,
      ballots: [],
      workItems: [],
      createdAt: now,
      updatedAt: now,
    };
    if (!run.title) throw new Error('任务标题不能为空');
    await this.dependencies.workspace.createRun(run);
    this.notify(run.id);
    this.start(run.id);
    return run;
  }

  start(runId: string): void {
    if (this.running.has(runId)) return;
    this.running.add(runId);
    void this.advance(runId)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.updateRun(runId, (run) => ({ ...run, phase: 'failed', error: message }));
      })
      .finally(() => this.running.delete(runId));
  }

  async requestChanges(
    runId: string,
    feedback: string,
    beforeStart?: (run: CollaborationRun) => Promise<void>
  ): Promise<CollaborationRun> {
    const current = await this.dependencies.workspace.readRun(runId);
    if (current.phase !== 'review') throw new Error('当前小队任务不在待审核阶段');
    const revisionFeedback = feedback.trim();
    if (!revisionFeedback) throw new Error('请填写需要修改的内容');
    const updated = await this.updateRun(runId, (run) => ({
      ...run,
      phase: 'executing',
      finalResult: undefined,
      revisionFeedback,
      revisionNumber: (run.revisionNumber ?? 0) + 1,
      error: undefined,
      workItems: run.workItems.map((item) => ({
        ...item,
        status: 'pending',
        result: undefined,
        error: undefined,
        updatedAt: new Date().toISOString(),
      })),
    }));
    try {
      await beforeStart?.(updated);
    } catch (error) {
      await this.updateRun(runId, () => current);
      throw error;
    }
    this.start(runId);
    return updated;
  }

  async recoverInterruptedRuns(): Promise<string[]> {
    const teams = await this.dependencies.workspace.listTeams();
    const runs = (
      await Promise.all(teams.map((team) => this.dependencies.workspace.listRuns(team.slug)))
    ).flat();
    const reviewDeliveryMessageId = (teamSlug: string, taskId: string, version: number): string =>
      `m_deliver_${teamSlug}_${taskId}_${version}`;
    await Promise.allSettled(
      runs
        .filter(
          (run) =>
            run.phase === 'review' && Boolean(run.rootTaskId) && Boolean(run.rootTaskTeamSlug)
        )
        .map(async (run) => {
          const teamSlug = run.rootTaskTeamSlug ?? '';
          const tasks = await this.dependencies.teams.readTasks(teamSlug);
          const rootTask = tasks.find((task) => task.id === run.rootTaskId);
          if (rootTask && getReviewStateFromTask(rootTask as never) === 'approved') {
            await this.updateRun(run.id, (current) => ({
              ...current,
              phase: 'completed',
              error: undefined,
            }));
            return;
          }
          // 评审沟通统一走消息线程：交付消息缺失时按确定性 id 幂等补写
          const latestDelivery = rootTask?.deliveries?.at(-1);
          if (!rootTask || !latestDelivery) return;
          const messageId = reviewDeliveryMessageId(teamSlug, rootTask.id, latestDelivery.version);
          const messages = await this.dependencies.teams.readMessages(teamSlug, { limit: 5000 });
          if (messages.some((message) => message.id === messageId)) return;
          await this.dependencies.teams.appendMessage(teamSlug, {
            ...buildDeliveryThreadMessage(teamSlug, rootTask, latestDelivery),
            id: messageId,
          });
        })
    );
    const interrupted = runs.filter(
      (run) => run.phase !== 'review' && run.phase !== 'completed' && run.phase !== 'failed'
    );
    await Promise.all(
      interrupted.map((run) =>
        this.updateRun(run.id, (current) => ({
          ...current,
          error: undefined,
          workItems: current.workItems.map((item) =>
            item.status === 'running'
              ? {
                  ...item,
                  status: 'pending',
                  error: undefined,
                  updatedAt: new Date().toISOString(),
                }
              : item
          ),
        }))
      )
    );
    for (const run of interrupted) this.start(run.id);
    return interrupted.map((run) => run.id);
  }

  private async requestAgent(
    run: CollaborationRun,
    member: CollaborationMemberSnapshot,
    stage: string,
    prompt: string
  ): Promise<string> {
    const messageId = `collab-${run.id}-${stage}-${member.teamSlug}-${Date.now()}`;
    const sessionKey = `collab:${run.id}:${stage}:${member.teamSlug}`;
    const response = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(messageId);
        this.dependencies.directCli.kill?.(sessionKey);
        reject(new Error(`${member.displayName} 响应超时`));
      }, this.responseTimeoutMs);
      this.pendingResponses.set(messageId, { sessionKey, resolve, reject, timeout });
    });
    try {
      if (this.dependencies.dispatchAgentMessage) {
        await this.dependencies.dispatchAgentMessage({
          teamName: member.teamSlug,
          sessionKey,
          workDir: member.workDir,
          from: member.displayName,
          to: 'user',
          text: prompt,
          messageId,
          conversationId: `collaboration:${run.id}`,
        });
      } else {
        await this.dependencies.directCli.send(sessionKey, {
          text: prompt,
          messageId,
          workDir: member.workDir,
          teamSlug: member.teamSlug,
          workbenchUrl: this.dependencies.workbenchUrl,
        });
      }
    } catch (error) {
      const pending = this.pendingResponses.get(messageId);
      if (pending) clearTimeout(pending.timeout);
      this.pendingResponses.delete(messageId);
      throw error;
    }
    return response;
  }

  private buildBallotPrompt(run: CollaborationRun, member: CollaborationMemberSnapshot): string {
    const inputFiles = inputFilesForMember(run, member.teamSlug);
    return [
      '你正在参加一次数字员工团队的开工圆桌。不要使用任何工具，只需根据任务和成员资料做出一次正式发言。',
      `团队：${run.collaborationTeamDisplayName}`,
      `任务：${run.title}`,
      run.description ? `补充说明：${run.description}` : null,
      '',
      `你的身份：${member.displayName}（teamSlug: ${member.teamSlug}）`,
      inputFiles ? `用户提供的任务输入文件：\n${inputFiles}` : null,
      '团队成员：',
      memberListForPrompt(run.members),
      '',
      '请提名一名本任务队长，并说明你建议自己承担的工作。可以提名自己，也可以提名别人。',
      '只返回下面格式的 JSON，不要输出 Markdown 代码块或其他文字：',
      '{"nomineeTeamSlug":"候选人的 teamSlug","statement":"你对任务和协作方式的简短判断","suggestedContribution":"你建议自己承担的具体工作"}',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  private buildPlanPrompt(run: CollaborationRun, captain: CollaborationMemberSnapshot): string {
    const inputFiles = inputFilesForMember(run, captain.teamSlug);
    const ballotSummary = run.ballots
      .map(
        (ballot) =>
          `- ${ballot.memberDisplayName} 提名 ${ballot.nomineeTeamSlug}；建议承担：${ballot.suggestedContribution}；意见：${ballot.statement}`
      )
      .join('\n');
    return [
      '你已被团队选为本任务队长。不要使用任何工具。请根据圆桌发言制定可执行分工。',
      `任务：${run.title}`,
      run.description ? `补充说明：${run.description}` : null,
      inputFiles ? `用户提供的任务输入文件：\n${inputFiles}` : null,
      '',
      '团队成员：',
      memberListForPrompt(run.members),
      '',
      '圆桌发言：',
      ballotSummary,
      '',
      '要求：',
      '- 创建 1 到 4 个可并行或有明确边界的工作项。',
      '- 至少把一个工作项交给其他成员，不能由队长包办。',
      '- assigneeTeamSlug 必须来自团队成员列表。',
      '- 工作项应该产出可直接用于最终交付的内容。',
      '- 队长稍后会获得所有工作项结果并统一整合。',
      '',
      '只返回下面格式的 JSON，不要输出其他文字：',
      '{"summary":"分工思路","workItems":[{"title":"工作项标题","description":"明确任务边界和要求","assigneeTeamSlug":"成员 teamSlug","expectedOutput":"预期交付形式"}]}',
      `当前队长：${captain.displayName}（${captain.teamSlug}）`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  private buildWorkPrompt(
    run: CollaborationRun,
    item: CollaborationWorkItem,
    member: CollaborationMemberSnapshot
  ): string {
    const inputFiles = inputFilesForMember(run, member.teamSlug);
    return [
      `你正在代表数字员工 ${member.displayName} 执行团队分配的工作项。`,
      `总任务：${run.title}`,
      run.description ? `总任务说明：${run.description}` : null,
      `你的工作项：${item.title}`,
      `具体要求：${item.description}`,
      `预期交付：${item.expectedOutput}`,
      run.revisionFeedback
        ? `用户对上一版交付的修改意见：${run.revisionFeedback}\n请基于该意见重新检查并改进你的工作项。`
        : null,
      inputFiles ? `用户提供的任务输入文件：\n${inputFiles}\n请先读取这些文件。` : null,
      '',
      '请独立完成这项工作。可以使用必要工具查资料、分析或生成文件。',
      '最终回复必须是可以直接交给队长整合的完整 Markdown 成果，不要只汇报“已完成”，也不要要求队长重复你的工作。',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  private buildIntegrationPrompt(run: CollaborationRun): string {
    const captainInputFiles = run.captainTeamSlug
      ? inputFilesForMember(run, run.captainTeamSlug)
      : '';
    const results = run.workItems
      .map(
        (item, index) =>
          `## 工作项 ${index + 1}：${item.title}\n执行人：${item.assigneeDisplayName}\n\n${item.result ?? '未提交结果'}`
      )
      .join('\n\n---\n\n');
    return [
      '你是本任务队长。下面是团队成员已经完成的全部工作成果。',
      `用户任务：${run.title}`,
      run.description ? `用户补充说明：${run.description}` : null,
      run.revisionFeedback
        ? `用户对上一版交付的修改意见：${run.revisionFeedback}\n本次必须逐项回应并修正。`
        : null,
      captainInputFiles ? `用户提供的任务输入文件：\n${captainInputFiles}` : null,
      '',
      results,
      '',
      '请统一检查、去重、补齐结构并形成最终可直接交付给用户的 Markdown 成果。',
      '不要描述团队内部流程，不要只给摘要，不要输出 JSON。最终回复就是正式交付物。',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  private async advance(runId: string): Promise<void> {
    let run = await this.dependencies.workspace.readRun(runId);
    if (run.phase === 'review' || run.phase === 'completed') return;

    if (run.ballots.length < run.members.length) {
      run = await this.updateRun(runId, (current) => ({
        ...current,
        phase: 'roundtable',
        error: undefined,
      }));
      const completedMembers = new Set(run.ballots.map((ballot) => ballot.memberTeamSlug));
      const validMemberSlugs = new Set(run.members.map((member) => member.teamSlug));
      const ballotResults = await Promise.all(
        run.members
          .filter((member) => !completedMembers.has(member.teamSlug))
          .map(async (member) => {
            const response = await this.requestAgent(
              run,
              member,
              'roundtable',
              this.buildBallotPrompt(run, member)
            );
            const payload = parseBallot(response, validMemberSlugs);
            return {
              memberTeamSlug: member.teamSlug,
              memberDisplayName: member.displayName,
              nomineeTeamSlug: payload.nomineeTeamSlug,
              statement: payload.statement,
              suggestedContribution: payload.suggestedContribution,
              receivedAt: new Date().toISOString(),
            } satisfies RoundtableBallot;
          })
      );
      run = await this.updateRun(runId, (current) => ({
        ...current,
        ballots: [...current.ballots, ...ballotResults],
        phase: 'electing',
      }));
    }

    if (!run.captainTeamSlug) {
      const captain = electCaptain(run.members, run.ballots);
      run = await this.updateRun(runId, (current) => ({
        ...current,
        captainTeamSlug: captain.teamSlug,
        captainDisplayName: captain.displayName,
        phase: 'planning',
      }));
    }

    const captain = run.members.find((member) => member.teamSlug === run.captainTeamSlug);
    if (!captain) throw new Error('当选队长不在团队成员列表中');

    if (!run.rootTaskId) {
      const rootTask = await this.dependencies.teams.createTask(captain.teamSlug, {
        title: run.title,
        description: run.description,
        assignee: captain.displayName,
        assigneeAgentId: captain.teamSlug,
        collaborationRunId: run.id,
        taskKind: 'root',
        status: 'doing',
        createdBy: 'user',
      });
      run = await this.updateRun(runId, (current) => ({
        ...current,
        rootTaskId: rootTask.id,
        rootTaskTeamSlug: captain.teamSlug,
      }));
    }

    if (run.workItems.length === 0) {
      const planResponse = await this.requestAgent(
        run,
        captain,
        'planning',
        this.buildPlanPrompt(run, captain)
      );
      const plan = parsePlan(planResponse, run.members, captain.teamSlug);
      const now = new Date().toISOString();
      const workItems: CollaborationWorkItem[] = [];
      for (const planned of plan.workItems) {
        const assignee = run.members.find((member) => member.teamSlug === planned.assigneeTeamSlug);
        if (!assignee || !run.rootTaskId || !run.rootTaskTeamSlug) continue;
        const task = await this.dependencies.teams.createTask(run.rootTaskTeamSlug, {
          title: planned.title,
          description: planned.description,
          assignee: assignee.displayName,
          assigneeAgentId: assignee.teamSlug,
          parentTaskId: run.rootTaskId,
          collaborationRunId: run.id,
          taskKind: 'subtask',
          status: 'todo',
          createdBy: captain.teamSlug,
        });
        workItems.push({
          id: `wi_${randomUUID().slice(0, 8)}`,
          title: planned.title,
          description: planned.description,
          assigneeTeamSlug: assignee.teamSlug,
          assigneeDisplayName: assignee.displayName,
          expectedOutput: planned.expectedOutput,
          taskId: task.id,
          status: 'pending',
          updatedAt: now,
        });
      }
      if (workItems.length === 0) throw new Error('队长分工没有产生有效工作项');
      run = await this.updateRun(runId, (current) => ({
        ...current,
        workItems,
        phase: 'executing',
      }));
    }

    // 空结果视同未完成（completed 但无内容的项也要返工，修复历史卡死 run 的 retry 路径）
    const incompleteItems = run.workItems.filter(
      (item) => item.status !== 'completed' || !item.result?.trim()
    );
    if (incompleteItems.length > 0) {
      await Promise.all(
        incompleteItems.map(async (item) => {
          const assignee = run.members.find((member) => member.teamSlug === item.assigneeTeamSlug);
          if (!assignee || !item.taskId || !run.rootTaskTeamSlug) {
            throw new Error(`工作项 ${item.title} 缺少有效执行人或任务`);
          }
          await this.updateRun(runId, (current) => ({
            ...current,
            phase: 'executing',
            workItems: current.workItems.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    status: 'running',
                    result: candidate.result?.trim() ? candidate.result : undefined,
                    error: undefined,
                    updatedAt: new Date().toISOString(),
                  }
                : candidate
            ),
          }));
          await this.dependencies.teams.patchTask(run.rootTaskTeamSlug, item.taskId, {
            status: 'doing',
          });
          try {
            const result = await this.requestAgent(
              run,
              assignee,
              `work-${item.id}`,
              this.buildWorkPrompt(run, item, assignee)
            );
            if (!result.trim()) throw new Error('未产出内容');
            warnSuspiciousWorkResult(item, result);
            // 工作项成果记录为一条交付成果（delivery），不再写单一的 result 字段
            await this.dependencies.teams.addDelivery(run.rootTaskTeamSlug, item.taskId, {
              result,
            });
            await this.dependencies.teams.patchTask(run.rootTaskTeamSlug, item.taskId, {
              status: 'done',
            });
            await this.updateRun(runId, (current) => ({
              ...current,
              workItems: current.workItems.map((candidate) =>
                candidate.id === item.id
                  ? {
                      ...candidate,
                      status: 'completed',
                      result,
                      error: undefined,
                      updatedAt: new Date().toISOString(),
                    }
                  : candidate
              ),
            }));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.dependencies.teams.patchTask(run.rootTaskTeamSlug, item.taskId, {
              status: 'todo',
            });
            await this.updateRun(runId, (current) => ({
              ...current,
              workItems: current.workItems.map((candidate) =>
                candidate.id === item.id
                  ? {
                      ...candidate,
                      status: 'failed',
                      result: undefined,
                      error: message,
                      updatedAt: new Date().toISOString(),
                    }
                  : candidate
              ),
            }));
            throw error;
          }
          return item.id;
        })
      );
      run = await this.updateRun(runId, (current) => ({ ...current, phase: 'integrating' }));
    }

    run = await this.dependencies.workspace.readRun(runId);
    const missingResultItems = run.workItems.filter(
      (item) => item.status !== 'completed' || !item.result?.trim()
    );
    if (missingResultItems.length > 0) {
      const listing = missingResultItems.map((item) => item.title).join('、');
      throw new Error(`以下工作项缺少有效结果，不能开始队长整合：${listing}`);
    }
    if (!run.rootTaskId || !run.rootTaskTeamSlug) throw new Error('协作总任务不存在');

    const finalResult = await this.requestAgent(
      run,
      captain,
      'integration',
      this.buildIntegrationPrompt(run)
    );
    const existingRootTask = (await this.dependencies.teams.readTasks(run.rootTaskTeamSlug)).find(
      (task) => task.id === run.rootTaskId
    );
    // 最终成果记录为一条交付成果（delivery），不再写单一的 result 字段
    const { delivery } = await this.dependencies.teams.addDelivery(
      run.rootTaskTeamSlug,
      run.rootTaskId,
      {
        result: finalResult,
      }
    );
    await this.dependencies.teams.patchTask(run.rootTaskTeamSlug, run.rootTaskId, {
      status: 'done',
      reviewState: 'review',
    });
    // 评审状态以 historyEvents 为单一事实源：交付必须落 review_requested 事件，
    // 否则派生状态（getReviewStateFromTask 优先 events）与字段不一致、评审入口不出现
    await this.dependencies.teams.appendTaskHistoryEvent(run.rootTaskTeamSlug, run.rootTaskId, {
      id: historyEventId(),
      type: 'review_requested',
      from: existingRootTask?.reviewState ?? 'none',
      to: 'review',
      timestamp: new Date().toISOString(),
      actor: 'agent',
    });
    // 评审沟通统一走消息线程：交付邮件写入 task:<taskId> 线程（确定性 id 幂等）
    await this.dependencies.teams.appendMessage(run.rootTaskTeamSlug, {
      ...buildDeliveryThreadMessage(
        run.rootTaskTeamSlug,
        existingRootTask ?? { id: run.rootTaskId, assignee: captain.displayName },
        delivery
      ),
      id: `m_deliver_${run.rootTaskTeamSlug}_${run.rootTaskId}_${delivery.version}`,
    });
    await this.updateRun(runId, (current) => ({
      ...current,
      phase: 'review',
      finalResult,
      error: undefined,
    }));
  }
}
