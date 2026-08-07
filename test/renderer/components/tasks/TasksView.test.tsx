import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/collaborative-workbench/renderer', () => ({
  CollaborativeInboxView: () => React.createElement('div', null, '协作收件箱内容'),
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

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('TasksView presentation controls', () => {
  it('renders the inbox directly without a redundant workspace tab row', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<TasksView />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('协作收件箱内容');
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.textContent).not.toContain('看板');
    expect(host.textContent).not.toContain('定时任务');

    act(() => root.unmount());
  });
});
