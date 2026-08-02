/**
 * Reproduction harness for the user-reported create-team bug:
 *   "输入中文 → 英文自动出 → 团队名称已存在 → 英文框红 → 但还能创建"
 *
 * Static analysis says the symptom (English-box red + create still possible) is
 * impossible in a single render, because `isBindProjectTaken` both red-flags the
 * box AND disables the create button. So the only way the user can see red and
 * still create is a TRANSIENT flicker driven by the background `fetchTeams()`
 * refresh (TeamListView schedules one at +1200ms / +3500ms). These tests pin
 * the dialog's behavior across that refresh with the user's REAL team data.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateTeamDialog } from '../CreateTeamDialog';

// Live, mutable draft state so a test can "type" by mutating teamName between
// rerenders — mirroring how a real user types while a background refresh fires.
const draftState = vi.hoisted(() => ({
  teamName: '',
  customCwd: '/tmp/project',
}));

vi.mock('@renderer/hooks/useCreateTeamDraft', () => ({
  useCreateTeamDraft: () => ({
    teamName: draftState.teamName,
    setTeamName: (v: string) => {
      draftState.teamName = v;
    },
    cwdMode: 'custom' as const,
    setCwdMode: () => undefined,
    selectedProjectPath: '',
    setSelectedProjectPath: () => undefined,
    customCwd: draftState.customCwd,
    setCustomCwd: () => undefined,
    teamColor: '',
    setTeamColor: () => undefined,
    isLoaded: true,
    clearDraft: () => undefined,
  }),
}));

vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));
vi.mock('@renderer/lib/utils', () => ({
  cn: (...args: unknown[]): string =>
    args.filter((a): a is string => typeof a === 'string' && a.length > 0).join(' '),
}));
vi.mock('@renderer/utils/pathNormalize', () => ({ normalizePath: (p: string) => p }));
vi.mock('@shared/utils/ephemeralProjectPath', () => ({ isEphemeralProjectPath: () => false }));
vi.mock('@renderer/api', () => ({ api: { getProjects: async () => [] } }));
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
      { type: 'button', onClick, disabled: Boolean(disabled), 'data-testid': 'btn' },
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
      className: props.className as string,
      placeholder: props.placeholder as string,
      'data-testid': props.id === 'team-bind-project' ? 'bind-project' : props.id,
    }),
}));
vi.mock('@renderer/components/ui/label', () => ({
  Label: ({ children }: { children: React.ReactNode }) =>
    React.createElement('label', null, children),
}));
vi.mock('../../HarnessCards', () => ({ AGENT_TYPE_LABELS: {} as Record<string, string> }));
vi.mock('../../HarnessSelect', () => ({ HarnessSelect: () => React.createElement('div') }));
vi.mock('../ProjectPathSelector', () => ({
  ProjectPathSelector: () => React.createElement('div'),
}));

interface RenderHandle {
  host: HTMLDivElement;
  rerender: (props: Record<string, unknown>) => Promise<void>;
  unmount: () => Promise<void>;
}

async function renderDialog(props: Record<string, unknown>): Promise<RenderHandle> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const renderOnce = async (p: Record<string, unknown>) => {
    await act(async () => {
      root.render(React.createElement(CreateTeamDialog, p as never));
      await Promise.resolve();
    });
  };
  await renderOnce(props);
  return {
    host,
    rerender: (p) => renderOnce(p),
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
    },
  };
}

// The user's REAL team data (read live from ~/.hermit/teams/*/team.json). Kept in sync
// with disk so the regression guard reflects reality, not a stale snapshot — the bug is a
// flicker that only surfaces against the actual collision context the user hits. Note the
// real data even carries non-ASCII bindProjects (汇报/产品经理团队/hermit开发) and a duplicate
// 'my-project'; the auto-slug must stay collision-free against all of it.
const REAL_BIND_PROJECTS = [
  '汇报',
  '产品经理团队',
  'hermit开发',
  '212121-og3z',
  '222-11io',
  'aads-e487',
  'boss-1sxv',
  'my-project',
  'team-2kclb4',
  'team-aztc',
  'team-jcve',
];
const REAL_DISPLAY_NAMES = [
  '汇报',
  '产品经理团队',
  'hermit开发',
  '212121',
  '你好222',
  '测试aads',
  'boss',
  '诊断',
  'my-project',
  '爬虫',
  '呜呜呜欧',
  '测试',
];

const baseProps = (
  existingBindProjects: string[],
  existingDisplayNames: string[]
): Record<string, unknown> => ({
  open: true,
  canCreate: true,
  provisioningErrorsByTeam: {},
  clearProvisioningError: () => undefined,
  existingTeamNames: [],
  existingBindProjects,
  existingDisplayNames,
  provisioningTeamNames: [],
  activeTeams: [],
  onClose: () => undefined,
  onCreate: async () => undefined,
  onOpenTeam: () => undefined,
});

const findCreateButton = (host: HTMLElement): HTMLButtonElement | null =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes('创建智能体')
  ) ?? null;

const bindProjectInput = (host: HTMLElement): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>('[data-testid="bind-project"]');
const nameInput = (host: HTMLElement): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>('#team-name');

describe('CreateTeamDialog — Chinese-name repro (user-reported bug)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    draftState.teamName = '';
    draftState.customCwd = '/tmp/project';
  });

  it('a fresh Chinese name never shows "已存在" and the box is never red', async () => {
    draftState.teamName = '全新员工甲';
    const { host, unmount } = await renderDialog(baseProps(REAL_BIND_PROJECTS, REAL_DISPLAY_NAMES));

    expect(host.textContent).not.toContain('该名称已存在');
    expect(host.textContent).not.toContain('该项目标识已存在');
    expect(bindProjectInput(host)?.className ?? '').not.toContain('field-error-border');
    expect(nameInput(host)?.className ?? '').not.toContain('field-error-border');
    expect(findCreateButton(host)?.disabled).toBe(false);

    await unmount();
  });

  it('does NOT flicker "已存在" when the background refresh repopulates the list', async () => {
    // Frame 1: dialog open, teams not yet loaded (empty list), user already typed.
    draftState.teamName = '全新员工甲';
    const { host, rerender, unmount } = await renderDialog(baseProps([], []));

    expect(host.textContent).not.toContain('该名称已存在');
    expect(host.textContent).not.toContain('该项目标识已存在');
    expect(findCreateButton(host)?.disabled).toBe(false);

    // Frame 2: background fetchTeams() at +1200ms delivers the full real list.
    await rerender(baseProps(REAL_BIND_PROJECTS, REAL_DISPLAY_NAMES));

    expect(host.textContent).not.toContain('该名称已存在');
    expect(host.textContent).not.toContain('该项目标识已存在');
    expect(bindProjectInput(host)?.className ?? '').not.toContain('field-error-border');
    expect(nameInput(host)?.className ?? '').not.toContain('field-error-border');
    expect(findCreateButton(host)?.disabled).toBe(false);

    await unmount();
  });

  it('auto-slug stays collision-free across many distinct Chinese names (no reshuffle red)', async () => {
    const { rerender, host, unmount } = await renderDialog(
      baseProps(REAL_BIND_PROJECTS, REAL_DISPLAY_NAMES)
    );

    for (const name of ['一号员工', '二号员工', '三号员工', '四号员工', '呜呜呜欧']) {
      draftState.teamName = name;
      await rerender(baseProps(REAL_BIND_PROJECTS, REAL_DISPLAY_NAMES));
      expect(host.textContent).not.toContain('该项目标识已存在');
      expect(bindProjectInput(host)?.className ?? '').not.toContain('field-error-border');
    }

    await unmount();
  });
});
