import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

const testState = vi.hoisted(() => {
  const member = {
    name: 'bob',
    status: 'active',
    taskCount: 1,
    currentTaskId: 'task-1',
    lastActiveAt: null,
    messageCount: 0,
    color: 'blue',
    agentType: 'developer',
    role: '开发者',
    providerId: 'anthropic',
  } as ResolvedTeamMember;
  const task = {
    id: 'task-1',
    displayId: 'task-1',
    subject: '完成团队名册',
    description: '保留现有任务能力',
    status: 'in_progress',
    owner: 'bob',
  } as TeamTaskWithKanban;
  const snapshot = {
    teamName: 'team-alpha',
    config: {
      name: 'Alpha 团队',
      description: '协作团队',
      projectPath: '/tmp/team-alpha',
      leadSessionId: null,
      sessionHistory: [],
      projectPathHistory: [],
    },
    members: [member],
    tasks: [task],
    messages: [],
    processes: [],
    platforms: [],
    warnings: [],
    isAlive: true,
  };
  const createTeamTask = vi.fn(() => Promise.resolve(task));
  const closeMemberProfile = vi.fn();
  const noop = vi.fn();
  const asyncNoop = vi.fn(() => Promise.resolve(undefined));
  const store = {
    selectedTeamName: 'team-alpha',
    selectedTeamData: snapshot as typeof snapshot | null,
    selectedTeamLoading: false,
    selectedTeamError: null,
    projects: [],
    repositoryGroups: [],
    teams: [
      {
        teamName: 'team-alpha',
        displayName: 'Alpha 团队',
        description: '协作团队',
        memberCount: 1,
        taskCount: 1,
        lastActivity: null,
        projectPath: '/tmp/team-alpha',
      },
    ],
    teamByName: { 'team-alpha': { displayName: 'Alpha 团队' } },
    activeTabId: null,
    branchByPath: {},
    editorPendingRevealFile: null,
    pendingMemberProfile: null as string | null,
    provisioningErrorByTeam: {},
    launchParamsByTeam: {},
    leadActivityByTeam: {},
    leadContextByTeam: {},
    memberSpawnStatusesByTeam: { 'team-alpha': {} },
    memberSpawnSnapshotsByTeam: { 'team-alpha': undefined },
    teamAgentRuntimeByTeam: { 'team-alpha': undefined },
    sendingMessage: false,
    sendMessageError: null,
    sendMessageWarning: null,
    sendMessageDebugDetails: null,
    lastSendMessageResult: null,
    reviewActionError: null,
    pendingReviewRequest: null,
    fetchSkillsCatalog: asyncNoop,
    mcpFetchInstalled: asyncNoop,
    initTabUIState: noop,
    selectTeam: asyncNoop,
    updateKanban: asyncNoop,
    updateTaskStatus: asyncNoop,
    sendTeamMessage: asyncNoop,
    requestReview: asyncNoop,
    startTaskByUser: asyncNoop,
    createTeamTask,
    deleteTeam: asyncNoop,
    openTeamsTab: noop,
    closeTab: noop,
    restartMember: asyncNoop,
    skipMemberForLaunch: asyncNoop,
    removeMember: asyncNoop,
    updateMemberRole: asyncNoop,
    launchTeam: asyncNoop,
    clearProvisioningError: noop,
    refreshTeamData: asyncNoop,
    refreshTeamMessagesHead: vi.fn(() => Promise.resolve({ feedChanged: false })),
    refreshMemberActivityMeta: asyncNoop,
    syncTeamPendingReplyRefresh: noop,
    selectReviewFile: noop,
    setPendingReviewRequest: noop,
    fetchTeams: asyncNoop,
    closeMemberProfile,
  };
  return { member, task, snapshot, store, createTeamTask, closeMemberProfile };
});

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      aliveList: vi.fn(() => Promise.resolve([])),
      getTeamSessions: vi.fn(() => Promise.resolve([])),
      getSessionDetail: vi.fn(() => Promise.resolve(null)),
      processSend: vi.fn(() => Promise.resolve(undefined)),
      launchTeam: vi.fn(() => Promise.resolve(undefined)),
      stop: vi.fn(() => Promise.resolve(undefined)),
      replaceMembers: vi.fn(() => Promise.resolve(undefined)),
    },
    getSessions: vi.fn(() => Promise.resolve([])),
    terminal: { openExternal: vi.fn(() => Promise.resolve(undefined)) },
  },
}));

