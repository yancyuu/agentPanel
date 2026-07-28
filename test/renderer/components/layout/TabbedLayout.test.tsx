import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Tab } from '@renderer/types/tabs';

interface TestPane {
  id: string;
  widthFraction: number;
  activeTabId: string;
  tabs: Tab[];
}

const actions = {
  openTasksTab: vi.fn(),
  openDashboard: vi.fn(),
  openTeamsTab: vi.fn(),
  openSchedulesTab: vi.fn(),
  openExtensionsTab: vi.fn(),
  openNotificationsTab: vi.fn(),
  openSystemManager: vi.fn(() => Promise.resolve()),
  openSettingsTab: vi.fn(),
  openCommandPalette: vi.fn(),
  openChatTab: vi.fn(),
};

const storeState: {
  paneLayout: { focusedPaneId: string; panes: TestPane[] };
  activeTabId: string;
  unreadCount: number;
} & typeof actions = {
  paneLayout: {
    focusedPaneId: 'pane-1',
    panes: [
      {
        id: 'pane-1',
        widthFraction: 1,
        activeTabId: 'tasks-tab',
        tabs: [{ id: 'tasks-tab', type: 'tasks', label: '收件箱', createdAt: 1 }],
      },
    ],
  },
  activeTabId: 'tasks-tab',
  unreadCount: 2,
  ...actions,
};

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: class PointerSensor {
    readonly mocked = true;
  },
  pointerWithin: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock('@renderer/hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: vi.fn(),
}));

vi.mock('@renderer/store', () => {
  const useStore = (selector: (state: typeof storeState) => unknown) => selector(storeState);
  useStore.getState = () => storeState;
  return { useStore };
});

vi.mock('@renderer/components/common/CliInstallWarningBanner', () => ({
  CliInstallWarningBanner: () => <div data-testid="cli-warning" />,
}));
vi.mock('@renderer/components/common/GlobalProviderStatusHeader', () => ({
  GlobalProviderStatusHeader: () => <div data-testid="provider-status" />,
}));
vi.mock('@renderer/components/common/WorkspaceIndicator', () => ({
  WorkspaceIndicator: () => <div data-testid="workspace-indicator" />,
}));
vi.mock('@renderer/components/search/CommandPalette', () => ({
  CommandPalette: () => <div data-testid="command-palette" />,
}));
vi.mock('@renderer/components/team/dialogs/GlobalTaskDetailDialog', () => ({
  GlobalTaskDetailDialog: () => <div data-testid="task-detail-dialog" />,
}));
vi.mock('@renderer/components/layout/PaneContainer', () => ({
  PaneContainer: () => <main data-testid="pane-container" />,
}));
vi.mock('@renderer/components/layout/Sidebar', () => ({
  Sidebar: () => <aside data-testid="workspace-sidebar" />,
}));
vi.mock('@renderer/components/layout/SortableTab', () => ({
  DragOverlayTab: () => <div data-testid="drag-overlay-tab" />,
}));
vi.mock('@renderer/components/layout/TabBarRow', () => ({
  TabBarRow: () => <header data-testid="tab-bar-row" />,
}));

import { TabbedLayout } from '@renderer/components/layout/TabbedLayout';

async function renderLayout() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TabbedLayout />);
    await Promise.resolve();
  });
  return { host, root };
}

describe('TabbedLayout', () => {
  beforeEach(() => {
    storeState.activeTabId = 'tasks-tab';
    storeState.paneLayout.panes[0] = {
      id: 'pane-1',
      widthFraction: 1,
      activeTabId: 'tasks-tab',
      tabs: [{ id: 'tasks-tab', type: 'tasks', label: '收件箱', createdAt: 1 }],
    };
    Object.values(actions).forEach((action) => action.mockClear());
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('keeps the tab/pane shell and all global overlays while adding persistent navigation', async () => {
    const { host, root } = await renderLayout();

    expect(host.querySelector('[aria-label="主导航"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="tab-bar-row"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pane-container"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="command-palette"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="task-detail-dialog"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="workspace-indicator"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="workspace-sidebar"]')).toBeNull();

    host
      .querySelector<HTMLButtonElement>('button[aria-label="数字员工"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(actions.openTeamsTab).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps Inbox active when the no-tab fallback is visible', async () => {
    storeState.activeTabId = '';
    storeState.paneLayout.panes[0] = {
      id: 'pane-1',
      widthFraction: 1,
      activeTabId: '',
      tabs: [],
    };

    const { host, root } = await renderLayout();

    expect(host.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('收件箱');
    expect(actions.openTasksTab).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('preserves the team-only WorkspaceBrowser sidebar behavior', async () => {
    storeState.activeTabId = 'team-tab';
    storeState.paneLayout.panes[0] = {
      id: 'pane-1',
      widthFraction: 1,
      activeTabId: 'team-tab',
      tabs: [
        {
          id: 'team-tab',
          type: 'team',
          teamName: '研发团队',
          label: '研发团队',
          createdAt: 1,
        },
      ],
    };

    const { host, root } = await renderLayout();
    expect(host.querySelector('[data-testid="workspace-sidebar"]')).not.toBeNull();
    expect(host.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(
      '数字员工'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
