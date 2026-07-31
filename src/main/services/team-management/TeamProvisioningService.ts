/**
 * TeamProvisioningService — 团队生命周期管理，组合 cc-connect 调用。
 *
 * 设计（v2）:
 *   - 一个 Team = 一个 cc-connect project
 *   - createTeam(): 本地建目录 + cc-connect 创建 project + 注入 CLAUDE.md 指令
 *   - dispatchTask(): assignee 变化时通过 Bridge 推消息给目标团队的 agent
 */

import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildHermitOpsRunbookContext } from './OpsRunbookContext';
import {
  type CreateTeamInput,
  groupSessionKey,
  type Task,
  type TeamManifest,
  TeamWorkspaceService,
} from './TeamWorkspaceService';

import type { HermitBridgeClient } from '../hermitBridge/HermitBridgeClient';
import type { HermitBridgeConnection } from '../hermitBridge/HermitBridgeConnection';
import type { DiscoverableTeam } from '@shared/types/team';

const logger = createLogger('TeamProvisioningService');
const TEAM_INSTRUCTIONS_BEGIN = '<!-- hermit:team-collaboration:start -->';
const TEAM_INSTRUCTIONS_END = '<!-- hermit:team-collaboration:end -->';

function removeSectionByHeading(content: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(
    new RegExp(`\\n{0,2}## ${escapedHeading}\\n[\\s\\S]*?(?=\\n## |\\s*$)`, 'g'),
    ''
  );
}

function removeManagedTeamInstructions(content: string): string {
  let next = content.replace(
    new RegExp(`\\n{0,2}${TEAM_INSTRUCTIONS_BEGIN}[\\s\\S]*?${TEAM_INSTRUCTIONS_END}\\n?`, 'g'),
    '\n'
  );
  next = removeSectionByHeading(next, 'Agent Collaboration (Hermit)');
  next = removeSectionByHeading(next, 'Cross-Team Task Dispatch (Hermit)');
  return next.replace(/\n{3,}/g, '\n\n').trimEnd();
}

