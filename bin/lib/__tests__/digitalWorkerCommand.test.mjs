import { describe, expect, it, vi } from 'vitest';

import {
  buildDigitalWorkerCommandOptions,
  provisionDigitalWorker,
} from '../digitalWorkerCommand.mjs';

function findArg(args, flag) {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : null;
}

function dependencies(overrides = {}) {
  return {
    ensureLocalServer: vi.fn(async () => ({ ready: true })),
    createTeam: vi.fn(async (_port, request) => ({ ok: true, teamSlug: request.bindProject })),
    ensureRuntime: vi.fn(async () => ({ ok: true })),
    ensureAgentRuntimeCli: vi.fn(async () => ({ ok: true, installed: true })),
    beginQr: vi.fn(async () => ({ qr_url: 'https://qr', device_code: 'device' })),
    waitForQr: vi.fn(async (_port, _platform, _begin, onStatus) => {
      onStatus?.('completed');
      return { status: 'completed', app_id: 'app', app_secret: 'secret', platform: 'lark' };
    }),
    saveQr: vi.fn(async () => ({ message: 'saved', restart_required: false, restart_handled: true })),
    bindManual: vi.fn(async () => ({ message: 'bound', restart_required: false, restart_handled: false })),
    rollback: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

const base = {
  name: '客服员工',
  bindProject: 'support-worker',
  workDir: '/repo/app',
  agentType: 'claudecode',
  platform: 'feishu',
  platformOptions: {},
};

describe('digitalWorkerCommand — command option parsing', () => {
  it('builds a non-interactive digital worker request from CLI flags', () => {
    const options = buildDigitalWorkerCommandOptions([
      'create-digital-worker', '--name', '客服员工', '--description=接待用户',
      '--bind-project', 'support-worker', '--work-dir', '/repo/app', '--agent-type', 'codex',
      '--platform', 'feishu',
    ], findArg);

    expect(options).toMatchObject({
      ok: true,
      name: '客服员工',
      description: '接待用户',
      bindProject: 'support-worker',
      workDir: '/repo/app',
      agentType: 'codex',
      platform: 'feishu',
      platformOptions: {},
    });
  });

  it('defaults to Claude Code and Feishu for quick QR setup', () => {
    const options = buildDigitalWorkerCommandOptions(['create-digital-worker', '--name', '测试'], findArg);
    expect(options).toMatchObject({ ok: true, agentType: 'claudecode', platform: 'feishu', platformOptions: {} });
  });

  it('rejects invalid platform options JSON before doing network work', () => {
    expect(buildDigitalWorkerCommandOptions([
      'create-digital-worker', '--name', '测试', '--platform-options', 'not-json',
    ], findArg)).toEqual({ ok: false, message: '--platform-options 必须是 JSON 对象' });
  });
});

describe('provisionDigitalWorker — claim/create restriction to Feishu + Claude Code/Codex', () => {
  it('rejects an unsupported channel before any side effect', async () => {
    const deps = dependencies();
    const result = await provisionDigitalWorker(5680, {
      ...base,
      platform: 'slack',
      platformOptions: {},
    }, {}, deps);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('feishu');
    expect(deps.ensureLocalServer).not.toHaveBeenCalled();
    expect(deps.createTeam).not.toHaveBeenCalled();
  });

  it('rejects an unsupported runtime before any side effect', async () => {
    const deps = dependencies();
    const result = await provisionDigitalWorker(5680, {
      ...base,
      agentType: 'cursor',
    }, {}, deps);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('claudecode');
    expect(deps.ensureLocalServer).not.toHaveBeenCalled();
  });
});

describe('provisionDigitalWorker — runtime CLI gate', () => {
  it('verifies the agentType runtime CLI before creating the team, then proceeds', async () => {
    const deps = dependencies({
      ensureAgentRuntimeCli: vi.fn(async (agentType) => ({ ok: true, installed: true, agentType })),
    });

    const result = await provisionDigitalWorker(5680, base, {}, deps);

    expect(deps.ensureAgentRuntimeCli).toHaveBeenCalledWith('claudecode');
    expect(result.ok).toBe(true);
    expect(deps.createTeam).toHaveBeenCalled();
  });

  it('aborts before any side effect when the runtime CLI is missing and cannot be installed', async () => {
    const deps = dependencies({
      ensureAgentRuntimeCli: vi.fn(async () => ({
        ok: false,
        message: 'Codex CLI 自动安装失败，请手动安装后重试：npm install -g @openai/codex@latest',
      })),
    });

    const result = await provisionDigitalWorker(5680, { ...base, agentType: 'codex' }, {}, deps);

    expect(result).toMatchObject({
      ok: false,
      failedStage: '检查运行时 CLI',
      message: expect.stringContaining('Codex CLI 自动安装失败'),
      rollback: { attempted: false },
    });
    expect(deps.ensureAgentRuntimeCli).toHaveBeenCalledWith('codex');
    expect(deps.createTeam).not.toHaveBeenCalled();
    expect(deps.ensureRuntime).not.toHaveBeenCalled();
    expect(deps.rollback).not.toHaveBeenCalled();
  });

  it('re-authorize (existingTeam) is also gated — no rebind / cc-connect restart when runtime missing', async () => {
    const deps = dependencies({
      ensureAgentRuntimeCli: vi.fn(async () => ({
        ok: false,
        message: 'Codex CLI 自动安装失败，请手动安装后重试：npm install -g @openai/codex@latest',
      })),
    });

    const result = await provisionDigitalWorker(5680, { ...base, agentType: 'codex', existingTeam: true }, {}, deps);

    expect(result).toMatchObject({
      ok: false,
      failedStage: '检查运行时 CLI',
      rollback: { attempted: false },
    });
    expect(deps.ensureAgentRuntimeCli).toHaveBeenCalledWith('codex');
    expect(deps.saveQr).not.toHaveBeenCalled();
    expect(deps.bindManual).not.toHaveBeenCalled();
  });
});

describe('provisionDigitalWorker', () => {

  it('refuses creation before any side effect when the workbench is not running', async () => {
    const deps = dependencies({
      ensureLocalServer: vi.fn(async () => {
        throw new Error('AgentCli 工作台未启动：请先运行 agentcli web 或在菜单中开启 AgentCli 工作台，再创建数字员工。');
      }),
    });

    const result = await provisionDigitalWorker(5680, base, {}, deps);

    expect(result).toMatchObject({
      ok: false,
      failedStage: '启动本地工作台 API',
      message: expect.stringContaining('AgentCli 工作台未启动'),
      rollback: { attempted: false },
    });
    expect(deps.createTeam).not.toHaveBeenCalled();
    expect(deps.ensureRuntime).not.toHaveBeenCalled();
    expect(deps.beginQr).not.toHaveBeenCalled();
    expect(deps.bindManual).not.toHaveBeenCalled();
  });

  it('rolls back when the runtime never becomes ready', async () => {
    const deps = dependencies({
      ensureRuntime: vi.fn(async () => ({ ok: false, message: '渠道连接服务未就绪' })),
    });

    const result = await provisionDigitalWorker(5680, base, {}, deps);

    expect(result).toMatchObject({
      ok: false,
      failedStage: '启动渠道连接服务',
      message: '渠道连接服务未就绪',
    });
    expect(deps.ensureRuntime).toHaveBeenCalledWith(5680);
    expect(deps.rollback).toHaveBeenCalledTimes(1);
    expect(deps.beginQr).not.toHaveBeenCalled();
  });

  it('completes QR begin, poll, and save before reporting success', async () => {
    const order = [];
    const deps = dependencies({
      beginQr: vi.fn(async () => { order.push('begin'); return { qr_url: 'https://qr', device_code: 'd' }; }),
      waitForQr: vi.fn(async () => { order.push('poll'); return { app_id: 'app', app_secret: 'secret', platform: 'lark' }; }),
      saveQr: vi.fn(async () => { order.push('save'); return { restart_required: false, restart_handled: true }; }),
    });
    const onQrCode = vi.fn(async () => order.push('show'));

    const result = await provisionDigitalWorker(5680, base, { onQrCode }, deps);

    expect(order).toEqual(['begin', 'show', 'poll', 'save']);
    expect(result).toMatchObject({
      ok: true,
      status: 'bound',
      teamSlug: 'support-worker',
    });
    expect(result.binding).toMatchObject({ restartHandled: true });
  });

  it('reports that QR setup restarted and connected the channel', async () => {
    const deps = dependencies({
      saveQr: vi.fn(async () => ({ restart_required: false, restart_handled: true })),
    });

    const result = await provisionDigitalWorker(5680, base, {}, deps);

    expect(result.binding).toMatchObject({ restartRequired: false, restartHandled: true });
  });

  it('rolls back once and preserves both provisioning and rollback failures', async () => {
    const deps = dependencies({
      waitForQr: vi.fn(async () => { throw new Error('二维码已过期'); }),
      rollback: vi.fn(async () => { throw new Error('外部项目删除失败'); }),
    });

    const result = await provisionDigitalWorker(5680, base, {}, deps);

    expect(result).toMatchObject({
      ok: false,
      failedStage: '绑定渠道',
      message: '二维码已过期',
      rollback: { attempted: true, ok: false, message: '外部项目删除失败' },
    });
    expect(deps.rollback).toHaveBeenCalledTimes(1);
  });

  it('rolls back when post-binding authorization fails', async () => {
    const deps = dependencies();
    const result = await provisionDigitalWorker(5680, base, {
      afterPlatformBound: vi.fn(async () => ({ ok: false, message: '个人授权未完成' })),
    }, deps);

    expect(result).toMatchObject({ ok: false, failedStage: '完成渠道授权' });
    expect(deps.rollback).toHaveBeenCalledTimes(1);
  });

  it('existingTeam mode skips team creation and still binds the channel', async () => {
    const deps = dependencies();

    const result = await provisionDigitalWorker(5680, { ...base, existingTeam: true }, {}, deps);

    expect(result).toMatchObject({ ok: true, status: 'bound', teamSlug: 'support-worker' });
    expect(deps.createTeam).not.toHaveBeenCalled();
    expect(result.team).toMatchObject({ existing: true, teamSlug: 'support-worker' });
    expect(deps.saveQr).toHaveBeenCalledTimes(1);
  });

  it('existingTeam mode never rolls back the pre-existing team on failure', async () => {
    const deps = dependencies({
      waitForQr: vi.fn(async () => { throw new Error('二维码已过期'); }),
    });

    const result = await provisionDigitalWorker(5680, { ...base, existingTeam: true }, {}, deps);

    expect(result).toMatchObject({
      ok: false,
      failedStage: '绑定渠道',
      message: '二维码已过期',
      rollback: { attempted: false },
    });
    expect(deps.rollback).not.toHaveBeenCalled();
  });
});
