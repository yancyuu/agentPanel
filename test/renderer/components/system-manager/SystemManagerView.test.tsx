import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getStatusMock,
  getConfigMock,
  updateConfigMock,
  terminalOpenExternalMock,
  fetchTeamsMock,
  ensureSystemManagerMock,
  getTeamDataMock,
  getTeamSessionsMock,
  createLoopSessionMock,
  refreshTeamMessagesHeadMock,
  diagnosticFetchMock,
  getDiagnosticsRuntimeMock,
  openSettingsTabMock,
} = vi.hoisted(() => ({
  getStatusMock: vi.fn(),
  getConfigMock: vi.fn(),
  updateConfigMock: vi.fn(),
  terminalOpenExternalMock: vi.fn(),
  fetchTeamsMock: vi.fn(),
  ensureSystemManagerMock: vi.fn(),
  getTeamDataMock: vi.fn(),
  getTeamSessionsMock: vi.fn(),
  createLoopSessionMock: vi.fn(),
  refreshTeamMessagesHeadMock: vi.fn(),
  diagnosticFetchMock: vi.fn(),
  getDiagnosticsRuntimeMock: vi.fn(),
  openSettingsTabMock: vi.fn(),
}));

const storeState = {
  fetchTeams: fetchTeamsMock,
  refreshTeamMessagesHead: refreshTeamMessagesHeadMock,
  openSettingsTab: openSettingsTabMock,
  teamMessagesByName: {},
  capabilityPacks: [
    {
      packDir: '/repo/.claude/capabilities',
      source: 'project' as const,
      enabled: true,
      warnings: [],
      manifest: {
        schemaVersion: 1 as const,
        id: 'repo-admin-pack',
        name: 'Repo Admin Pack',
        namespace: 'repo',
        version: '1.0.0',
        capabilities: {
          commands: [
            {
              id: 'repo-doctor',
              alias: 'repo-doctor',
              title: 'Repo Doctor',
              scope: ['admin-loop' as const],
              surfaces: ['slash' as const],
              safety: 'read-only' as const,
              prompt: 'commands/repo-doctor.md',
              workflow: 'repo-doctor.md',
            },
          ],
          workflows: [
            {
              id: 'repo-doctor',
              name: 'Repo Doctor',
              description: 'Explain what the repo doctor command checks before it runs.',
              path: 'workflows/repo-doctor.md',
            },
          ],
        },
      },
    },
  ],
  fetchCapabilityPacks: vi.fn(() => Promise.resolve()),
};

vi.mock('@renderer/store', () => {
  const useStore = (selector: (state: typeof storeState) => unknown) => selector(storeState);
  useStore.getState = () => storeState;
  return { useStore };
});

vi.mock('@renderer/api', () => ({
  api: {
    systemManager: {
      getStatus: getStatusMock,
      getConfig: getConfigMock,
      updateConfig: updateConfigMock,
      getDiagnosticsRuntime: getDiagnosticsRuntimeMock,
    },
    teams: {
      ensureSystemManager: ensureSystemManagerMock,
      getData: getTeamDataMock,
      getTeamSessions: getTeamSessionsMock,
      createLoopSession: createLoopSessionMock,
    },
    terminal: {
      openExternal: terminalOpenExternalMock,
    },
  },
}));

import { SystemManagerView } from '@renderer/components/system-manager/SystemManagerView';

function renderSystemManager(): { host: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root };
}

function baseStatus() {
  return {
    displayName: '诊断' as const,
    defaultWorkDir: '/repo',
    selectedWorkDir: '/repo',
    adminWorkDir: '/repo',
    claudeCommand: 'claude' as const,
    localStatus: 'ready' as const,
  };
}

function baseConfig(workDir = '/repo') {
  return {
    schemaVersion: 1 as const,
    selectedWorkDir: workDir,
    updatedAt: '2026-06-05T00:00:00.000Z',
  };
}

function baseTeamData(workDir = '/repo') {
  return {
    teamName: 'system-manager',
    config: {
      teamName: 'system-manager',
      displayName: '诊断',
      projectPath: workDir,
      members: [],
      leadSessionId: 'lead-session',
      sessionHistory: [],
    },
    tasks: [],
    members: [],
    kanbanState: { teamName: 'system-manager', reviewers: [], tasks: {} },
    processes: [],
    isAlive: true,
    bindProject: 'my-project',
    settings: {
      platform_allow_from: { feishu: 'ou_admin' },
      platform_allow_chat: { feishu: 'chat_admin' },
    },
  };
}

