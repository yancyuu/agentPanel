/**
 * Tests: TeamProvisioningService — dispatchTask 协同开关
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TeamProvisioningService } from '@main/services/team-management/TeamProvisioningService';
import { TeamWorkspaceService } from '@main/services/team-management/TeamWorkspaceService';

// ---------------------------------------------------------------------------
// Minimal mocks for HermitBridgeClient and HermitBridgeConnection
// ---------------------------------------------------------------------------

function makeCcClient() {
  return {
    createProject: vi.fn().mockResolvedValue({ message: 'ok', restart_required: false }),
    restart: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue({
      name: 'mock',
      agent_type: 'claudecode',
      platforms: [],
      work_dir: '/tmp',
      heartbeat: {},
      settings: {},
      sessions_count: 0,
      active_session_keys: [],
      agent_mode: 'auto',
    }),
    getStatus: vi.fn().mockResolvedValue({
      version: '1.0',
      uptime_seconds: 0,
      projects_count: 0,
      platforms_connected: 0,
    }),
    listProjects: vi.fn().mockResolvedValue([]),
  };
}

function makeBridge() {
  return {
    sendUserMessage: vi.fn(),
    connected: true,
  };
}

// ---------------------------------------------------------------------------

let tmpDir: string;
let workspace: TeamWorkspaceService;
let svc: TeamProvisioningService;
let mockCc: ReturnType<typeof makeCcClient>;
let mockBridge: ReturnType<typeof makeBridge>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-svc-test-'));
  process.env.HERMIT_HOME = tmpDir;
  workspace = new TeamWorkspaceService();
  mockCc = makeCcClient();
  mockBridge = makeBridge();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc = new TeamProvisioningService(mockCc as any, mockBridge as any, workspace);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HERMIT_HOME;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
describe('createTeam', () => {
  it('creates local manifest without cc project when createCcProject=false', async () => {
    const { slug } = await svc.createTeam({
      displayName: 'no-cc',
      bindProject: 'no-cc-project',
      harness: 'claudecode',
      workDir: path.join(tmpDir, 'work'),
      createCcProject: false,
    });
    expect(slug).toBeTruthy();
    expect(mockCc.createProject).not.toHaveBeenCalled();
  });

  it('calls cc.createProject when createCcProject=true (default)', async () => {
    await svc.createTeam({
      displayName: 'with-cc',
      bindProject: 'with-cc-project',
      harness: 'codex',
      workDir: path.join(tmpDir, 'work2'),
      createCcProject: true,
    });
    expect(mockCc.createProject).toHaveBeenCalledWith(
      'with-cc-project',
      'codex',
      path.join(tmpDir, 'work2'),
      'bridge',
      {}
    );
  });

  it('uses restart hook when project creation requires cc-connect restart', async () => {
    mockCc.createProject.mockResolvedValueOnce({ message: 'ok', restart_required: true });
    const restartCcConnect = vi.fn().mockResolvedValue(undefined);
    const hookedSvc = new TeamProvisioningService(mockCc as any, mockBridge as any, workspace, {
      restartCcConnect,
    });

    await hookedSvc.createTeam({
      displayName: 'restart-team',
      bindProject: 'restart-project',
      harness: 'codex',
      workDir: path.join(tmpDir, 'restart-work'),
      createCcProject: true,
    });

    expect(restartCcConnect).toHaveBeenCalledTimes(1);
    expect(mockCc.restart).not.toHaveBeenCalled();
  });

  it('injects CLI task-bus and ops runbook instructions without creating MCP config', async () => {
    const workDir = path.join(tmpDir, 'cli-task-bus-work');
    fs.mkdirSync(workDir, { recursive: true });
    await svc.createTeam({
      displayName: 'cli-task-bus-team',
      bindProject: 'cli-task-bus-project',
      harness: 'claudecode',
      workDir,
      createCcProject: false,
    });
    expect(fs.existsSync(path.join(workDir, '.claude', 'settings.json'))).toBe(false);

    const claudeMd = fs.readFileSync(path.join(workDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('## AgentPanel Team Context');
    expect(claudeMd).toContain("AgentPanel's task bus");
    expect(claudeMd).toContain('agentpanel --port');
    expect(claudeMd).toContain('tasks claim --team');
    expect(claudeMd).toContain('tasks complete --team');
    expect(claudeMd).toContain('Do not use MCP, Skills');
    expect(claudeMd).toContain('## AgentPanel Ops Runbook Context');
    expect(claudeMd).toContain('Bundled diagnostics guide');
    expect(claudeMd).toContain('global “创建任务” inbox');
    expect(claudeMd).not.toContain('npm install -g @yancyyu/openhermit');
    expect(claudeMd).toContain('/hermit:doctor');
    expect(claudeMd).toContain('/hermit:loop-scan');
    expect(claudeMd).toContain('hermit-bridge remains an internal compatibility sidecar');
    expect(claudeMd).not.toContain('cc-connect Bridge / Management API');
  });

  it('backfills existing teams and removes only the legacy Hermit task MCP entry', async () => {
    const workDir = path.join(tmpDir, 'backfill-work');
    fs.mkdirSync(path.join(workDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), '# User instructions\n');
    fs.writeFileSync(
      path.join(workDir, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          'hermit-tasks': { type: 'sse', url: 'http://127.0.0.1:5680/mcp' },
          custom: { command: 'custom-mcp' },
        },
      })
    );
    await svc.createTeam({
      displayName: 'backfill-team',
      bindProject: 'backfill-project',
      harness: 'claudecode',
      workDir,
      createCcProject: false,
      injectInstructions: false,
    });

    await expect(svc.backfillTeamInstructions()).resolves.toEqual({ updated: 1, failed: 0 });

    const settings = JSON.parse(
      fs.readFileSync(path.join(workDir, '.claude', 'settings.json'), 'utf8')
    );
    expect(settings.mcpServers).toEqual({ custom: { command: 'custom-mcp' } });
    const claudeMd = fs.readFileSync(path.join(workDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('# User instructions');
    expect(claudeMd).toContain('tasks claim --team backfill-project');
  });

  it('injects the same CLI task-bus contract into AGENTS.md for codex', async () => {
    const workDir = path.join(tmpDir, 'codex-work');
    fs.mkdirSync(workDir, { recursive: true });
    await svc.createTeam({
      displayName: 'codex-team',
      bindProject: 'codex-project',
      harness: 'codex',
      workDir,
      createCcProject: false,
    });
    expect(fs.existsSync(path.join(workDir, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'CLAUDE.md'))).toBe(false);
    const agentsMd = fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('agentpanel --port');
    expect(agentsMd).toContain('Do not use MCP, Skills');
  });
});

// ---------------------------------------------------------------------------
describe('dispatchTask — 协同开关', () => {
  async function setupTwoTeams(sourceCollab: boolean, targetCollab: boolean) {
    const { slug: sourceSlug } = await svc.createTeam({
      displayName: 'source-team',
      bindProject: 'source-cc',
      harness: 'claudecode',
      workDir: path.join(tmpDir, 'source'),
      collaboration: sourceCollab,
      createCcProject: false,
    });
    const { slug: targetSlug } = await svc.createTeam({
      displayName: 'target-team',
      bindProject: 'target-cc',
      harness: 'codex',
      workDir: path.join(tmpDir, 'target'),
      collaboration: targetCollab,
      createCcProject: false,
    });
    return { sourceSlug, targetSlug };
  }

  it('sends Bridge message when both teams have collaboration=true', async () => {
    const { sourceSlug, targetSlug } = await setupTwoTeams(true, true);
    const task = await svc.createTask(sourceSlug, { title: 'cross task', assignee: targetSlug });
    await svc.dispatchTask(sourceSlug, task);
    expect(mockBridge.sendUserMessage).toHaveBeenCalledOnce();
    const call = mockBridge.sendUserMessage.mock.calls[0][0];
    expect(call.project).toBe('target-cc');
    expect(call.content).toContain(task.id);
    expect(call.content).toContain('cross task');
    expect(call.content).toContain(path.join(tmpDir, 'bin', 'agentpanel'));
    expect(call.content).toContain(`tasks claim --team ${targetSlug} --id ${task.id}`);
    expect(call.content).toContain(`tasks complete --team ${targetSlug} --id ${task.id}`);
    expect(call.content).toContain('不要使用 MCP、Skills');
    expect(call.content).not.toContain('claim_task');
  });

  it('skips dispatch when source team collaboration=false', async () => {
    const { sourceSlug, targetSlug } = await setupTwoTeams(false, true);
    const task = await svc.createTask(sourceSlug, { title: 'solo task', assignee: targetSlug });
    await svc.dispatchTask(sourceSlug, task);
    expect(mockBridge.sendUserMessage).not.toHaveBeenCalled();
  });

  it('skips dispatch when target team collaboration=false', async () => {
    const { sourceSlug, targetSlug } = await setupTwoTeams(true, false);
    const task = await svc.createTask(sourceSlug, { title: 'blocked task', assignee: targetSlug });
    await svc.dispatchTask(sourceSlug, task);
    expect(mockBridge.sendUserMessage).not.toHaveBeenCalled();
  });

  it('skips dispatch when task has no assignee', async () => {
    const { sourceSlug } = await setupTwoTeams(true, true);
    const task = await svc.createTask(sourceSlug, { title: 'unassigned' });
    await svc.dispatchTask(sourceSlug, task);
    expect(mockBridge.sendUserMessage).not.toHaveBeenCalled();
  });

  it('does not throw when target team does not exist', async () => {
    const { slug: sourceSlug } = await svc.createTeam({
      displayName: 'source',
      bindProject: 'src-cc',
      harness: 'claudecode',
      workDir: path.join(tmpDir, 'src'),
      createCcProject: false,
    });
    const task = await svc.createTask(sourceSlug, {
      title: 'ghost task',
      assignee: 'non-existent-team',
    });
    await expect(svc.dispatchTask(sourceSlug, task)).resolves.toBeUndefined();
    expect(mockBridge.sendUserMessage).not.toHaveBeenCalled();
  });
});