async function removeLegacyHermitTasksMcpConfig(workDir: string): Promise<void> {
  const settingsPath = path.join(workDir, '.claude', 'settings.json');
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn(
      `Legacy Hermit task MCP cleanup skipped (${settingsPath}): ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object') return;
  const mcpServers = { ...(settings.mcpServers as Record<string, unknown>) };
  if (!Object.hasOwn(mcpServers, 'hermit-tasks')) return;
  delete mcpServers['hermit-tasks'];
  if (Object.keys(mcpServers).length > 0) settings.mcpServers = mcpServers;
  else delete settings.mcpServers;
  await fs.promises.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function instructionPathForHarness(workDir: string, harness: string): string {
  if (harness === 'codex' || harness === 'opencode' || harness === 'pi') {
    return path.join(workDir, 'AGENTS.md');
  }
  if (harness === 'gemini') return path.join(workDir, 'GEMINI.md');
  if (harness === 'cursor') {
    return path.join(workDir, '.cursor', 'rules', 'hermit-team-collaboration.mdc');
  }
  return path.join(workDir, 'CLAUDE.md');
}

export class TeamProvisioningService {
  private readonly workspace: TeamWorkspaceService;

  constructor(
    private readonly cc: HermitBridgeClient,
    private readonly bridge: HermitBridgeConnection,
    workspace?: TeamWorkspaceService,
    private readonly hooks: { restartCcConnect?: () => Promise<void> } = {}
  ) {
    this.workspace = workspace ?? new TeamWorkspaceService();
  }

  // ===========================================================================
  // Team CRUD
  // ===========================================================================

  /**
   * 创建团队：
   * 1. 本地建目录 + team.json
   * 2. 在 cc-connect 创建 project（bridge platform）
   * 3. 注入 CLAUDE.md 团队上下文指令
   * 4. 触发 cc-connect restart 激活 project
   */
  async createTeam(
    input: CreateTeamInput & { createCcProject?: boolean; injectInstructions?: boolean }
  ): Promise<{ slug: string; manifest: TeamManifest }> {
    const { createCcProject = true, injectInstructions = true, ...workspaceInput } = input;

    const { slug, manifest } = await this.workspace.createTeam(workspaceInput);

    if (injectInstructions) {
      if (manifest.harness === 'claudecode') {
        await removeLegacyHermitTasksMcpConfig(manifest.workDir);
      }
      await this.injectTeamInstructions(manifest.workDir, manifest.slug, manifest.harness);
    }

    if (createCcProject) {
      try {
        const platformType = manifest.platform ?? 'bridge';
        const platformOpts = manifest.platformOptions ?? {};
        const result = await this.cc.createProject(
          manifest.bindProject,
          manifest.harness,
          manifest.workDir,
          platformType,
          platformOpts
        );
        if (result.restart_required) {
          if (this.hooks.restartCcConnect) {
            await this.hooks.restartCcConnect();
          } else {
            await this.cc.restart();
          }
          logger.info(`cc-connect restarted after creating project ${manifest.bindProject}`);
        }
      } catch (err) {
        logger.warn(
          `cc-connect project creation failed (team=${slug}): ${err instanceof Error ? err.message : String(err)}`
        );
        // 不中断流程 — project 可能已存在
      }
    }

    return { slug, manifest };
  }

  async listTeams(): Promise<TeamManifest[]> {
    return this.workspace.listTeams();
  }

  async discoverTeams(): Promise<DiscoverableTeam[]> {
    return this.workspace.discoverTeams();
  }

  async readTeamManifest(teamSlug: string): Promise<TeamManifest> {
    return this.workspace.readTeamManifest(teamSlug);
  }

  async readTeamManifestByProject(projectName: string): Promise<TeamManifest> {
    return this.workspace.readTeamManifestByProject(projectName);
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
    return this.workspace.updateTeam(teamSlug, patch);
  }

  async deleteTeam(teamSlug: string, opts: { deleteFiles?: boolean } = {}): Promise<void> {
    return this.workspace.deleteTeam(teamSlug, opts);
  }

  async restoreTeam(teamSlug: string): Promise<void> {
    return this.workspace.restoreTeam(teamSlug);
  }

  // ===========================================================================
  // Task Dispatcher
  // ===========================================================================

  /**
   * 任务调度：当任务有 assignee 时，通过 Bridge 推送通知给目标团队的 agent。
   * 目标团队通过 AgentCLI 任务总线认领、评论、澄清并提交任务。
   */
  async dispatchTask(sourceTeamSlug: string, task: Task): Promise<void> {
    if (!task.assignee) return;

    const targetSlug = task.assigneeAgentId?.trim() || task.assignee;

    // 检查来源团队协同开关（本地 manifest 可选）
    try {
      const sourceManifest = await this.workspace.readTeamManifest(sourceTeamSlug);
      if (sourceManifest.collaboration === false) {
        logger.info(`dispatchTask: source team "${sourceTeamSlug}" collaboration=false, skipping`);
        return;
      }
    } catch {
      // no local manifest — treat as collaboration=true
    }

    // 检查目标团队协同开关（目标团队必须存在）
    let targetManifest: TeamManifest;
    try {
      targetManifest = await this.workspace.readTeamManifest(targetSlug);
    } catch {
      logger.info(`dispatchTask: target team "${targetSlug}" not found, skipping`);
      return;
    }
    if (targetManifest.collaboration === false) {
      logger.info(`dispatchTask: target team "${targetSlug}" collaboration=false, skipping`);
      return;
    }

    // session key for bridge dispatch — cc-connect will apply share_session_in_channel natively
    const sessionKey = groupSessionKey(targetSlug);
    const hermitHome = process.env.HERMIT_HOME ?? path.join(os.homedir(), '.hermit');
    const cliEntry = path.join(
      hermitHome,
      'bin',
      process.platform === 'win32' ? 'agentcli.cmd' : 'agentcli'
    );
    const cli = `${JSON.stringify(cliEntry)} --port ${process.env.PORT ?? '5680'} tasks`;
    const message = [
      `[任务分配] 来自团队 ${sourceTeamSlug}`,
      `任务 ID: ${task.id}`,
      `标题: ${task.title}`,
      task.description ? `描述: ${task.description}` : null,
      ``,
      `请通过 AgentCLI 任务总线处理，不要使用 MCP、Skills 或运行时自带任务系统：`,
      `  ${cli} claim --team ${targetSlug} --id ${task.id}`,
      `  ${cli} comment --team ${targetSlug} --id ${task.id} --text "进度说明"`,
      `  ${cli} clarify --team ${targetSlug} --id ${task.id} --target user`,
      `  ${cli} complete --team ${targetSlug} --id ${task.id} --result "交付结果"`,
    ]
      .filter((l) => l !== null)
      .join('\n');

    try {
      this.bridge.sendUserMessage({
        sessionKey,
        userId: 'hermit',
        userName: `hermit[${sourceTeamSlug}]`,
        content: message,
        project: targetManifest.bindProject,
        chatId: targetSlug,
      });
      logger.info(
        `dispatched task ${task.id} → team:${targetSlug} (cc-project:${targetManifest.bindProject})`
      );
    } catch (err) {
      logger.warn(
        `dispatchTask failed (target=${targetSlug}): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 记录消息到来源团队
    await this.workspace.appendMessage(sourceTeamSlug, {
      from: 'hermit',
      to: targetSlug,
      role: 'system',
      content: `任务 ${task.id} 已分配给团队 ${targetSlug}`,
    });
  }

  // ===========================================================================
  // Tasks (passthrough to workspace)
  // ===========================================================================

  readTasks(teamSlug: string) {
    return this.workspace.readTasks(teamSlug);
  }

  createTask(teamSlug: string, payload: Parameters<TeamWorkspaceService['createTask']>[1]) {
    return this.workspace.createTask(teamSlug, payload);
  }

  patchTask(
    teamSlug: string,
    taskId: string,
    patch: Parameters<TeamWorkspaceService['patchTask']>[2]
  ) {
    return this.workspace.patchTask(teamSlug, taskId, patch);
  }

  deleteTask(teamSlug: string, taskId: string) {
    return this.workspace.deleteTask(teamSlug, taskId);
  }

  // ===========================================================================
  // Session archive (passthrough to workspace)
  // ===========================================================================

  readHiddenSessionIds(teamSlug: string) {
    return this.workspace.readHiddenSessionIds(teamSlug);
  }

  hideSession(teamSlug: string, sessionId: string) {
    return this.workspace.hideSession(teamSlug, sessionId);
  }

  // ===========================================================================
  // Messages (passthrough to workspace)
  // ===========================================================================

  readMessages(teamSlug: string, opts?: { limit?: number }) {
    return this.workspace.readMessages(teamSlug, opts);
  }

  appendMessage(teamSlug: string, msg: Parameters<TeamWorkspaceService['appendMessage']>[1]) {
    return this.workspace.appendMessage(teamSlug, msg);
  }

  // ===========================================================================
  // CLAUDE.md instruction injection
  // ===========================================================================

  async injectTeamInstructions(
    workDir: string,
    teamSlug: string,
    harness = 'claudecode'
  ): Promise<void> {
    const mdPath = instructionPathForHarness(workDir, harness);
    const teams = await this.workspace.listTeams().catch(() => []);
    const availableTeams = teams
      .filter((team) => team.slug !== teamSlug)
      .map((team) => {
        const label =
          team.displayName && team.displayName !== team.slug
            ? `${team.slug} (${team.displayName})`
            : team.slug;
        return team.description ? `- ${label}: ${team.description}` : `- ${label}`;
      });
    const opsRunbookContext = buildHermitOpsRunbookContext();
    const section = `

${TEAM_INSTRUCTIONS_BEGIN}

## AgentCLI Team Context

Current team slug: \`${teamSlug}\`

Available teams:
${availableTeams.length > 0 ? availableTeams.join('\n') : '- No other teams currently registered.'}

Cross-team collaboration is handled through AgentCLI's task bus. AgentCLI task state is the single source of truth.
Do not use MCP, Skills, or the harness's native task/todo tools for collaborative task management.

Use these commands for collaborative tasks:
- List visible tasks: \`agentcli --port ${process.env.PORT ?? '5680'} tasks list --team ${teamSlug}\`
- Claim a task before work: \`agentcli --port ${process.env.PORT ?? '5680'} tasks claim --team ${teamSlug} --id <task-id>\`
- Post progress: \`agentcli --port ${process.env.PORT ?? '5680'} tasks comment --team ${teamSlug} --id <task-id> --text "<progress>"\`
- Request clarification: \`agentcli --port ${process.env.PORT ?? '5680'} tasks clarify --team ${teamSlug} --id <task-id> --target user\`
- Submit the result: \`agentcli --port ${process.env.PORT ?? '5680'} tasks complete --team ${teamSlug} --id <task-id> --result "<result>"\`

Do not call cross-team dispatch APIs yourself and do not invent task IDs. Use only task IDs returned by the CLI or supplied by AgentCLI.

${opsRunbookContext}
${TEAM_INSTRUCTIONS_END}
`;

    try {
      let existing = '';
      try {
        existing = await fs.promises.readFile(mdPath, 'utf8');
      } catch {
        // File doesn't exist yet
      }

      const cleaned = removeManagedTeamInstructions(existing);
      await fs.promises.mkdir(path.dirname(mdPath), { recursive: true });
      await fs.promises.writeFile(mdPath, `${cleaned}${section}`, 'utf8');
      logger.info(`injected team instructions → ${mdPath}`);
    } catch (err) {
      logger.warn(
        `Team instructions injection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async backfillTeamInstructions(): Promise<{ updated: number; failed: number }> {
    const teams = await this.workspace.listTeams();
    let updated = 0;
    let failed = 0;
    for (const team of teams) {
      if (team.deletedAt || team.pendingDelete) continue;
      try {
        if (team.harness === 'claudecode') {
          await removeLegacyHermitTasksMcpConfig(team.workDir);
        }
        await this.injectTeamInstructions(team.workDir, team.slug, team.harness);
        updated += 1;
      } catch (error) {
        failed += 1;
        logger.warn(
          `Team instruction backfill failed (${team.slug}): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return { updated, failed };
  }

  async removeTeamInstructions(workDir: string): Promise<void> {
    const mdPath = path.join(workDir, 'CLAUDE.md');
    try {
      const existing = await fs.promises.readFile(mdPath, 'utf8');
      const cleaned = removeManagedTeamInstructions(existing);
      if (cleaned === existing.trimEnd()) return;
      await fs.promises.writeFile(mdPath, cleaned ? `${cleaned}\n` : '', 'utf8');
      logger.info(`removed team instructions → ${mdPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      logger.warn(
        `Team instructions removal failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
