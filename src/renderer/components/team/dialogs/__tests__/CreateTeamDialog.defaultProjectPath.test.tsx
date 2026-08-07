import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateTeamDialog } from '../CreateTeamDialog';

const apiState = vi.hoisted(() => ({
  projects: [
    {
      id: 'other',
      path: '/Users/test/code/other',
      name: 'other',
      sessions: [],
      totalSessions: 0,
      createdAt: 0,
    },
  ],
}));

vi.mock('@renderer/hooks/useCreateTeamDraft', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');

  return {
    useCreateTeamDraft: () => {
      const [teamName, setTeamName] = ReactActual.useState('recent worker');
      const [cwdMode, setCwdMode] = ReactActual.useState<'project' | 'custom'>('custom');
      const [selectedProjectPath, setSelectedProjectPath] = ReactActual.useState('');
      const [customCwd, setCustomCwd] = ReactActual.useState('/Users/test/code/other');
      const [teamColor, setTeamColor] = ReactActual.useState('');

      return {
        teamName,
        setTeamName,
        cwdMode,
        setCwdMode,
        selectedProjectPath,
        setSelectedProjectPath,
        customCwd,
        setCustomCwd,
        teamColor,
        setTeamColor,
        isLoaded: true,
        clearDraft: () => undefined,
      };
    },
  };
});

vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));
vi.mock('@renderer/lib/utils', () => ({
  cn: (...args: unknown[]): string =>
    args.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0).join(' '),
}));
vi.mock('@renderer/api', () => ({
  api: { getProjects: async () => apiState.projects },
}));
vi.mock('@renderer/api/providers', () => ({
  providersApi: { list: async () => ({ providers: [] }) },
}));
vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
  }) =>
    React.createElement(
      'button',
      { type: 'button', onClick, disabled: Boolean(disabled), 'data-testid': 'button' },
      children
    ),
}));
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
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
vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) =>
    React.createElement('input', {
      id: props.id as string,
      value: (props.value as string) ?? '',
      onChange: props.onChange as React.ChangeEventHandler<HTMLInputElement>,
      'data-testid': props.id,
    }),
}));
vi.mock('@renderer/components/ui/label', () => ({
  Label: ({ children }: { children: React.ReactNode }) =>
    React.createElement('label', null, children),
}));
vi.mock('../../HarnessCards', () => ({ AGENT_TYPE_LABELS: {} as Record<string, string> }));
vi.mock('../../HarnessSelect', () => ({ HarnessSelect: () => React.createElement('div') }));
vi.mock('../ProjectPathSelector', () => ({
  ProjectPathSelector: ({ selectedProjectPath }: { selectedProjectPath: string }) =>
    React.createElement('div', { 'data-testid': 'selected-project-path' }, selectedProjectPath),
}));

function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    open: true,
    canCreate: true,
    provisioningErrorsByTeam: {},
    clearProvisioningError: () => undefined,
    existingTeamNames: [],
    existingBindProjects: [],
    existingDisplayNames: [],
    provisioningTeamNames: [],
    activeTeams: [],
    onClose: () => undefined,
    onCreate: async () => undefined,
    onOpenTeam: () => undefined,
    ...overrides,
  };
}

describe('CreateTeamDialog defaultProjectPath', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses a recent project path for the creation cwd even when it is not in /api/projects', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onCreate = vi.fn(async () => undefined);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          CreateTeamDialog,
          baseProps({
            defaultProjectPath: '/Users/test/code/hermit',
            onCreate,
          }) as never
        )
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="selected-project-path"]')?.textContent).toBe(
      '/Users/test/code/hermit'
    );

    const createButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('创建智能体')
    );
    expect(createButton, 'create button rendered').toBeTruthy();

    await act(async () => {
      createButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/Users/test/code/hermit',
        executionTarget: { type: 'local', cwd: '/Users/test/code/hermit' },
      })
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
