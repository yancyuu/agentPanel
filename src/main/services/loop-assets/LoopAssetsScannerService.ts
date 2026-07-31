import { execFile } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  LoopAssetAction,
  LoopAssetCategoryKey,
  LoopAssetCategorySnapshot,
  LoopAssetSourceRef,
  LoopAssetsSnapshot,
  LoopAssetStatus,
} from '@shared/types/loopAssets';

const execFileAsync = promisify(execFile);
const MAX_DETAILS = 6;
const MAX_SOURCES = 12;

interface ScanTeamInput {
  teamName: string;
  displayName?: string;
  bindProject?: string;
  workDir: string;
  teamRoot?: string;
  memberCount?: number;
  taskCount?: number;
  messageCount?: number;
  platforms?: { type: string; connected?: boolean }[];
}

interface AssetDraft {
  key: LoopAssetCategoryKey;
  title: string;
  subtitle: string;
  details: string[];
  gap: string;
  sources: LoopAssetSourceRef[];
  actions: LoopAssetAction[];
  warnings?: string[];
  status?: LoopAssetStatus;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function safeReadJson(filePath: string): Promise<{ value?: unknown; warning?: string }> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return { value: JSON.parse(raw) as unknown };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { warning: `${path.basename(filePath)} 读取失败或 JSON 无效` };
  }
}

function compact(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, MAX_DETAILS);
}

