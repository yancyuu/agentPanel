import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const selectTask = vi.fn();
const selectMessage = vi.fn();
const selectReferencedTask = vi.fn();
const createTeamTask = vi.fn(() => Promise.resolve({ id: 'task-created' }));
const refreshTasks = vi.fn(() => Promise.resolve());
const approveTask = vi.fn(() => Promise.resolve());
const requestChanges = vi.fn(() => Promise.resolve());
let selectedReviewState: 'review' | 'needsFix' | 'approved' | undefined;
let detailMembers: { name: string; agentId: string }[] = [
  { name: 'alice', agentId: 'agent-alice' },
];
let requestedRecipient: {
  teamName: string;
  memberName: string;
  requestedAt: number;
  initialText?: string;
} | null = null;

vi.mock('@features/collaborative-workbench/renderer/hooks/useCollaborativeInbox', () => ({
  useCollaborativeInbox: () => ({
    view: 'in_progress',
    setView: vi.fn(),
    query: '',
    setQuery: vi.fn(),
    teamFilter: 'all',
    setTeamFilter: vi.fn(),
    ownerFilter: 'all',
    setOwnerFilter: vi.fn(),
    teamOptions: [],
    ownerOptions: [],
    tasks: [],
    messages: [
      {
        key: 'team-a:task-1',
        task: {
          id: 'task-1',
          displayId: 'task-1',
          subject: 'Task one',
          status: selectedReviewState ? 'completed' : 'pending',
          owner: 'alice',
          reviewState: selectedReviewState,
          teamName: 'team-a',
          teamDisplayName: 'Team A',
        },
        latestMessage: {
          id: 'delivery:1',
          author: 'alice',
          text: '需要你补充目标市场',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        unreadCount: 1,
        updatedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      },
    ],
    selectedKey: 'team-a:task-1',
    selectedTask: {
      key: 'team-a:task-1',
      task: {
        id: 'task-1',
        displayId: 'task-1',
        subject: 'Task one',
        status: selectedReviewState ? 'completed' : 'pending',
        owner: 'alice',
        reviewState: selectedReviewState,
        teamName: 'team-a',
        teamDisplayName: 'Team A',
      },
    },
    selectedMessageKey: 'team-a:task-1',
    selectedMessage: {
      key: 'team-a:task-1',
      task: {
        id: 'task-1',
        displayId: 'task-1',
        subject: 'Task one',
        status: selectedReviewState ? 'completed' : 'pending',
        owner: 'alice',
        reviewState: selectedReviewState,
        teamName: 'team-a',
        teamDisplayName: 'Team A',
      },
      latestMessage: {
        id: 'delivery:1',
        author: 'alice',
        text: '需要你补充目标市场',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      unreadCount: 1,
      updatedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    },
    selectTask,
    selectMessage,
    selectReferencedTask,
    loading: false,
    error: null,
    refresh: refreshTasks,
    createTask: createTeamTask,
    updateOwner: vi.fn(() => Promise.resolve()),
    approveTask,
    requestChanges,
  }),
}));

vi.mock('@features/collaborative-workbench/renderer/hooks/useTaskWorkspaceNavigation', () => ({
  useTaskWorkspaceNavigation: () => ({ openTask: vi.fn() }),
}));

vi.mock('@features/collaborative-workbench/renderer/hooks/useInboxTaskRecipients', () => ({
  useInboxTaskRecipients: () => ({
    requestedRecipient,
    recipientOptions: [
      {
        teamName: 'team-a',
        teamDisplayName: 'Team A',
        memberName: 'alice',
      },
      {
        kind: 'squad',
        teamName: 'release-squad',
        teamDisplayName: '小队',
        memberName: '发版小队',
        collaborationTeamSlug: 'release-squad',
        memberCount: 3,
      },
    ],
    navigationRequestAt: requestedRecipient?.requestedAt ?? null,
  }),
}));

vi.mock('@renderer/components/team/dialogs/useGlobalTaskDetailModel', () => ({
  useGlobalTaskDetailModel: () => ({
    task: null,
    taskMap: new Map(),
    members: detailMembers,
    loading: false,
    isFullTeamLoaded: false,
    openTeam: vi.fn(),
    viewChanges: vi.fn(),
  }),
}));

vi.mock('@features/collaborative-workbench/renderer/ui/InboxTaskList', () => ({
  InboxTaskList: ({ onSelect }: { onSelect(key: string): void }) => (
    <button type="button" onClick={() => onSelect('team-a:task-1')}>
      LIST
    </button>
  ),
}));

vi.mock('@features/collaborative-workbench/renderer/ui/TaskReviewThread', () => ({
  TaskReviewThread: () => <div>REVIEW THREAD</div>,
}));

vi.mock('@renderer/components/team/members/AgentTuningDialog', () => ({
  AgentTuningDialog: ({ open, member }: { open: boolean; member?: { name: string } | null }) =>
    open ? <div>{`TUNING ${member?.name ?? ''}`}</div> : null,
}));

// Radix Dialog 走 portal，测试里替换为内联渲染，方便直接用 host 查询表单控件
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@renderer/components/team/dialogs/TaskDetailPanel', () => ({
  TaskDetailPanel: ({
    headerExtra,
    onScrollToTask,
    deliveriesContent,
  }: {
    headerExtra: React.ReactNode;
    onScrollToTask?(taskId: string): void;
    deliveriesContent?: React.ReactNode;
  }) => (
    <div>
      DETAIL
      {headerExtra}
      {deliveriesContent}
      <button type="button" onClick={() => onScrollToTask?.('task-2')}>
        REF
      </button>
    </div>
  ),
}));

