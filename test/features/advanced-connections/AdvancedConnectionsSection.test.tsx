import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdvancedConnectionsSection } from '@features/advanced-connections/renderer/ui/AdvancedConnectionsSection';
import { describeConnectionOperationError } from '@features/advanced-connections/renderer/hooks/useAdvancedConnections';

import type { AdvancedConnectionSummary } from '@features/advanced-connections/contracts';

function makeConnection(overrides: Partial<AdvancedConnectionSummary> = {}): AdvancedConnectionSummary {
  return {
    id: 'connection_1',
    label: '公司 AgentBus',
    baseUrl: 'http://47.112.24.153',
    secure: false,
    providerId: 'openhermit-agentbus',
    providerName: '公司团队服务',
    state: 'auth_required',
    grantedScopes: [],
    capabilities: [
      { id: 'identity', displayName: '用户授权' },
      { id: 'team-bus', displayName: '团队总线' },
      { id: 'reporting', displayName: '数据上报' },
      { id: 'token-pool', displayName: 'Token 池' },
    ],
    authMethods: [
      { id: 'company-login', type: 'device_code', displayName: '公司账号登录', requestedScopes: [] },
    ],
    permissions: {} as AdvancedConnectionSummary['permissions'],
    secretPresent: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const createdRoots: ReturnType<typeof createRoot>[] = [];

function renderSection(props: {
  connections: AdvancedConnectionSummary[];
  onStartAuth?: (connection: AdvancedConnectionSummary) => void;
  onAllowInsecure?: (connectionId: string) => void;
  onSetUsageReporting?: (connectionId: string, enabled: boolean) => void;
  busyAction?: string | null;
  channelStatus?: Parameters<typeof AdvancedConnectionsSection>[0]['channelStatus'];
  catalogStatus?: Parameters<typeof AdvancedConnectionsSection>[0]['catalogStatus'];
  claimSteps?: Parameters<typeof AdvancedConnectionsSection>[0]['claimSteps'];
}): { host: HTMLElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  createdRoots.push(root);
  act(() => {
    root.render(
      <AdvancedConnectionsSection
        connections={props.connections}
        host=""
        preview={null}
        loading={false}
        busyAction={props.busyAction ?? null}
        error={null}
        notice={null}
        catalogStatus={props.catalogStatus ?? {}}
        claimSteps={props.claimSteps ?? {}}
        channelStatus={props.channelStatus ?? {}}
        onHostChange={vi.fn()}
        onDiscover={vi.fn()}
        onAddConnection={vi.fn()}
        onRemoveConnection={vi.fn()}
        onStartAuth={props.onStartAuth ?? vi.fn()}
        onLogout={vi.fn()}
        onAllowInsecure={props.onAllowInsecure ?? vi.fn()}
        onPullRemoteTasks={vi.fn()}
        onSetUsageReporting={props.onSetUsageReporting ?? vi.fn()}
        onClaimAndApplyToken={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
  });
  return { host, root };
}

function clickButton(host: HTMLElement, text: string): void {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

describe('AdvancedConnectionsSection', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    for (const root of createdRoots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('不再渲染「允许的数据范围」区', () => {
    const { host } = renderSection({
      connections: [makeConnection({ state: 'authenticated', secretPresent: true })],
    });
    expect(host.textContent).not.toContain('允许的数据范围');
    expect(host.textContent).not.toContain('Usage 汇总');
    expect(host.textContent).not.toContain('消息正文');
    expect(host.textContent).toContain('服务能力');
  });

  it('HTTPS 连接点击登录授权直接发起，不弹确认', () => {
    const onStartAuth = vi.fn();
    const { host } = renderSection({
      connections: [makeConnection({ baseUrl: 'https://bus.company.test', secure: true })],
      onStartAuth,
    });
    clickButton(host, '登录授权');
    expect(onStartAuth).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="insecure-confirm-dialog"]')).toBeNull();
  });

  it('HTTP 连接常显非加密徽章，登录前先弹风险确认，确认后按连接放行', () => {
    const onStartAuth = vi.fn();
    const onAllowInsecure = vi.fn();
    const { host } = renderSection({
      connections: [makeConnection()],
      onStartAuth,
      onAllowInsecure,
    });

    expect(host.textContent).toContain('非加密 HTTP');
    clickButton(host, '登录授权');
    expect(onStartAuth).not.toHaveBeenCalled();

    const dialog = host.querySelector('[data-testid="insecure-confirm-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('可能被窃听');
    expect(dialog?.textContent).toContain('仍要继续吗');

    clickButton(host, '仍要继续');
    expect(onAllowInsecure).toHaveBeenCalledWith('connection_1');
    expect(host.querySelector('[data-testid="insecure-confirm-dialog"]')).toBeNull();
  });

  it('已确认放行的 HTTP 连接登录不再询问，直接发起授权', () => {
    const onStartAuth = vi.fn();
    const { host } = renderSection({
      connections: [makeConnection({ insecureAllowed: true })],
      onStartAuth,
    });
    clickButton(host, '登录授权');
    expect(onStartAuth).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="insecure-confirm-dialog"]')).toBeNull();
  });

  it('同步/检查按钮只看登录态，不再读数据范围', () => {
    const authenticatedConnection = makeConnection({
      id: 'connection_authed',
      state: 'authenticated',
      secretPresent: true,
      secure: true,
      baseUrl: 'https://bus.company.test',
    });
    const guestConnection = makeConnection({ id: 'connection_guest' });
    const { host } = renderSection({
      connections: [authenticatedConnection, guestConnection],
    });

    const syncButtons = [...host.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('同步已授权数据')
    );
    const pullButtons = [...host.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('检查远程任务')
    );
    // 「同步已授权数据」按钮已移除（聚合用量由消息上报通道自动汇总）
    expect(syncButtons).toHaveLength(0);
    expect(pullButtons).toHaveLength(2);
    expect(pullButtons[0]?.disabled).toBe(false);
    expect(pullButtons[1]?.disabled).toBe(true);
  });

  it('展示最近一次操作结果（成功摘要与失败错误原文 + 时间）', () => {
    const connection = makeConnection({
      state: 'authenticated',
      secretPresent: true,
      secure: true,
      baseUrl: 'https://bus.company.test',
    });
    const { host } = renderSection({
      connections: [connection],
      channelStatus: {
        [connection.id]: {
          ok: true,
          at: '2026-08-02T10:00:00.000Z',
          text: '发现 2 个远程任务：整理报价、巡检站点。为安全起见，尚未自动执行。',
        },
      },
      catalogStatus: {
        [connection.id]: {
          ok: false,
          at: '2026-08-02T10:01:00.000Z',
          text: '授权已失效，请重新登录（Token 池查询失败（HTTP 401））',
        },
      },
    });

    const outcomes = host.querySelectorAll('[data-testid="operation-outcome"]');
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.textContent).toContain('发现 2 个远程任务');
    expect(outcomes[0]?.className).toContain('emerald');
    expect(outcomes[1]?.textContent).toContain('授权已失效，请重新登录');
    expect(outcomes[1]?.textContent).toContain('HTTP 401');
    expect(outcomes[1]?.className).toContain('rose');
  });

  it('Token 池区只有「领取并应用」主按钮（检测按钮已删除）', () => {
    const connection = makeConnection({
      state: 'authenticated',
      secretPresent: true,
      secure: true,
      baseUrl: 'https://bus.company.test',
    });
    const { host } = renderSection({ connections: [connection] });

    expect(host.textContent).not.toContain('检测 Token 池');
    const claimButton = buttonByText(host, '领取并应用');
    expect(claimButton.disabled).toBe(false);
  });

  it('用量上报开关显示当前状态并切换', () => {
    const onSetUsageReporting = vi.fn();
    const granted = makeConnection({
      id: 'connection_granted',
      secure: true,
      baseUrl: 'https://bus.company.test',
      permissions: { 'usage.aggregates': 'granted' } as AdvancedConnectionSummary['permissions'],
    });
    const denied = makeConnection({
      id: 'connection_denied',
      permissions: { 'usage.aggregates': 'denied' } as AdvancedConnectionSummary['permissions'],
    });
    const { host } = renderSection({
      connections: [granted, denied],
      onSetUsageReporting,
    });

    // 每个连接一个 SettingsToggle（role="switch"），按 article 顺序对应两个连接
    const toggles = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(toggles).toHaveLength(2);
    const [grantedToggle, deniedToggle] = toggles;
    expect(grantedToggle?.getAttribute('aria-checked')).toBe('true');
    expect(deniedToggle?.getAttribute('aria-checked')).toBe('false');
    expect(host.textContent).toContain('用量上报');

    act(() => {
      grantedToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      deniedToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSetUsageReporting).toHaveBeenCalledWith('connection_granted', false);
    expect(onSetUsageReporting).toHaveBeenCalledWith('connection_denied', true);
  });

  it('compat 连接显示「未提供远程任务通道」说明而不渲染检查按钮', () => {
    const connection = makeConnection({
      compatibilityMode: true,
      state: 'authenticated',
      secretPresent: true,
      secure: true,
      baseUrl: 'https://bus.company.test',
    });
    const { host } = renderSection({ connections: [connection] });

    expect(host.textContent).toContain('当前 AgentBus 兼容接口未提供远程任务通道');
    expect(
      [...host.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('检查远程任务')
      )
    ).toBe(false);
  });

  it('领取步骤进度：进行中高亮，失败停在对应步骤并透出错误', () => {
    const connection = makeConnection({
      state: 'authenticated',
      secretPresent: true,
      secure: true,
      baseUrl: 'https://bus.company.test',
    });
    const { host } = renderSection({
      connections: [connection],
      claimSteps: {
        [connection.id]: [
          { connectionId: connection.id, step: 'discover', status: 'done' },
          { connectionId: connection.id, step: 'provision', status: 'done' },
          { connectionId: connection.id, step: 'poll', status: 'progress', text: 'running' },
        ],
      },
    });

    expect(host.querySelector('[data-testid="claim-steps"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="claim-step:poll"]')?.getAttribute('data-status')
    ).toBe('progress');
    expect(host.querySelector('[data-testid="claim-step:apply"]')?.getAttribute('data-status')).toBe(
      'pending'
    );
    expect(host.textContent).toContain('等待开通（running）');
    // 检测按钮不存在（步骤视图替代了两段式流程）
    expect(host.textContent).not.toContain('检测 Token 池');
  });

  it('领取步骤失败：错误步骤显示服务端原始错误', () => {
    const connection = makeConnection({
      state: 'authenticated',
      secretPresent: true,
      secure: true,
      baseUrl: 'https://bus.company.test',
    });
    const { host } = renderSection({
      connections: [connection],
      claimSteps: {
        [connection.id]: [
          { connectionId: connection.id, step: 'discover', status: 'done' },
          {
            connectionId: connection.id,
            step: 'provision',
            status: 'error',
            error: '422: 未找到固定生产消费者组 agent-bus',
          },
        ],
      },
    });

    expect(
      host.querySelector('[data-testid="claim-step:provision"]')?.getAttribute('data-status')
    ).toBe('error');
    expect(host.textContent).toContain('未找到固定生产消费者组 agent-bus');
    expect(host.querySelector('[data-testid="claim-step:claim"]')?.getAttribute('data-status')).toBe(
      'pending'
    );
  });

});

describe('describeConnectionOperationError', () => {
  it('区分授权失效 / 服务端 4xx / 服务端 5xx / 网络错误', () => {
    expect(describeConnectionOperationError('读取远程任务失败（HTTP 401）')).toContain(
      '授权已失效，请重新登录'
    );
    expect(describeConnectionOperationError('同步失败（HTTP 403）')).toContain('服务端拒绝请求');
    expect(describeConnectionOperationError('Token 池查询失败（HTTP 500）')).toContain(
      '服务端异常'
    );
    expect(describeConnectionOperationError('fetch failed')).toContain('网络错误');
    expect(describeConnectionOperationError('请先完成用户授权')).toContain(
      '授权已失效，请重新登录'
    );
  });
});
