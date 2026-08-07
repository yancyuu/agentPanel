import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── API mock ──────────────────────────────────────────────────
vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      updateConfig: vi.fn(async () => {}),
    },
    ccSettings: {
      restart: vi.fn(async () => {}),
    },
  },
}));

// ── Store mock ────────────────────────────────────────────────
const mockFetchTeams = vi.fn(async () => {});
const mockSelectTeam = vi.fn(async () => {});

const mockStoreState: Record<string, unknown> = {
  selectedTeamName: 'test-team',
  selectedTeamData: {
    teamName: 'test-team',
    config: {
      name: 'Test Team',
      description: 'A test team',
      color: 'blue',
      agentType: 'claude',
      projectPath: '/tmp/project',
      permissionMode: 'default',
      language: 'zh',
      showContextIndicator: true,
      replyFooter: true,
      injectSender: false,
      managedSources: '*',
      disabledCommands: [],
      platformAllowFrom: {},
    },
    settings: {},
    providerRefs: [],
    globalProviders: [],
    isAlive: true,
    tasks: [],
  },
  provisioningProgressByTeam: {},
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockStoreState),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  isTeamProvisioningActive: () => false,
  selectResolvedMembersForTeamName: () => [],
  getCurrentProvisioningProgressForTeam: () => null,
}));

// ── UI component mocks ────────────────────────────────────────
vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => React.createElement('button', { onClick, disabled }, children),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? React.createElement('div', null, children) : null),
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: () => React.createElement('input', { type: 'checkbox' }),
}));

vi.mock('@renderer/components/team/HarnessCards', () => ({
  AGENT_TYPE_LABELS: { claude: 'Claude', cursor: 'Cursor' },
}));

vi.mock('@renderer/components/team/HarnessSelect', () => ({
  HarnessSelect: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) =>
    React.createElement(
      'select',
      {
        value,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value),
        'data-testid': 'harness-select',
      },
      React.createElement('option', { value: 'claude' }, 'Claude'),
      React.createElement('option', { value: 'cursor' }, 'Cursor')
    ),
}));

import { EditTeamDialog } from '@renderer/components/team/dialogs/EditTeamDialog';
import { api } from '@renderer/api';

describe('EditTeamDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    // Reset mock store state
    mockStoreState.selectedTeamName = 'test-team';
    mockStoreState.selectedTeamData = {
      teamName: 'test-team',
      config: {
        name: 'Test Team',
        description: 'A test team',
        color: 'blue',
        agentType: 'claude',
        projectPath: '/tmp/project',
        permissionMode: 'default',
        language: 'zh',
        showContextIndicator: true,
        replyFooter: true,
        injectSender: false,
        managedSources: '*',
        disabledCommands: [],
        platformAllowFrom: {},
      },
      settings: {},
      providerRefs: [],
      globalProviders: [],
      isAlive: true,
      tasks: [],
    };
    mockStoreState.provisioningProgressByTeam = {};
  });

  function mountDialog(props?: {
    onDeleteTeam?: () => void;
    teamName?: string;
  }): { host: HTMLDivElement; root: ReturnType<typeof createRoot> } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: props?.teamName ?? 'test-team',
          onClose: vi.fn(),
          onDeleteTeam: props?.onDeleteTeam,
        })
      );
    });

    return { host, root };
  }

  it('renders with team name and description from store', () => {
    const { host, root } = mountDialog();

    const nameInput = host.querySelector('#edit-team-name') as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    expect(nameInput?.value).toBe('Test Team');

    const descTextarea = host.querySelector('#edit-team-description') as HTMLTextAreaElement | null;
    expect(descTextarea).not.toBeNull();
    expect(descTextarea?.value).toBe('A test team');

    act(() => root.unmount());
  });

  it('does not render the migrated Loop 动态设置 section', () => {
    const { host, root } = mountDialog();

    // Loop 动态设置 migrated to RuntimeConfigDialog (#21) — these controls must
    // no longer appear in the basic edit dialog.
    expect(host.textContent).not.toContain('Loop 动态设置');
    expect(host.textContent).not.toContain('飞书私聊权限');
    expect(host.textContent).not.toContain('上下文指示');
    expect(host.textContent).not.toContain('注入发送者');

    act(() => root.unmount());
  });

  it('allows editing the team name', () => {
    const { host, root } = mountDialog();

    const nameInput = host.querySelector('#edit-team-name') as HTMLInputElement;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(nameInput, 'New Team Name');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(nameInput.value).toBe('New Team Name');

    act(() => root.unmount());
  });

  it('preserves unsaved edits when store data refreshes while open', () => {
    const { host, root } = mountDialog();

    const nameInput = host.querySelector('#edit-team-name') as HTMLInputElement;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(nameInput, 'Unsaved Name');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Simulate store data refresh (name stays same, but config object changes)
    act(() => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'test-team',
          onClose: vi.fn(),
        })
      );
    });

    // Name should remain the unsaved value (not reset)
    const updatedInput = host.querySelector('#edit-team-name') as HTMLInputElement;
    expect(updatedInput.value).toBe('Unsaved Name');

    act(() => root.unmount());
  });

  it('calls updateConfig on save', async () => {
    const onClose = vi.fn();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'test-team',
          onClose,
        })
      );
      await Promise.resolve();
    });

    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === '保存'
    );
    expect(saveButton).not.toBeNull();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.teams.updateConfig).toHaveBeenCalledWith(
      'test-team',
      expect.objectContaining({ name: 'Test Team' })
    );
    const savedPayload =
      (vi.mocked(api.teams.updateConfig).mock.calls.at(-1)?.[1] as Record<string, unknown>) ?? {};
    // Loop 动态设置 migrated to RuntimeConfigDialog — EditTeamDialog must not
    // re-send these fields (#21).
    expect(savedPayload).not.toHaveProperty('language');
    expect(savedPayload).not.toHaveProperty('managedSources');
    expect(savedPayload).not.toHaveProperty('showContextIndicator');
    expect(savedPayload).not.toHaveProperty('replyFooter');
    expect(savedPayload).not.toHaveProperty('injectSender');
    expect(savedPayload).not.toHaveProperty('platformAllowFrom');
    expect(api.ccSettings.restart).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('blocks saving when team name is empty', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'test-team',
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const nameInput = host.querySelector('#edit-team-name') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(nameInput, '');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === '保存'
    ) as HTMLButtonElement | undefined;
    expect(saveButton?.disabled).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows error when save fails', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.updateConfig).mockRejectedValueOnce(new Error('network error'));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'test-team',
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === '保存'
    );

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('network error');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('calls onDeleteTeam when delete button is clicked', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onDeleteTeam = vi.fn();
    const { host, root } = mountDialog({ onDeleteTeam });

    const deleteButton = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('删除项目')
    );
    expect(deleteButton).not.toBeNull();

    await act(async () => {
      deleteButton?.click();
      // Flush the setTimeout(0) used for delete
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(onDeleteTeam).toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('does not show delete button for default team', () => {
    const { host, root } = mountDialog({ teamName: 'default' });

    const deleteButton = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('删除项目')
    );
    expect(deleteButton).toBeUndefined();

    act(() => root.unmount());
  });
});