function mockAdminLoopRuntime(workDir = '/repo') {
  ensureSystemManagerMock.mockResolvedValue({
    teamName: 'system-manager',
    displayName: '诊断',
    bindProject: 'my-project',
    workDir,
    projectPath: workDir,
    description: '诊断',
    localStatus: 'ready',
    ccConnectProjectStatus: 'bound',
    feishuStatus: 'unbound',
  });
  getTeamDataMock.mockResolvedValue(baseTeamData(workDir));
  getTeamSessionsMock.mockResolvedValue([]);
  createLoopSessionMock.mockResolvedValue({
    session: {
      id: 'loop-session',
      sessionKey: 'loop-session-key',
      title: 'Loop Session',
      updatedAt: '2026-06-05T00:00:00.000Z',
      createdAt: '2026-06-05T00:00:00.000Z',
      active: true,
      live: true,
      historyCount: 0,
      platform: 'bridge',
    },
    reused: false,
    messageSent: true,
  });
  refreshTeamMessagesHeadMock.mockResolvedValue({ changed: false });
  getDiagnosticsRuntimeMock.mockResolvedValue({
    available: true,
    binaryReady: true,
    authReady: true,
    missing: [],
    checkedAt: '2026-06-05T00:00:00.000Z',
  });
}

describe('SystemManagerView', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    diagnosticFetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/system-manager/diagnostics/current')) {
        return Promise.resolve(new Response('null', { status: 200 }));
      }
      if (url.endsWith('/api/system-manager/cleanup/scan')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              scannedAt: '2026-06-05T00:00:00.000Z',
              candidates: [],
              totalBytes: 0,
              totalItems: 0,
              scannedWorkspaces: 1,
              warnings: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      if (url.endsWith('/api/system-manager/diagnostics/run') && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as {
          actionId: string;
          title: string;
        };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'diag-1',
              actionId: request.actionId,
              title: request.title,
              status: 'running',
              sessionKey: 'system-manager:diagnostic:diag-1',
              messageId: 'diagnostic-diag-1',
              startedAt: '2026-06-05T00:00:00.000Z',
            }),
            { status: 202, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    });
    vi.stubGlobal('fetch', diagnosticFetchMock);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('lets the user retry when diagnostics are temporarily unavailable', async () => {
    getStatusMock
      .mockResolvedValueOnce({
        ...baseStatus(),
        localStatus: 'missing-claude',
        error: '未找到可用运行环境',
      })
      .mockResolvedValue(baseStatus());
    mockAdminLoopRuntime();

    const { host, root } = renderSystemManager();
    await act(async () => {
      root.render(<SystemManagerView />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const retry = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('诊断异常 · 重新检测')
    );
    expect(retry).toBeTruthy();

    await act(async () => {
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getStatusMock).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('诊断可用');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders a simple scan page and starts a full-folder diagnostic', async () => {
    getStatusMock.mockResolvedValue(baseStatus());
    getConfigMock.mockResolvedValue(baseConfig());
    updateConfigMock.mockImplementation((patch: { selectedWorkDir?: string }) =>
      Promise.resolve(baseConfig(patch.selectedWorkDir ?? '/repo'))
    );
    mockAdminLoopRuntime();
    fetchTeamsMock.mockResolvedValue(undefined);

    const { host, root } = renderSystemManager();

    await act(async () => {
      root.render(<SystemManagerView />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('header h1')?.textContent).toBe('诊断');
    expect(host.textContent).toContain('点击一次，检查所有数字员工');
    expect(host.textContent).toContain('开始全盘扫描');
    expect(host.textContent).toContain('团队记忆漂移');
    expect(host.textContent).toContain('临时文件扫描');
    expect(host.textContent).toContain('运行环境检查');
    expect(host.textContent).toContain('任务积压检查');
    expect(host.textContent).toContain('扫描结果');
    expect(host.textContent).toContain('还没有扫描结果');
    expect(host.textContent).not.toContain('指令台');
    expect(host.textContent).not.toContain('运维手册');
    expect(host.textContent).not.toContain('设置');
    expect(host.textContent).not.toContain('打开终端');
    expect(ensureSystemManagerMock).toHaveBeenCalled();

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('团队记忆漂移'))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(diagnosticFetchMock).toHaveBeenCalledWith(
      '/api/system-manager/diagnostics/run',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringMatching(/memory-drift[\s\S]*团队记忆漂移/),
      })
    );
    expect(host.textContent).toContain('正在扫描');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('groups cleanup candidates, selects all by default and cleans selected IDs', async () => {
    getStatusMock.mockResolvedValue(baseStatus());
    getConfigMock.mockResolvedValue(baseConfig());
    mockAdminLoopRuntime();
    diagnosticFetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/system-manager/diagnostics/current')) {
        return Promise.resolve(new Response('null', { status: 200 }));
      }
      if (url.endsWith('/api/system-manager/cleanup/scan')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              scannedAt: '2026-06-05T00:00:00.000Z',
              candidates: [
                {
                  id: 'cache-1',
                  category: 'project-cache',
                  categoryLabel: '项目缓存',
                  name: '.vite',
                  path: '/repo/.vite',
                  displayPath: '~/repo/.vite',
                  kind: 'directory',
                  sizeBytes: 4096,
                  itemCount: 3,
                  modifiedAt: '2026-06-01T00:00:00.000Z',
                  reason: '可重新生成的工具缓存',
                  selectedByDefault: true,
                },
              ],
              totalBytes: 4096,
              totalItems: 3,
              scannedWorkspaces: 1,
              warnings: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      if (url.endsWith('/api/system-manager/cleanup') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              cleanedAt: '2026-06-05T00:01:00.000Z',
              removedIds: ['cache-1'],
              failed: [],
              freedBytes: 4096,
              remaining: {
                scannedAt: '2026-06-05T00:01:00.000Z',
                candidates: [],
                totalBytes: 0,
                totalItems: 0,
                scannedWorkspaces: 1,
                warnings: [],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    });
    const { host, root } = renderSystemManager();
    await act(async () => {
      root.render(<SystemManagerView />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('临时文件扫描'))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('项目缓存');
    expect(host.textContent).toContain('.vite');
    expect(host.textContent).toContain('全选 1 项');
    expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('清理选中项'))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(diagnosticFetchMock).toHaveBeenCalledWith(
      '/api/system-manager/cleanup',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ ids: ['cache-1'] }) })
    );
    expect(host.textContent).toContain('已清理 1 项');
    expect(host.textContent).toContain('当前没有需要清理的项目');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('restores an in-progress diagnostic after a browser refresh', async () => {
    getStatusMock.mockResolvedValue(baseStatus());
    mockAdminLoopRuntime();
    diagnosticFetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/system-manager/diagnostics/current')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'diag-running',
              actionId: 'task-health',
              title: '任务积压检查',
              status: 'running',
              sessionKey: 'system-manager:diagnostic:diag-running',
              messageId: 'diagnostic-diag-running',
              startedAt: '2026-06-05T00:00:00.000Z',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(new Response('null', { status: 200 }));
    });

    const { host, root } = renderSystemManager();
    await act(async () => {
      root.render(<SystemManagerView />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('正在扫描');
    expect(host.textContent).toContain('任务积压检查');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('ensures the diagnostics team before loading status and results', async () => {
    const order: string[] = [];
    getStatusMock.mockImplementation(() => {
      order.push('status');
      return Promise.resolve(baseStatus());
    });
    getConfigMock.mockResolvedValue(baseConfig());
    updateConfigMock.mockResolvedValue(baseConfig('/repo'));
    fetchTeamsMock.mockResolvedValue(undefined);

    ensureSystemManagerMock.mockImplementation(() => {
      order.push('ensure');
      return Promise.resolve({
        teamName: 'system-manager',
        displayName: '诊断',
        bindProject: 'my-project',
        workDir: '/repo',
        projectPath: '/repo',
        description: '诊断',
        localStatus: 'ready',
        ccConnectProjectStatus: 'bound',
        feishuStatus: 'bound',
      });
    });
    diagnosticFetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/system-manager/diagnostics/current')) {
        order.push('diagnostic');
        return Promise.resolve(new Response('null', { status: 200 }));
      }
      return Promise.resolve(new Response('null', { status: 200 }));
    });

    const { root } = renderSystemManager();

    await act(async () => {
      root.render(<SystemManagerView />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(order).toEqual(['ensure', 'status', 'diagnostic']);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('Pi 运行时不可用时给出配置引导并禁用扫描', async () => {
    getDiagnosticsRuntimeMock.mockResolvedValue({
      available: false,
      binaryReady: false,
      authReady: false,
      missing: ['未找到 Pi 命令行', 'Pi 未登录配置（缺少 ~/.pi/agent/auth.json）'],
      checkedAt: '2026-06-05T00:00:00.000Z',
    });
    const { host, root } = renderSystemManager();

    await act(async () => {
      root.render(<SystemManagerView />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const banner = host.querySelector('[data-testid="pi-runtime-missing"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('需先配置 Pi 运行时');
    expect(banner?.textContent).toContain('未找到 Pi 命令行');

    const fullScanButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('开始全盘扫描')
    );
    expect(fullScanButton?.disabled).toBe(true);

    const configureButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '去配置'
    );
    expect(configureButton).toBeDefined();
    await act(async () => {
      configureButton!.click();
      await Promise.resolve();
    });
    expect(openSettingsTabMock).toHaveBeenCalledWith('harness');

    act(() => root.unmount());
  });
});