vi.mock('@renderer/store', () => {
  const useStore = Object.assign(
    (selector: (state: typeof testState.store) => unknown) => selector(testState.store),
    { getState: () => testState.store }
  );
  return { useStore };
});

vi.mock('@renderer/store/slices/teamSlice', () => ({
  getCurrentProvisioningProgressForTeam: () => undefined,
  isTeamProvisioningActive: () => false,
  selectResolvedMemberForTeamName: (_state: unknown, _teamName: string, memberName: string) =>
    memberName === testState.member.name ? testState.member : null,
  selectResolvedMembersForTeamName: () => [testState.member],
  selectTeamMemberSnapshotsForName: () => [],
}));

vi.mock('@renderer/contexts/useTabUIContext', () => ({ useTabIdOptional: () => null }));
vi.mock('@renderer/hooks/useBranchSync', () => ({ useBranchSync: () => undefined }));
vi.mock('@renderer/components/chat/SessionContextPanel/index', () => ({
  SessionContextPanel: () => null,
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@renderer/components/team/CollapsibleTeamSection', () => ({
  CollapsibleTeamSection: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));
vi.mock('@renderer/components/team/TeamProvisioningBanner', () => ({
  TeamProvisioningBanner: () => null,
}));
vi.mock('@renderer/components/team/CcSessionsSection', () => ({
  CcSessionsSection: () => null,
  buildAllSessionsCsv: () => '',
  buildAllSessionsCsvFilename: () => 'sessions.csv',
  downloadTextFile: () => undefined,
  hasDataRows: () => false,
  isExportPayload: () => false,
}));
vi.mock('@renderer/components/team/ProcessesSection', () => ({ ProcessesSection: () => null }));
vi.mock('@renderer/components/team/loop-console/LoopConsolePanel', () => ({
  LoopConsolePanel: () => null,
}));
vi.mock('@renderer/components/team/messages/MessagesPanel', () => ({ MessagesPanel: () => null }));

vi.mock('@renderer/components/team/members/MemberList', () => ({
  MemberList: ({
    members,
    memberTaskCounts,
    taskMap,
    onMemberClick,
    onAssignTask,
    onOpenTask,
  }: {
    members: ResolvedTeamMember[];
    memberTaskCounts?: Map<string, { pending: number; inProgress: number; completed: number }>;
    taskMap?: Map<string, TeamTaskWithKanban>;
    onMemberClick?: (member: ResolvedTeamMember) => void;
    onAssignTask?: (member: ResolvedTeamMember) => void;
    onOpenTask?: (taskId: string) => void;
  }) => (
    <div data-testid="production-roster">
      <span data-testid="bob-task-count">{memberTaskCounts?.get('bob')?.inProgress ?? -1}</span>
      <span data-testid="task-map-size">{taskMap?.size ?? -1}</span>
      <button type="button" onClick={() => onMemberClick?.(members[0])}>
        打开成员
      </button>
      <button type="button" onClick={() => onAssignTask?.(members[0])}>
        分配任务
      </button>
      <button type="button" onClick={() => onOpenTask?.(testState.task.id)}>
        打开当前任务
      </button>
    </div>
  ),
}));

vi.mock('@renderer/components/team/members/MemberDetailDialog', () => ({
  MemberDetailDialog: ({
    open,
    member,
    onClose,
  }: {
    open: boolean;
    member: ResolvedTeamMember | null;
    onClose: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="成员详情">
        <span>{member?.name}</span>
        <button type="button" onClick={onClose}>
          关闭成员详情
        </button>
      </div>
    ) : null,
}));

vi.mock('@renderer/components/team/dialogs/CreateTaskDialog', () => ({
  CreateTaskDialog: ({
    open,
    defaultOwner,
    onClose,
    onSubmit,
  }: {
    open: boolean;
    defaultOwner: string;
    onClose: () => void;
    onSubmit: (
      subject: string,
      description: string,
      owner?: string,
      blockedBy?: string[],
      related?: string[],
      prompt?: string,
      startImmediately?: boolean,
      descriptionTaskRefs?: { teamName: string; taskId: string }[],
      promptTaskRefs?: { teamName: string; taskId: string }[]
    ) => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="创建任务">
        <span data-testid="default-owner">{defaultOwner}</span>
        <button
          type="button"
          onClick={() =>
            onSubmit(
              '新任务',
              '任务描述',
              defaultOwner,
              ['blocked-task'],
              ['related-task'],
              '执行提示',
              true,
              [{ teamName: 'team-alpha', taskId: 'desc-ref' }],
              [{ teamName: 'team-alpha', taskId: 'prompt-ref' }]
            )
          }
        >
          提交任务
        </button>
        <button type="button" onClick={onClose}>
          取消创建
        </button>
      </div>
    ) : null,
}));

vi.mock('@renderer/components/team/dialogs/EditTeamDialog', () => ({
  EditTeamDialog: () => null,
}));
vi.mock('@renderer/components/team/dialogs/LaunchTeamDialog', () => ({
  LaunchTeamDialog: () => null,
}));
vi.mock('@renderer/components/team/dialogs/PlatformBindingDialog', () => ({
  PlatformBindingDialog: () => null,
}));
vi.mock('@renderer/components/team/dialogs/ReviewDialog', () => ({ ReviewDialog: () => null }));
vi.mock('@renderer/components/team/dialogs/RuntimeConfigDialog', () => ({
  RuntimeConfigDialog: () => null,
}));
vi.mock('@renderer/components/team/dialogs/SendMessageDialog', () => ({
  SendMessageDialog: () => null,
}));
vi.mock('@renderer/components/team/review/ChangeReviewDialog', () => ({
  ChangeReviewDialog: ({ open, taskId }: { open: boolean; taskId?: string }) =>
    open ? <div data-testid="task-review">{taskId}</div> : null,
}));

import { TeamDetailView } from '@renderer/components/team/TeamDetailView';

async function renderView(): Promise<{
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TeamDetailView teamName="team-alpha" />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, root };
}

describe('TeamDetailView member roster interactions', () => {
  beforeEach(() => {
    testState.store.selectedTeamData = testState.snapshot;
    testState.store.pendingMemberProfile = null;
    testState.createTeamTask.mockClear();
    testState.closeMemberProfile.mockReset();
    testState.closeMemberProfile.mockImplementation(() => {
      testState.store.pendingMemberProfile = null;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('opens and closes member detail from the production roster', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const { host, root } = await renderView();

    expect(host.querySelector('[aria-label="成员详情"]')).toBeNull();
    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === '打开成员')
        ?.click();
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="成员详情"]')?.textContent).toContain('bob');

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === '关闭成员详情')
        ?.click();
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="成员详情"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('passes task data into the roster and preserves all create-task request fields', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const { host, root } = await renderView();

    expect(host.querySelector('[data-testid="bob-task-count"]')?.textContent).toBe('1');
    expect(host.querySelector('[data-testid="task-map-size"]')?.textContent).toBe('1');

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === '打开当前任务')
        ?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="task-review"]')?.textContent).toBe('task-1');

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === '分配任务')
        ?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="default-owner"]')?.textContent).toBe('bob');

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === '提交任务')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testState.createTeamTask).toHaveBeenCalledWith('team-alpha', {
      subject: '新任务',
      description: '任务描述',
      descriptionTaskRefs: [{ teamName: 'team-alpha', taskId: 'desc-ref' }],
      owner: 'bob',
      blockedBy: ['blocked-task'],
      related: ['related-task'],
      prompt: '执行提示',
      promptTaskRefs: [{ teamName: 'team-alpha', taskId: 'prompt-ref' }],
      startImmediately: true,
    });
    expect(host.querySelector('[aria-label="创建任务"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('opens a pending member profile after cached members receive team data', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    testState.store.selectedTeamData = null;
    testState.store.pendingMemberProfile = 'bob';
    const { host, root } = await renderView();

    expect(host.querySelector('[aria-label="成员详情"]')).toBeNull();
    expect(testState.closeMemberProfile).not.toHaveBeenCalled();

    testState.store.selectedTeamData = testState.snapshot;
    await act(async () => {
      root.render(<TeamDetailView teamName="team-alpha" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="成员详情"]')?.textContent).toContain('bob');
    expect(testState.closeMemberProfile).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