import { CollaborativeInboxView } from '../../../src/features/collaborative-workbench/renderer/ui/CollaborativeInboxView';

function buttonByText(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
  selectTask.mockClear();
  selectMessage.mockClear();
  selectReferencedTask.mockClear();
  createTeamTask.mockClear();
  refreshTasks.mockClear();
  approveTask.mockClear();
  requestChanges.mockClear();
  selectedReviewState = undefined;
  detailMembers = [{ name: 'alice', agentId: 'agent-alice' }];
  requestedRecipient = null;
  vi.unstubAllGlobals();
});

describe('CollaborativeInboxView compact navigation', () => {
  it('renders task feedback as an inbox without private-message controls', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView surface="inbox" />);
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="任务反馈列表"]')).not.toBeNull();
    expect(host.textContent).toContain('需要你补充目标市场');
    expect(host.textContent).toContain('DETAIL');
    expect(host.textContent).toContain('调教员工');
    expect(host.textContent).toContain('新建后续任务');
    // 评审区改为邮件线程（deliveriesContent），不再有评论回复框
    expect(host.textContent).toContain('REVIEW THREAD');
    expect(host.textContent).not.toContain('回复当前任务');
    expect(host.textContent).not.toContain('私信');
    expect(host.textContent).not.toContain('写私信');

    act(() => root.unmount());
  });

  it('shows the approve action in tasks mode for a submitted deliverable', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    selectedReviewState = 'review';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView surface="tasks" />);
      await Promise.resolve();
    });

    // tasks 模式 header 同样出现「满意并归档」，与 messages 模式行为一致
    expect(host.textContent).toContain('满意并归档');
    await act(async () => {
      buttonByText(host, '满意并归档').click();
      await Promise.resolve();
    });
    expect(approveTask).toHaveBeenCalledWith('team-a', 'task-1', false);

    act(() => root.unmount());
  });

  it('opens the inbox instead of navigating to an Agent when no owner can be resolved', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    detailMembers = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView surface="tasks" />);
      await Promise.resolve();
    });
    await act(async () => {
      buttonByText(host, 'LIST').click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('打开收件箱');
    expect(host.textContent).not.toContain('打开智能体');

    await act(async () => {
      buttonByText(host, '打开收件箱').click();
      await Promise.resolve();
    });
    expect(selectMessage).toHaveBeenCalledWith('team-a:task-1');

    act(() => root.unmount());
  });

  it('uses human review actions for a submitted deliverable', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    selectedReviewState = 'review';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView surface="inbox" />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('满意并归档');
    // 「需要修改」入口已删除：退回意见在线程回复框里提交
    expect(host.textContent).not.toContain('需要修改');
    expect(host.textContent).toContain('REVIEW THREAD');
    expect(host.textContent).not.toContain('新建后续任务');

    await act(async () => {
      buttonByText(host, '满意并归档').click();
      await Promise.resolve();
    });
    expect(approveTask).toHaveBeenCalledWith('team-a', 'task-1', false);

    act(() => root.unmount());
  });

  it('新建后续任务先弹确认表单：预填标题和描述，取消不创建', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView surface="inbox" />);
      await Promise.resolve();
    });

    // 调教入口不受影响：打开调教对话框且不创建任务
    await act(async () => {
      buttonByText(host, '调教员工').click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('TUNING alice');
    expect(createTeamTask).not.toHaveBeenCalled();

    await act(async () => {
      buttonByText(host, '新建后续任务').click();
      await Promise.resolve();
    });
    const dialog = host.querySelector('[data-testid="follow-up-dialog"]');
    expect(dialog).not.toBeNull();
    const title = dialog?.querySelector<HTMLInputElement>('[data-testid="follow-up-title"]');
    const description = dialog?.querySelector<HTMLTextAreaElement>(
      '[data-testid="follow-up-description"]'
    );
    expect(title?.value).toBe('基于「Task one」继续');
    expect(description?.value).toContain('基于任务 #task-1「Task one」继续：');
    expect(dialog?.textContent).toContain('不会修改当前任务');
    // 停留在收件箱消息列表，不再跳到创建页
    expect(host.querySelector('[aria-label="任务反馈列表"]')).not.toBeNull();

    await act(async () => {
      buttonByText(host, '取消').click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="follow-up-dialog"]')).toBeNull();
    expect(createTeamTask).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('确认后才创建后续任务：空标题禁用创建，创建后回到收件箱', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView surface="inbox" />);
      await Promise.resolve();
    });
    await act(async () => {
      buttonByText(host, '新建后续任务').click();
      await Promise.resolve();
    });
    const dialog = host.querySelector('[data-testid="follow-up-dialog"]');
    const title = dialog?.querySelector<HTMLInputElement>('[data-testid="follow-up-title"]');
    expect(title).not.toBeNull();

    // 标题清空（纯空格）→ 创建按钮禁用
    await act(async () => {
      if (title) setInputValue(title, '   ');
      await Promise.resolve();
    });
    expect(buttonByText(host, '创建并开始').disabled).toBe(true);

    await act(async () => {
      if (title) setInputValue(title, '继续调研 Ozon');
      await Promise.resolve();
    });
    expect(buttonByText(host, '创建并开始').disabled).toBe(false);

    await act(async () => {
      buttonByText(host, '创建并开始').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createTeamTask).toHaveBeenCalledWith('team-a', {
      subject: '继续调研 Ozon',
      description: '基于任务 #task-1「Task one」继续：',
      descriptionTaskRefs: [{ taskId: 'task-1', displayId: 'task-1', teamName: 'team-a' }],
      related: ['task-1'],
      owner: 'alice',
      startImmediately: true,
    });
    expect(host.querySelector('[data-testid="follow-up-dialog"]')).toBeNull();
    expect(host.querySelector('[aria-label="任务反馈列表"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it('keeps selected context when an external action opens task creation', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    requestedRecipient = {
      teamName: 'team-a',
      memberName: 'alice',
      requestedAt: Date.now(),
      initialText: '把选中的分析继续整理成完整报告。',
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView surface="inbox" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('交给 alice');
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      '把选中的分析继续整理成完整报告。'
    );

    act(() => root.unmount());
  });

  it('creates a task for a selected Agent and keeps the task list/detail transition', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView surface="tasks" />);
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('私信');
    expect(host.textContent).not.toContain('写私信');
    expect(buttonByText(host, '任务列表')).toBeTruthy();

    await act(async () => {
      buttonByText(host, '创建任务').click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('交给 alice');

    const subject = host.querySelector<HTMLInputElement>(
      '[placeholder="例如：调研 Ozon 的入驻流程、费用和风险"]'
    );
    expect(subject).not.toBeNull();
    await act(async () => {
      if (subject) setInputValue(subject, '调研 Ozon');
      await Promise.resolve();
    });
    await act(async () => {
      buttonByText(host, '创建并开始').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createTeamTask).toHaveBeenCalledWith('team-a', {
      subject: '调研 Ozon',
      description: undefined,
      owner: 'alice',
      startImmediately: true,
    });
    expect(selectTask).toHaveBeenCalledWith('team-a:task-created');

    await act(async () => {
      buttonByText(host, 'LIST').click();
      await Promise.resolve();
    });
    expect(selectTask).toHaveBeenCalledWith('team-a:task-1');
    expect(buttonByText(host, '返回列表')).toBeTruthy();

    await act(async () => {
      buttonByText(host, 'REF').click();
      await Promise.resolve();
    });
    expect(selectReferencedTask).toHaveBeenCalledWith('task-2');

    act(() => root.unmount());
  });

  it('creates a collaboration run when a squad is selected', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView surface="tasks" />);
      await Promise.resolve();
    });
    await act(async () => {
      buttonByText(host, '创建任务').click();
      await Promise.resolve();
      buttonByText(host, '发版小队').click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('交给小队 · 发版小队');

    const subject = host.querySelector<HTMLInputElement>(
      '[placeholder="例如：调研 Ozon 的入驻流程、费用和风险"]'
    );
    await act(async () => {
      if (subject) setInputValue(subject, '准备发布说明');
      await Promise.resolve();
      buttonByText(host, '创建并开始').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/collaboration/teams/release-squad/runs');
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe('string');
    expect(JSON.parse(typeof requestBody === 'string' ? requestBody : '{}')).toEqual({
      title: '准备发布说明',
    });
    expect(createTeamTask).not.toHaveBeenCalled();
    expect(refreshTasks).toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('passes selected local input files with a newly created task', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView surface="tasks" />);
      await Promise.resolve();
    });
    await act(async () => {
      buttonByText(host, '创建任务').click();
      await Promise.resolve();
    });
    const subject = host.querySelector<HTMLInputElement>(
      '[placeholder="例如：调研 Ozon 的入驻流程、费用和风险"]'
    );
    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]');
    const inputFile = new File(['# 客户资料'], '客户资料.md', { type: 'text/markdown' });

    await act(async () => {
      if (subject) setInputValue(subject, '整理客户资料');
      if (fileInput) {
        Object.defineProperty(fileInput, 'files', { configurable: true, value: [inputFile] });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(host.textContent).toContain('客户资料.md');

    await act(async () => {
      buttonByText(host, '创建并开始').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createTeamTask).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({ subject: '整理客户资料' }),
      [inputFile]
    );
    act(() => root.unmount());
  });
});
