/**
 * CreateTeamDialog — bindProject (项目标识) invariant tests.
 *
 * Regression guard for the false "该项目标识已存在" red-box flicker. The
 * auto-generated ASCII identifier must be collision-free against
 * `existingBindProjects` in EVERY rendered frame, so:
 *   - the "该项目标识已存在" error never appears for an auto value, and
 *   - the create button is never disabled by a phantom collision.
 *
 * The real `bindProjectSlug` generator is exercised (not mocked) so this
 * validates the dialog ↔ generator integration end to end.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { generateBindProject } from '@renderer/utils/bindProjectSlug';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateTeamDialog } from '../CreateTeamDialog';

// ── Mutable draft state (hoisted so the mocked hook can read it) ────────────
const draftState = vi.hoisted(() => ({
  teamName: '产品助手',
  cwdMode: 'custom' as 'project' | 'custom',
  customCwd: '/tmp/project',
}));

vi.mock('@renderer/hooks/useCreateTeamDraft', () => ({
  useCreateTeamDraft: () => ({
    teamName: draftState.teamName,
    setTeamName: () => undefined,
    cwdMode: draftState.cwdMode,
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

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/lib/utils', () => ({
  cn: (...args: unknown[]): string =>
    args.filter((a): a is string => typeof a === 'string' && a.length > 0).join(' '),
}));

vi.mock('@renderer/utils/pathNormalize', () => ({
  normalizePath: (p: string) => p,
}));

vi.mock('@shared/utils/ephemeralProjectPath', () => ({
  isEphemeralProjectPath: () => false,
}));

vi.mock('@renderer/api', () => ({
  api: { getProjects: async () => [] },
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
      'data-testid': props.id === 'team-bind-project' ? 'bind-project' : undefined,
    }),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({ children }: { children: React.ReactNode }) =>
    React.createElement('label', null, children),
}));

vi.mock('../../HarnessCards', () => ({
  AGENT_TYPE_LABELS: {} as Record<string, string>,
}));

vi.mock('../../HarnessSelect', () => ({
  HarnessSelect: () => React.createElement('div'),
}));

vi.mock('../ProjectPathSelector', () => ({
  ProjectPathSelector: () => React.createElement('div'),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

interface RenderHandle {
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
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
    root,
    rerender: (p) => renderOnce(p),
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
    },
  };
}

const baseProps = (existingBindProjects: string[]): Record<string, unknown> => ({
  open: true,
  canCreate: true,
  provisioningErrorsByTeam: {},
  clearProvisioningError: () => undefined,
  existingTeamNames: [],
  existingBindProjects,
  provisioningTeamNames: [],
  activeTeams: [],
  onClose: () => undefined,
  onCreate: async () => undefined,
  onOpenTeam: () => undefined,
});

const findCreateButton = (host: HTMLElement): HTMLButtonElement | null => {
  const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('button'));
  return buttons.find((b) => b.textContent?.includes('创建智能体')) ?? null;
};

const findBindProjectInput = (host: HTMLElement): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>('[data-testid="bind-project"]');

describe('CreateTeamDialog bindProject invariant', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    draftState.teamName = '产品助手';
    draftState.cwdMode = 'custom';
    draftState.customCwd = '/tmp/project';
  });

  it('auto-generated id is collision-free and never shows "该项目标识已存在"', async () => {
    // Simulate a prior worker that already took the deterministic id for this name.
    const takenId = generateBindProject(draftState.teamName, new Set());
    const expectedNext = generateBindProject(draftState.teamName, new Set([takenId]));

    const { host, unmount } = await renderDialog(baseProps([takenId]));

    const input = findBindProjectInput(host);
    expect(input, 'bind-project input rendered').not.toBeNull();
    expect(input?.value).toBe(expectedNext);
    expect(host.textContent).not.toContain('该项目标识已存在');

    const createBtn = findCreateButton(host);
    expect(createBtn, 'create button rendered').not.toBeNull();
    expect(createBtn?.disabled).toBe(false);

    await unmount();
  });

  it('does NOT flicker "已存在" when the existing list loads after mount', async () => {
    // Teams load asynchronously: dialog first opens with an empty list, then the
    // list populates with an id that collides with the just-generated one. The
    // derived bindProject must jump straight to a free slot in the same render
    // — no transient "已存在" frame is ever produced.
    const { host, rerender, unmount } = await renderDialog(baseProps([]));

    const firstInput = findBindProjectInput(host);
    const firstValue = firstInput?.value ?? '';
    expect(firstValue).toBe(generateBindProject(draftState.teamName, new Set()));
    expect(host.textContent).not.toContain('该项目标识已存在');

    // Now the list populates with exactly the id that was just generated.
    await rerender(baseProps([firstValue]));

    const settledInput = findBindProjectInput(host);
    const expectedAfterLoad = generateBindProject(draftState.teamName, new Set([firstValue]));
    expect(settledInput?.value).toBe(expectedAfterLoad);
    expect(host.textContent).not.toContain('该项目标识已存在');
    expect(findCreateButton(host)?.disabled).toBe(false);

    await unmount();
  });

  it('uses the deterministic id when there is no collision', async () => {
    const { host, unmount } = await renderDialog(baseProps([]));

    const expected = generateBindProject(draftState.teamName, new Set());
    expect(findBindProjectInput(host)?.value).toBe(expected);
    expect(host.textContent).not.toContain('该项目标识已存在');

    await unmount();
  });

  it('blocks create when the display name already exists', async () => {
    const { host, unmount } = await renderDialog({
      ...baseProps([]),
      existingDisplayNames: [draftState.teamName],
    });

    // Same name as an existing worker → red error on the name field, create disabled.
    expect(host.textContent).toContain('该名称已存在，请换一个');
    const nameInput = host.querySelector<HTMLInputElement>('#team-name');
    expect(nameInput?.className).toContain('border-[var(--field-error-border)]');
    expect(findCreateButton(host)?.disabled).toBe(true);

    await unmount();
  });

  it('allows create when the display name is unique', async () => {
    const { host, unmount } = await renderDialog({
      ...baseProps([]),
      existingDisplayNames: ['其他不重名的员工'],
    });

    expect(host.textContent).not.toContain('该名称已存在，请换一个');
    expect(findCreateButton(host)?.disabled).toBe(false);

    await unmount();
  });

  it('does NOT flash "该名称已存在" mid-create when the name lands in the list', async () => {
    // Regression: clicking create updates the parent team list, so the
    // just-created name momentarily appears in existingDisplayNames while the
    // dialog still renders the name step. The duplicate-name red box must stay
    // hidden throughout the in-flight create — no one-frame flicker right
    // before the success screen.
    let resolveCreate: (() => void) | undefined;
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        })
    );

    const { host, rerender, unmount } = await renderDialog({
      ...baseProps([]),
      existingDisplayNames: [],
      onCreate,
    });

    // Click create on a unique name → enters submitting state, onCreate pending.
    const createBtn = findCreateButton(host);
    expect(createBtn, 'create button rendered').not.toBeNull();
    await act(async () => {
      createBtn?.click();
      await Promise.resolve();
    });

    // Button now reads "创建中..." → proves isSubmitting === true mid-create.
    const submittingBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('创建中')
    );
    expect(submittingBtn, 'create entered submitting state').toBeTruthy();

    // Parent now reports the just-created name as existing (store caught up).
    await rerender({
      ...baseProps([]),
      existingDisplayNames: [draftState.teamName],
      onCreate,
    });

    // No flicker: the duplicate-name red box must NOT appear mid-create.
    expect(host.textContent).not.toContain('该名称已存在');

    // Finish the create → success step. setStep('done') is batched with
    // setIsSubmitting(false) inside createLocalTeam's success block, so the
    // name step unmounts atomically: the just-created name (now in the list)
    // never re-renders the name field, and "该名称已存在" never surfaces.
    await act(async () => {
      resolveCreate?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('智能体已创建成功');
    expect(host.textContent).not.toContain('该名称已存在');

    await unmount();
  });

  it('opens the JUST-CREATED team, not a regenerated id, after the list refreshes', async () => {
    // Regression: after create succeeds the parent's fetchTeams() refresh adds
    // the just-created slug to existingBindProjects. The live `bindProject`
    // re-derives (its candidate is now taken) and the numeric-counter fallback
    // landed on an UNRELATED existing team's slug (e.g. "team-2"), so the done
    // step's "打开智能体" button opened the WRONG team. The dialog must capture
    // the slug actually used at creation and open THAT one.
    const createdSlug = generateBindProject(draftState.teamName, new Set());
    // What the live derivation would regenerate to once `createdSlug` is taken:
    // the counter walk lands on "team-2" (an unrelated existing team's slug).
    const regeneratedAfterRefresh = generateBindProject(
      draftState.teamName,
      new Set([createdSlug])
    );
    expect(regeneratedAfterRefresh).not.toBe(createdSlug);

    const onCreate = vi.fn(async () => undefined);
    const onOpenTeam = vi.fn();

    const { host, rerender, unmount } = await renderDialog({
      ...baseProps([]),
      onCreate,
      onOpenTeam,
    });

    // Create the team with the unique auto slug → success step.
    const createBtn = findCreateButton(host);
    expect(createBtn, 'create button rendered').not.toBeNull();
    await act(async () => {
      createBtn?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ teamName: createdSlug }));
    expect(host.textContent).toContain('智能体已创建成功');

    // Parent list refreshes and now reports the just-created slug as existing.
    await rerender({
      ...baseProps([createdSlug]),
      onCreate,
      onOpenTeam,
    });

    // The done step's "open" button must use the captured created slug, not the
    // regenerated counter value that collides with an unrelated existing team.
    const openBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('打开智能体')
    );
    expect(openBtn, 'open button rendered in done step').toBeTruthy();
    await act(async () => {
      openBtn?.click();
      await Promise.resolve();
    });

    expect(onOpenTeam).toHaveBeenCalledTimes(1);
    expect(onOpenTeam.mock.calls[0][0]).toBe(createdSlug);

    await unmount();
  });
});
