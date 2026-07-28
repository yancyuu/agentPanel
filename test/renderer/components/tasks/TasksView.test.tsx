import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/collaborative-workbench/renderer', () => ({
  CollaborativeInboxView: () => React.createElement('div', null, '协作收件箱内容'),
  WorkbenchPageHeader: ({ title }: { title: string }) => React.createElement('h1', null, title),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      globalTasks: [],
      globalTasksLoading: false,
      globalTasksInitialized: true,
      fetchAllTasks: vi.fn(),
      openGlobalTaskDetail: vi.fn(),
    }),
}));

vi.mock('@renderer/components/schedules/SchedulesView', () => ({
  SchedulesView: () => React.createElement('div', null, '定时任务内容'),
}));

vi.mock('@renderer/components/team/kanban/KanbanColumn', () => ({
  KanbanColumn: ({ children }: { children: React.ReactNode }) =>
    React.createElement('section', null, children),
}));

import { TasksView } from '@renderer/components/tasks/TasksView';

function buttonByText(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('TasksView presentation controls', () => {
  it('defaults to Inbox and keeps Kanban and scheduled work accessible', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<TasksView />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('协作收件箱内容');
    expect(buttonByText(host, '收件箱')).toBeTruthy();
    expect(buttonByText(host, '看板')).toBeTruthy();
    expect(buttonByText(host, '定时任务')).toBeTruthy();

    await act(async () => {
      buttonByText(host, '看板').click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('暂无 Loop 任务');

    await act(async () => {
      buttonByText(host, '定时任务').click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('定时任务内容');

    act(() => root.unmount());
  });
});
