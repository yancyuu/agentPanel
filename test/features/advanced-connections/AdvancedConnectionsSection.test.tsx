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

function renderSection(props: {
  connections: AdvancedConnectionSummary[];
  onStartAuth?: (connection: AdvancedConnectionSummary) => void;
  onAllowInsecure?: (connectionId: string) => void;
  busyAction?: string | null;
  channelStatus?: Parameters<typeof AdvancedConnectionsSection>[0]['channelStatus'];
  catalogStatus?: Parameters<typeof AdvancedConnectionsSection>[0]['catalogStatus'];
}): { host: HTMLElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
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
        catalogs={{}}
        channelStatus={props.channelStatus ?? {}}
        onHostChange={vi.fn()}
        onDiscover={vi.fn()}
        onAddConnection={vi.fn()}
        onRemoveConnection={vi.fn()}
        onStartAuth={props.onStartAuth ?? vi.fn()}
        onLogout={vi.fn()}
        onAllowInsecure={props.onAllowInsecure ?? vi.fn()}
        onSyncConnection={vi.fn()}
        onPullRemoteTasks={vi.fn()}
        onCheckTokenCatalog={vi.fn()}
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
    expect(syncButtons).toHaveLength(2);
    expect(pullButtons).toHaveLength(2);
    expect(syncButtons[0]?.disabled).toBe(false);
    expect(pullButtons[0]?.disabled).toBe(false);
    expect(syncButtons[1]?.disabled).toBe(true);
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
