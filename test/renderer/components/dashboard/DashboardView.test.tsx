import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = {
  openChatTab: vi.fn(),
  openSettingsTab: vi.fn(),
  openSystemManager: vi.fn(() => Promise.resolve()),
  openTasksTab: vi.fn(),
  openTeamsTab: vi.fn(),
  teams: [] as { teamName: string }[],
  teamsLoading: false,
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('@features/recent-projects/renderer', () => ({
  RecentProjectsSection: () => <div data-testid="recent-projects">最近项目列表</div>,
}));

import { DashboardView } from '@renderer/components/dashboard/DashboardView';

async function renderDashboard(): Promise<{
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<DashboardView />);
    await Promise.resolve();
  });
  return { host, root };
}

function clickButton(host: HTMLElement, label: string): void {
  const button = Array.from(host.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label)
  );
  expect(button).toBeTruthy();
  button?.click();
}

describe('DashboardView workbench shell', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.teams = [];
    storeState.teamsLoading = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders the semantic workbench header and preserves all primary routes', async () => {
    const { host, root } = await renderDashboard();

    expect(host.querySelector('header h1')?.textContent).toBe('工作台');
    expect(host.textContent).not.toContain('Command Center');
    expect(host.textContent).toContain('快速入口');

    await act(async () => {
      clickButton(host, '打开收件箱');
      clickButton(host, 'Agent');
      clickButton(host, 'Helm Loop');
      clickButton(host, '飞书协作');
      clickButton(host, '配置 Harness');
      await Promise.resolve();
    });

    expect(storeState.openTasksTab).toHaveBeenCalledTimes(1);
    expect(storeState.openTeamsTab).toHaveBeenCalledTimes(1);
    expect(storeState.openSystemManager).toHaveBeenCalledTimes(1);
    expect(storeState.openChatTab).toHaveBeenCalledTimes(1);
    expect(storeState.openSettingsTab).toHaveBeenCalledWith('harness');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps recent projects mounted for an existing workspace', async () => {
    storeState.teams = [{ teamName: 'alpha' }];
    const { host, root } = await renderDashboard();

    expect(host.querySelector('[data-testid="recent-projects"]')).not.toBeNull();
    expect(host.textContent).toContain('最近打开的项目');
    expect(host.textContent).not.toContain('快速开始');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
