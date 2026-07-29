import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const selectTask = vi.fn();
const selectReferencedTask = vi.fn();
const selectThread = vi.fn();

vi.mock('@features/collaborative-workbench/renderer/hooks/useCollaborativeInbox', () => ({
  useCollaborativeInbox: () => ({
    view: 'inbox',
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
    selectedKey: 'team-a:task-1',
    selectedTask: {
      key: 'team-a:task-1',
      task: {
        id: 'task-1',
        subject: 'Task one',
        status: 'pending',
        teamName: 'team-a',
        teamDisplayName: 'Team A',
      },
    },
    selectTask,
    selectReferencedTask,
    loading: false,
    error: null,
    refresh: vi.fn(),
    updateOwner: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@features/collaborative-workbench/renderer/hooks/useInboxThreads', () => ({
  useInboxThreads: () => ({
    threads: [
      {
        key: 'team-a:conversation-1',
        teamName: 'team-a',
        teamDisplayName: 'Team A',
        participant: 'alice',
        conversationId: 'conversation-1',
        subject: 'Hello',
        preview: 'Reply',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [],
        unread: true,
        draft: false,
      },
    ],
    selectedThread: {
      key: 'team-a:conversation-1',
      teamName: 'team-a',
      teamDisplayName: 'Team A',
      participant: 'alice',
      conversationId: 'conversation-1',
      subject: 'Hello',
      preview: 'Reply',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messages: [],
      unread: true,
      draft: false,
    },
    selectedKey: 'team-a:conversation-1',
    query: '',
    setQuery: vi.fn(),
    teamFilter: 'all',
    setTeamFilter: vi.fn(),
    teamOptions: [],
    selectThread,
    refresh: vi.fn(),
    loading: false,
    members: [],
    sending: false,
    sendError: null,
    sendWarning: null,
    sendDebugDetails: null,
    lastResult: null,
    navigationRequestAt: null,
    sendMessage: vi.fn(),
  }),
}));

vi.mock('@renderer/components/team/dialogs/useGlobalTaskDetailModel', () => ({
  useGlobalTaskDetailModel: () => ({
    task: null,
    taskMap: new Map(),
    members: [],
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

vi.mock('@features/collaborative-workbench/renderer/ui/InboxThreadList', () => ({
  InboxThreadList: ({ onSelect }: { onSelect(key: string): void }) => (
    <button type="button" onClick={() => onSelect('team-a:conversation-1')}>
      MAIL LIST
    </button>
  ),
}));

vi.mock('@features/collaborative-workbench/renderer/ui/InboxThreadDetail', () => ({
  InboxThreadDetail: ({ onBack }: { onBack(): void }) => (
    <div>
      MAIL DETAIL
      <button type="button" onClick={onBack}>
        MAIL BACK
      </button>
    </div>
  ),
}));

vi.mock('@renderer/components/team/dialogs/TaskDetailPanel', () => ({
  TaskDetailPanel: ({
    headerExtra,
    onScrollToTask,
  }: {
    headerExtra: React.ReactNode;
    onScrollToTask?(taskId: string): void;
  }) => (
    <div>
      DETAIL
      {headerExtra}
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

afterEach(() => {
  document.body.innerHTML = '';
  selectTask.mockClear();
  selectReferencedTask.mockClear();
  selectThread.mockClear();
  vi.unstubAllGlobals();
});

describe('CollaborativeInboxView compact navigation', () => {
  it('uses an explicit list/detail transition and resolves referenced tasks', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborativeInboxView />);
      await Promise.resolve();
    });

    expect(buttonByText(host, 'MAIL LIST')).toBeTruthy();

    await act(async () => {
      buttonByText(host, 'MAIL LIST').click();
      await Promise.resolve();
    });
    expect(selectThread).toHaveBeenCalledWith('team-a:conversation-1');
    expect(buttonByText(host, 'MAIL BACK')).toBeTruthy();

    await act(async () => {
      buttonByText(host, 'MAIL BACK').click();
      buttonByText(host, '任务').click();
      await Promise.resolve();
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

    await act(async () => {
      buttonByText(host, '返回列表').click();
      await Promise.resolve();
    });
    expect(buttonByText(host, 'LIST')).toBeTruthy();

    act(() => root.unmount());
  });
});