function compactSources(items: LoopAssetSourceRef[]): LoopAssetSourceRef[] {
  const seen = new Set<string>();
  const out: LoopAssetSourceRef[] = [];
  for (const item of items) {
    const key = `${item.scope}:${item.kind ?? ''}:${item.path ?? item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

function category(draft: AssetDraft): LoopAssetCategorySnapshot {
  const count = draft.sources.length || draft.details.length;
  const status = draft.status ?? (count > 0 ? 'partial' : 'missing');
  return {
    key: draft.key,
    title: draft.title,
    subtitle: draft.subtitle,
    status,
    count,
    details: compact(draft.details),
    gap: draft.gap,
    sources: compactSources(draft.sources),
    actions: draft.actions,
    warnings: draft.warnings?.length ? compact(draft.warnings) : undefined,
  };
}

function statusFromCount(count: number, readyAt = 1): LoopAssetStatus {
  if (count >= readyAt) return 'ready';
  if (count > 0) return 'partial';
  return 'missing';
}

function userHome(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

function source(
  label: string,
  filePath: string,
  scope: LoopAssetSourceRef['scope'],
  kind: string
): LoopAssetSourceRef {
  return { label, path: filePath, scope, kind };
}

function action(
  id: string,
  label: string,
  kind: LoopAssetAction['kind'],
  target?: string,
  payload?: Record<string, unknown>
): LoopAssetAction {
  return { id, label, kind, target, payload };
}

export class LoopAssetsScannerService {
  async scanTeam(input: ScanTeamInput): Promise<LoopAssetsSnapshot> {
    const warnings: string[] = [];
    const workDir = input.workDir.trim();

    if (!workDir) {
      const categories = this.emptyCategories('项目缺少 workDir，无法扫描文件资产');
      return {
        teamName: input.teamName,
        displayName: input.displayName,
        bindProject: input.bindProject,
        workDir,
        lifecycle: 'unknown',
        healthScore: 0,
        scannedAt: new Date().toISOString(),
        categories,
        warnings: ['项目缺少 workDir'],
      };
    }

    const projectExists = await exists(workDir);
    if (!projectExists) warnings.push('项目目录不存在或不可访问');

    const [automations, worktrees, skills, subagents, state] = await Promise.all([
      this.scanAutomations(workDir),
      this.scanWorktrees(workDir),
      this.scanSkillsAndMcp(workDir),
      this.scanSubagents(workDir, input.memberCount ?? 0),
      this.scanState(workDir, input),
    ]);

    const categories = [automations, worktrees, skills, subagents, state];
    const readyOrPartial = categories.filter(
      (item) => item.status === 'ready' || item.status === 'partial'
    ).length;
    const ready = categories.filter((item) => item.status === 'ready').length;
    const categoryWarnings = categories.reduce(
      (count, item) => count + (item.warnings?.length ?? 0),
      0
    );
    const lifecycle = !projectExists
      ? 'unknown'
      : ready >= 4 && categoryWarnings === 0
        ? 'ready'
        : readyOrPartial >= Math.ceil(categories.length / 2)
          ? 'active'
          : 'missing-assets';

    return {
      teamName: input.teamName,
      displayName: input.displayName,
      bindProject: input.bindProject,
      workDir,
      lifecycle,
      healthScore: Math.round(
        (ready * 100 + (readyOrPartial - ready) * 50) / Math.max(categories.length, 1)
      ),
      scannedAt: new Date().toISOString(),
      categories,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  private emptyCategories(gap: string): LoopAssetCategorySnapshot[] {
    return [
      category({
        key: 'automations',
        title: 'Automations',
        subtitle: '心跳与自动执行',
        details: [],
        gap,
        sources: [],
        actions: this.automationActions(),
      }),
      category({
        key: 'worktrees',
        title: 'Worktrees',
        subtitle: '并行隔离工作区',
        details: [],
        gap,
        sources: [],
        actions: this.worktreeActions(),
      }),
      category({
        key: 'skills',
        title: 'Skills/MCP',
        subtitle: '可复用知识与工具连接',
        details: [],
        gap,
        sources: [],
        actions: this.skillActions(),
      }),
      category({
        key: 'subagents',
        title: 'Sub-agents',
        subtitle: '角色化分工验证',
        details: [],
        gap,
        sources: [],
        actions: this.subagentActions(),
      }),
      category({
        key: 'state',
        title: 'State',
        subtitle: '跨运行记忆与恢复',
        details: [],
        gap,
        sources: [],
        actions: this.stateActions(),
      }),
    ];
  }

  private async scanAutomations(workDir: string): Promise<LoopAssetCategorySnapshot> {
    const details: string[] = [];
    const sources: LoopAssetSourceRef[] = [];
    const warnings: string[] = [];

    const workflowDir = path.join(workDir, '.github', 'workflows');
    const workflows = (await safeReadDir(workflowDir)).filter((name) => /\.ya?ml$/i.test(name));
    if (workflows.length) {
      details.push(`${workflows.length} GitHub Actions`);
      workflows
        .slice(0, 4)
        .forEach((name) =>
          sources.push(source(name, path.join(workflowDir, name), 'project', 'github-action'))
        );
    }

    const commandsDir = path.join(workDir, '.claude', 'commands');
    const commands = (await safeReadDir(commandsDir)).filter((name) =>
      /\.(md|txt|prompt|workflow)$/i.test(name)
    );
    if (commands.length) {
      details.push(`${commands.length} Claude commands`);
      commands
        .slice(0, 4)
        .forEach((name) =>
          sources.push(
            source(
              `/${path.basename(name, path.extname(name))}`,
              path.join(commandsDir, name),
              'project',
              'claude-command'
            )
          )
        );
    }

    const packageJsonPath = path.join(workDir, 'package.json');
    const packageJson = await safeReadJson(packageJsonPath);
    if (packageJson.warning) warnings.push(packageJson.warning);
    if (packageJson.value && typeof packageJson.value === 'object') {
      const scripts = (packageJson.value as { scripts?: Record<string, unknown> }).scripts;
      const scriptNames =
        scripts && typeof scripts === 'object'
          ? Object.keys(scripts).filter((name) =>
              /^(dev|test|build|check|lint|verify|watch|loop|goal|ci)/i.test(name)
            )
          : [];
      if (scriptNames.length) {
        details.push(`package scripts: ${scriptNames.slice(0, 4).join(', ')}`);
        sources.push(source('package.json scripts', packageJsonPath, 'project', 'package-scripts'));
      }
    }

    const settingsPaths = [
      path.join(workDir, '.claude', 'settings.json'),
      path.join(workDir, '.claude', 'settings.local.json'),
    ];
    for (const settingsPath of settingsPaths) {
      const parsed = await safeReadJson(settingsPath);
      if (parsed.warning) warnings.push(parsed.warning);
      if (parsed.value && typeof parsed.value === 'object' && 'hooks' in parsed.value) {
        details.push(`${path.basename(settingsPath)} hooks`);
        sources.push(source(path.basename(settingsPath), settingsPath, 'project', 'hooks'));
      }
    }

    const status =
      workflows.length || commands.length || sources.some((item) => item.kind === 'hooks')
        ? 'ready'
        : sources.length
          ? 'partial'
          : 'missing';

    return category({
      key: 'automations',
      title: 'Automations',
      subtitle: '心跳、计划任务和自动执行入口',
      status,
      details,
      gap:
        status === 'missing'
          ? '缺少 heartbeat：添加 schedule、hook 或 CI。'
          : '补齐自动验证与停止条件，避免只会运行不会收敛。',
      sources,
      actions: this.automationActions(),
      warnings,
    });
  }

  private async scanWorktrees(workDir: string): Promise<LoopAssetCategorySnapshot> {
    const details: string[] = [];
    const sources: LoopAssetSourceRef[] = [];
    const warnings: string[] = [];

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', workDir, 'worktree', 'list', '--porcelain'],
        { timeout: 3000 }
      );
      const worktreeLines = stdout.split('\n').filter((line) => line.startsWith('worktree '));
      const extraWorktrees = Math.max(worktreeLines.length - 1, 0);
      if (extraWorktrees > 0) {
        details.push(`${extraWorktrees} registered worktrees`);
        worktreeLines.slice(1, 5).forEach((line) => {
          const wt = line.replace(/^worktree\s+/, '').trim();
          sources.push(source(path.basename(wt), wt, 'project', 'git-worktree'));
        });
      }
    } catch {
      warnings.push('git worktree 扫描不可用或当前目录不是 git 仓库');
    }

    const claudeWorktreesDir = path.join(workDir, '.claude', 'worktrees');
    const claudeWorktrees = await safeReadDir(claudeWorktreesDir);
    if (claudeWorktrees.length) {
      details.push(`${claudeWorktrees.length} .claude worktrees`);
      sources.push(source('.claude/worktrees', claudeWorktreesDir, 'project', 'agent-worktrees'));
    }

    const status = statusFromCount(sources.length);
    return category({
      key: 'worktrees',
      title: 'Worktrees',
      subtitle: '并行 Agent 的隔离工作区',
      status,
      details,
      gap:
        status === 'missing'
          ? '并行 Agent 容易互相踩文件；为高风险任务启用 worktree 隔离。'
          : '关注陈旧/脏 worktree，避免审查带宽成为瓶颈。',
      sources,
      actions: this.worktreeActions(),
      warnings,
    });
  }

  private async scanSkillsAndMcp(workDir: string): Promise<LoopAssetCategorySnapshot> {
    const details: string[] = [];
    const sources: LoopAssetSourceRef[] = [];
    const warnings: string[] = [];
    const projectSkillRoots = [
      path.join(workDir, '.claude', 'skills'),
      path.join(workDir, '.hermit', 'skills'),
    ];
    const userSkillRoot = userHome('.claude', 'skills');

    let projectSkills = 0;
    let richSkills = 0;
    for (const root of projectSkillRoots) {
      const entries = await safeReadDir(root);
      for (const entry of entries) {
        const skillDir = path.join(root, entry);
        if (!(await exists(path.join(skillDir, 'SKILL.md')))) continue;
        projectSkills++;
        const hasRichAssets =
          (await exists(path.join(skillDir, 'scripts'))) ||
          (await exists(path.join(skillDir, 'references'))) ||
          (await exists(path.join(skillDir, 'assets')));
        if (hasRichAssets) richSkills++;
        sources.push(source(entry, skillDir, 'project', 'skill'));
      }
    }

    let userSkills = 0;
    for (const entry of await safeReadDir(userSkillRoot)) {
      if (await exists(path.join(userSkillRoot, entry, 'SKILL.md'))) userSkills++;
    }
    if (projectSkills) details.push(`${projectSkills} project skills`);
    if (richSkills) details.push(`${richSkills} with scripts/references/assets`);
    if (userSkills) details.push(`${userSkills} user skills available`);

    const mcpFiles = [
      path.join(workDir, '.mcp.json'),
      path.join(workDir, '.cursor', 'mcp.json'),
      path.join(workDir, '.claude', 'settings.json'),
      path.join(workDir, '.claude', 'settings.local.json'),
    ];

    for (const filePath of mcpFiles) {
      const parsed = await safeReadJson(filePath);
      if (parsed.warning) warnings.push(parsed.warning);
      if (!parsed.value || typeof parsed.value !== 'object') continue;
      const record = parsed.value as Record<string, unknown>;
      const mcpServers =
        record.mcpServers && typeof record.mcpServers === 'object'
          ? Object.keys(record.mcpServers as Record<string, unknown>)
          : record.mcp && typeof record.mcp === 'object'
            ? Object.keys(record.mcp as Record<string, unknown>)
            : [];
      if (mcpServers.length) {
        details.push(`${mcpServers.length} MCP servers in ${path.basename(filePath)}`);
        sources.push(source(path.basename(filePath), filePath, 'project', 'mcp'));
      }
      if ('enabledPlugins' in record || 'plugins' in record) {
        details.push(`plugins configured in ${path.basename(filePath)}`);
        sources.push(source(path.basename(filePath), filePath, 'project', 'plugins'));
      }
    }

    const hasExecutableTooling = sources.some(
      (item) => item.kind === 'mcp' || item.kind === 'plugins'
    );
    const status: LoopAssetStatus =
      projectSkills > 0 && (richSkills > 0 || hasExecutableTooling)
        ? 'ready'
        : projectSkills > 0 || userSkills > 0 || sources.length > 0
          ? 'partial'
          : 'missing';
    return category({
      key: 'skills',
      title: 'Skills/MCP',
      subtitle: '可复用项目知识与可执行工具',
      status,
      details,
      gap:
        status === 'missing'
          ? '把重复的项目意图沉淀成 .claude/skills/<name>/SKILL.md，并配置 MCP/插件工具。'
          : '为关键 skill 增加 scripts/references/assets，并确认 MCP/插件权限最小化。',
      sources,
      actions: this.skillActions(),
      warnings,
    });
  }

  private async scanSubagents(
    workDir: string,
    memberCount: number
  ): Promise<LoopAssetCategorySnapshot> {
    const details: string[] = [];
    const sources: LoopAssetSourceRef[] = [];
    const agentDir = path.join(workDir, '.claude', 'agents');
    const projectAgents = (await safeReadDir(agentDir)).filter((name) =>
      /\.(md|json|toml|yaml|yml)$/i.test(name)
    );
    if (projectAgents.length) {
      details.push(`${projectAgents.length} project agents`);
      projectAgents
        .slice(0, 4)
        .forEach((name) =>
          sources.push(source(name, path.join(agentDir, name), 'project', 'subagent'))
        );
    }
    if (memberCount > 0) {
      details.push(`${memberCount} AgentCLI team members`);
      sources.push({ label: 'AgentCLI team members', scope: 'team', kind: 'team-members' });
    }

    const hasVerifier = projectAgents.some((name) =>
      /verifier|review|reviewer|qa|test/i.test(name)
    );
    if (projectAgents.length && !hasVerifier) details.push('verifier role not detected');
    const status: LoopAssetStatus =
      hasVerifier || memberCount > 1
        ? 'ready'
        : projectAgents.length > 0 || memberCount === 1
          ? 'warning'
          : 'missing';
    return category({
      key: 'subagents',
      title: 'Sub-agents',
      subtitle: '实现、探索、验证分工',
      status,
      details,
      gap:
        status === 'missing'
          ? '添加 verifier/reviewer/researcher 角色，避免写代码的 Agent 自评。'
          : hasVerifier || memberCount > 1
            ? '保持验证者和实现者分离，并把验收证据写回状态/看板。'
            : '已发现 Agent 资产但缺少 verifier/reviewer/QA；补一个独立验证角色。',
      sources,
      actions: this.subagentActions(),
    });
  }

  private async scanState(
    workDir: string,
    input: ScanTeamInput
  ): Promise<LoopAssetCategorySnapshot> {
    const details: string[] = [];
    const sources: LoopAssetSourceRef[] = [];
    const statePaths = [
      path.join(workDir, '.omc', 'state'),
      path.join(workDir, '.omc', 'sessions'),
      path.join(workDir, '.omc', 'plans'),
      path.join(workDir, '.omc', 'logs'),
      path.join(workDir, 'reports'),
      path.join(workDir, 'plans'),
    ];
    for (const dir of statePaths) {
      const entries = await safeReadDir(dir);
      if (entries.length) {
        details.push(`${path.relative(workDir, dir)} (${entries.length})`);
        sources.push(source(path.relative(workDir, dir), dir, 'project', 'state-dir'));
      }
    }
    for (const filename of ['CLAUDE.md', 'AGENTS.md']) {
      const filePath = path.join(workDir, filename);
      if (await exists(filePath)) {
        details.push(filename);
        sources.push(source(filename, filePath, 'project', 'instructions'));
      }
    }
    if (input.taskCount != null && input.taskCount > 0) {
      details.push(`${input.taskCount} AgentCLI tasks`);
      sources.push({
        label: 'AgentCLI task board',
        path: input.teamRoot,
        scope: 'team',
        kind: 'task-board',
      });
    }
    if (input.messageCount != null && input.messageCount > 0) {
      details.push(`${input.messageCount} team messages`);
      sources.push({
        label: 'AgentCLI messages',
        path: input.teamRoot,
        scope: 'team',
        kind: 'messages',
      });
    }

    const status = sources.some((item) => item.kind === 'state-dir' || item.kind === 'task-board')
      ? 'ready'
      : statusFromCount(sources.length);
    return category({
      key: 'state',
      title: 'State',
      subtitle: '跨运行记忆、看板和恢复层',
      status,
      details,
      gap:
        status === 'missing'
          ? '把进度写入看板、状态文件或报告；不要只存在上下文里。'
          : '检查状态是否过期，确保下一次循环能恢复而不是重新猜。',
      sources,
      actions: this.stateActions(),
    });
  }

  private automationActions(): LoopAssetAction[] {
    return [
      action('run-folder-hygiene', '目录整洁巡检', 'loop-session', 'daily-folder-hygiene', {
        sessionName: 'Daily Folder Hygiene',
        prompt:
          '请只读扫描当前项目工作区是否变乱：检查根目录、reports、plans、.omc、.claude、临时输出、陈旧报告、脏 worktree 和未归档产物。不要修改文件，只输出证据、风险和整理建议。',
      }),
      action(
        'run-memory-conflicts',
        '记忆冲突巡检',
        'loop-session',
        'daily-memory-conflict-check',
        {
          sessionName: 'Daily Memory Conflict Check',
          prompt:
            '请只读检查当前项目的 CLAUDE.md、AGENTS.md、.claude/settings、memory 和状态文件是否存在重复、过期或冲突指令。不要写入 memory，只输出冲突证据、建议保留的唯一事实来源和合并计划。',
        }
      ),
      action(
        'run-workflow-extraction',
        '提取重复 Workflow',
        'loop-session',
        'daily-workflow-extraction',
        {
          sessionName: 'Daily Workflow Extraction',
          prompt:
            '请只读查看最近聊天、任务、会话和报告，提取重复出现的工作流程，按价值排序，并给出可沉淀为 skill、workflow、schedule 或 team template 的草案。不要创建文件。',
        }
      ),
    ];
  }

  private worktreeActions(): LoopAssetAction[] {
    return [
      action('run-worktree-scan', '运行 Worktree Scan', 'loop-session', 'worktree-scan', {
        sessionName: 'Worktree Scan',
        command: '/worktree-scan',
      }),
    ];
  }

  private skillActions(): LoopAssetAction[] {
    return [
      action('run-skills-scan', '发送 /skills', 'loop-session', 'skills-mcp-scan', {
        sessionName: 'Loop Skills',
        command: '/skills',
      }),
      action('bind-platform', '绑定新渠道', 'open-dialog', 'runtime-config'),
    ];
  }

  private subagentActions(): LoopAssetAction[] {
    return [
      action('add-member', '自然语言添加验证角色', 'loop-session', 'verifier-gap', {
        sessionName: 'Loop Verifier Setup',
        prompt:
          '请为这个团队添加一个独立 verifier/reviewer 角色，负责验证实现者的产出，不能由实现者自审。请给出成员名、职责和启动方式，并在需要时创建或更新团队成员。',
      }),
    ];
  }

  private stateActions(): LoopAssetAction[] {
    return [
      action('open-board', '查看任务看板', 'navigate', 'tasks'),
      action('run-state-scan', '运行 State Scan', 'loop-session', 'state-scan', {
        sessionName: 'State Scan',
        command: '/state-scan',
      }),
    ];
  }
}
