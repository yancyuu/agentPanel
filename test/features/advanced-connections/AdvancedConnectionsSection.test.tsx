import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdvancedConnectionsSection } from '@features/advanced-connections/renderer/ui/AdvancedConnectionsSection';

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
        catalogStatus={{}}
        catalogs={{}}
        channelStatus={{}}
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
});
