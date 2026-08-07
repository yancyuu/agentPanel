import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@renderer/components/ui/MemberSelect', () => ({
  MemberSelect: ({
    members,
    value,
    onChange,
    placeholder,
  }: {
    members: { name: string }[];
    value: string | null;
    onChange(value: string | null): void;
    placeholder?: string;
  }) => (
    <div>
      <span data-testid="owner-value">{value ?? placeholder ?? ''}</span>
      {members.map((member) => (
        <button key={member.name} type="button" onClick={() => onChange(member.name)}>
          {`选择${member.name}`}
        </button>
      ))}
      <button type="button" onClick={() => onChange(null)}>
        清空负责人
      </button>
    </div>
  ),
}));

vi.mock('@renderer/components/ui/tiptap', () => ({
  TiptapEditor: () => <div />,
}));

vi.mock('@renderer/components/ui/MentionableTextarea', () => ({
  MentionableTextarea: () => <div />,
}));

vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/hooks/useDraftPersistence', () => ({
  useDraftPersistence: () => ({
    value: '',
    setValue: vi.fn(),
    clearDraft: vi.fn(),
    isSaved: false,
  }),
}));

vi.mock('@renderer/hooks/useChipDraftPersistence', () => ({
  useChipDraftPersistence: () => ({
    chips: [],
    setChips: vi.fn(),
    clearChipDraft: vi.fn(),
  }),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ teamDataCacheByName: {}, selectedTeamName: null, selectedTeamData: null }),
}));

import { CreateTaskDialog } from '@renderer/components/team/dialogs/CreateTaskDialog';

import type { ResolvedTeamMember } from '@shared/types';

const member = (name: string): ResolvedTeamMember => ({
  name,
  status: 'active',
  currentTaskId: null,
  taskCount: 0,
  lastActiveAt: null,
  messageCount: 0,
});

function renderDialog(props: {
  members?: ResolvedTeamMember[];
  defaultOwner?: string;
  onSubmit?: (...args: unknown[]) => void;
}): { host: HTMLElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <CreateTaskDialog
        open
        teamName="team-a"
        members={props.members ?? [member('阿尔法团队')]}
        tasks={[]}
        defaultOwner={props.defaultOwner ?? ''}
        onClose={() => undefined}
        onSubmit={props.onSubmit ?? (() => undefined)}
      />
    );
  });
  return { host, root };
}

function buttonByText(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
}

function typeSubject(host: HTMLElement, value: string): void {
  const input = host.querySelector<HTMLInputElement>('#task-subject');
  if (!input) throw new Error('subject input not found');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('CreateTaskDialog 负责人必填', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('无 defaultOwner 时预填成员列表第一个成员，label 为必填语义', () => {
    const { host, root } = renderDialog({});
    expect(host.querySelector('[data-testid="owner-value"]')?.textContent).toBe('阿尔法团队');
    expect(host.textContent).toContain('负责人');
    expect(host.textContent).not.toContain('负责人（可选）');
    expect(host.textContent).not.toContain('请选择负责人后再创建');
    act(() => root.unmount());
  });

  it('defaultOwner 优先于成员列表预填', () => {
    const { host, root } = renderDialog({
      defaultOwner: 'bob',
      members: [member('alice'), member('bob')],
    });
    expect(host.querySelector('[data-testid="owner-value"]')?.textContent).toBe('bob');
    act(() => root.unmount());
  });

  it('负责人为空时禁用创建并显示轻提示', () => {
    const { host, root } = renderDialog({ members: [] });
    expect(host.querySelector('[data-testid="owner-value"]')?.textContent).toBe('选择成员');
    expect(host.textContent).toContain('请选择负责人后再创建');
    expect(buttonByText(host, '创建').disabled).toBe(true);

    // 填了标题仍然禁用
    typeSubject(host, '测试任务');
    expect(buttonByText(host, '创建').disabled).toBe(true);
    act(() => root.unmount());
  });

  it('手动清空后必须重新选择才能提交，重新选择后可用并带 owner 提交', async () => {
    const onSubmit = vi.fn();
    const { host, root } = renderDialog({ onSubmit });

    typeSubject(host, '测试任务');
    expect(buttonByText(host, '创建').disabled).toBe(false);

    // 手动清空 → 禁用 + 轻提示
    act(() => {
      buttonByText(host, '清空负责人').click();
    });
    expect(host.textContent).toContain('请选择负责人后再创建');
    expect(buttonByText(host, '创建').disabled).toBe(true);

    // 重新选择 → 可用；主按钮为显式 accent
    act(() => {
      buttonByText(host, '选择阿尔法团队').click();
    });
    const submitButton = buttonByText(host, '创建');
    expect(submitButton.disabled).toBe(false);
    expect(submitButton.className).toContain('bg-[var(--color-accent)]');
    expect(submitButton.className).toContain('text-white');
    await act(async () => {
      buttonByText(host, '创建').click();
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const args = onSubmit.mock.calls[0] as unknown[];
    expect(args[0]).toBe('测试任务');
    expect(args[2]).toBe('阿尔法团队');
    act(() => root.unmount());
  });

  it('成员列表晚到时自动补预填（用户未手动改动）', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (members: ResolvedTeamMember[]): void => {
      root.render(
        <CreateTaskDialog
          open
          teamName="team-a"
          members={members}
          tasks={[]}
          onClose={() => undefined}
          onSubmit={() => undefined}
        />
      );
    };
    act(() => {
      render([]);
    });
    expect(host.querySelector('[data-testid="owner-value"]')?.textContent).toBe('选择成员');

    act(() => {
      render([member('阿尔法团队')]);
    });
    expect(host.querySelector('[data-testid="owner-value"]')?.textContent).toBe('阿尔法团队');
    act(() => root.unmount());
  });
});
