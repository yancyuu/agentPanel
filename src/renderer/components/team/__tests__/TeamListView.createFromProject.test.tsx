import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { emitCreateTeamFromProjectIntent } from '@renderer/utils/openHermitEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({
  teams: [] as Record<string, unknown>[],
  teamsLoading: false,
  teamsError: null as string | null,
  fetchTeams: vi.fn(async () => undefined),
  openTeamTab: vi.fn(),
  openSystemManager: vi.fn(),
  deleteTeam: vi.fn(async () => ({ restartRequired: false })),
  restoreTeam: vi.fn(async () => undefined),
  permanentlyDeleteTeam: vi.fn(async () => undefined),
  projects: [],
  globalTasks: [],
  fetchAllTasks: vi.fn(async () => undefined),
  repositoryGroups: [],
  selectedRepositoryId: null,
  selectedWorktreeId: null,
  selectedProjectId: null,
  activeProjectId: null,
  branchByPath: {},
  createTeam: vi.fn(async () => undefined),
  launchTeam: vi.fn(async () => undefined),
  provisioningErrorByTeam: {},
  clearProvisioningError: vi.fn(),
  provisioningRuns: {},
  provisioningSnapshotByTeam: {},
  currentProvisioningRunIdByTeam: {},
  leadActivityByTeam: {},
}));

vi.mock('@renderer/store', () => {
  const useStore = (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState;
  useStore.getState = () => storeState;
  useStore.setState = (patch: Partial<typeof storeState>) => Object.assign(storeState, patch);
  return { useStore };
});

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      aliveList: vi.fn(async () => []),
      getData: vi.fn(async () => ({ config: { description: '', color: '' }, members: [] })),
      deleteDraft: vi.fn(async () => undefined),
      listTemplateSources: vi.fn(async () => ({ sources: [], templates: [] })),
      refreshTemplateSources: vi.fn(async () => ({ sources: [], templates: [] })),
      saveTemplateSources: vi.fn(async (sources) => ({ sources, templates: [] })),
    },
    ccSettings: { restart: vi.fn(async () => undefined) },
  },
}));

vi.mock('@features/recent-projects/renderer', () => ({
  recordRecentProjectOpenPaths: vi.fn(),
}));
vi.mock('@renderer/components/common/ConfirmDialog', () => ({ confirm: vi.fn(async () => false) }));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));
vi.mock('@renderer/hooks/useBranchSync', () => ({ useBranchSync: () => undefined }));
vi.mock('@renderer/lib/utils', () => ({
  cn: (...args: unknown[]): string =>
    args.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0).join(' '),
}));
vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('button', { ...props, type: 'button' }, children),
}));
vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: React.PropsWithChildren) => React.createElement('span', null, children),
}));
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? React.createElement(React.Fragment, null, children) : null,
  DialogContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
}));
vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => React.createElement('input', props),
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  TooltipProvider: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock('../dialogs/CreateTeamDialog', () => ({
  CreateTeamDialog: ({
    open,
    defaultProjectPath,
  }: {
    open: boolean;
    defaultProjectPath?: string | null;
  }) =>
    open
      ? React.createElement(
          'div',
          { 'data-testid': 'create-team-dialog' },
          defaultProjectPath ?? ''
        )
      : null,
}));
vi.mock('../dialogs/LaunchTeamDialog', () => ({
  LaunchTeamDialog: ({ open, teamName }: { open: boolean; teamName: string }) =>
    open ? React.createElement('div', { 'data-testid': 'launch-team-dialog' }, teamName) : null,
}));
vi.mock('../TeamEmptyState', () => ({
  TeamEmptyState: ({ onCreateTeam }: { onCreateTeam: () => void }) =>
    React.createElement('button', { type: 'button', onClick: onCreateTeam }, 'empty-create'),
}));
vi.mock('../TeamListFilterPopover', () => ({
  EMPTY_TEAM_FILTER: { selectedStatuses: new Set() },
  TeamListFilterPopover: () => null,
}));

import { TeamListView } from '../TeamListView';

describe('TeamListView collaboration roster entry points', () => {
  beforeEach(() => {
    storeState.teams = [];
    storeState.globalTasks = [];
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens the create team dialog with the clicked recent project path', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TeamListView));
      await Promise.resolve();
    });

    await act(async () => {
      emitCreateTeamFromProjectIntent('/Users/test/code/hermit');
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="create-team-dialog"]')?.textContent).toBe(
      '/Users/test/code/hermit'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps template, team open, and launch actions independently usable', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.teams = [
      {
        teamName: 'alpha-team',
        displayName: 'Alpha 团队',
        description: '负责产品交付',
        color: 'blue',
        memberCount: 2,
        taskCount: 1,
        lastActivity: null,
        projectPath: '/Users/test/code/alpha',
        members: [
          { name: 'lead', role: 'architect' },
          { name: 'worker', role: 'developer' },
        ],
      },
    ];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TeamListView));
      await Promise.resolve();
    });

    const templateButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('从模板创建')
    );
    expect(templateButton).toBeTruthy();
    await act(async () => templateButton?.click());
    expect(host.textContent).toContain('从模板创建数字员工');

    const launchButton = host.querySelector<HTMLButtonElement>(
      '[aria-label="启动 Agent Alpha 团队"]'
    );
    expect(launchButton).toBeTruthy();
    await act(async () => {
      launchButton?.click();
      await Promise.resolve();
    });
    expect(storeState.openTeamTab).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="launch-team-dialog"]')?.textContent).toBe(
      'alpha-team'
    );

    const openButton = host.querySelector<HTMLButtonElement>(
      '[aria-label="打开 Agent Alpha 团队"]'
    );
    await act(async () => openButton?.click());
    expect(storeState.openTeamTab).toHaveBeenCalledWith('alpha-team', '/Users/test/code/alpha');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
