import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InboxTaskList } from '../../../src/features/collaborative-workbench/renderer/ui/InboxTaskList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/store', () => {
  const state = {
    globalTasks: [],
    globalTasksLoading: false,
    globalTasksInitialized: true,
    fetchAllTasks: vi.fn(),
    openGlobalTaskDetail: vi.fn(),
  };
  return {
    useStore: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T): T => selector,
}));

vi.mock('@renderer/components/schedules/SchedulesView', () => ({
  SchedulesView: () => React.createElement('div', null, 'Schedules content'),
}));

vi.mock('@renderer/components/team/kanban/KanbanColumn', () => ({
  KanbanColumn: () => React.createElement('div', null, 'Kanban column'),
}));

const mounted: { root: ReturnType<typeof createRoot>; container: HTMLDivElement }[] = [];

function render(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

function press(element: Element, key: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('inbox segment tabs', () => {
  const Harness = (): React.JSX.Element => {
    const [view, setView] = useState<'in_progress' | 'review' | 'completed'>('in_progress');
    return (
      <InboxTaskList
        view={view}
        onViewChange={setView}
        query=""
        onQueryChange={vi.fn()}
        teamFilter="all"
        onTeamFilterChange={vi.fn()}
        ownerFilter="all"
        onOwnerFilterChange={vi.fn()}
        teamOptions={[]}
        ownerOptions={[]}
        tasks={[]}
        selectedKey={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
  };

  it('links segments to their panel and supports arrows, Home, and End', () => {
    const container = render(<Harness />);
    const inProgress = container.querySelector<HTMLElement>('#inbox-segment-tab-in_progress');

    expect(inProgress?.getAttribute('aria-controls')).toBe('inbox-segment-panel-in_progress');
    expect(inProgress?.tabIndex).toBe(0);
    expect(
      container.querySelector('[role="tabpanel"]:not([hidden])')?.getAttribute('aria-labelledby')
    ).toBe('inbox-segment-tab-in_progress');

    press(inProgress!, 'ArrowLeft');
    const completed = container.querySelector<HTMLElement>('#inbox-segment-tab-completed');
    expect(completed?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(completed);
    expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.id).toBe(
      'inbox-segment-panel-completed'
    );

    press(completed!, 'Home');
    expect(inProgress?.getAttribute('aria-selected')).toBe('true');
    press(inProgress!, 'End');
    expect(completed?.getAttribute('aria-selected')).toBe('true');
  });
});
