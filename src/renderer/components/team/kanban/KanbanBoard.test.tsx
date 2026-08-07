import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  arrayMove: (items: string[], from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  },
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  verticalListSortingStrategy: vi.fn(),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));

vi.mock('@renderer/components/team/kanban/KanbanTaskCard', () => ({
  KanbanTaskCard: ({
    task,
    columnId,
    onStartTask,
    onCompleteTask,
    onDeleteTask,
  }: {
    task: { id: string; subject: string };
    columnId: string;
    onStartTask: (taskId: string) => void;
    onCompleteTask: (taskId: string) => void;
    onDeleteTask?: (taskId: string) => void;
  }) =>
    React.createElement(
      'article',
      { 'data-testid': `task-${task.id}`, 'data-column-id': columnId },
      React.createElement('h5', null, task.subject),
      React.createElement(
        'button',
        { type: 'button', onClick: () => onStartTask(task.id), 'aria-label': `start ${task.id}` },
        'start'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => onCompleteTask(task.id),
          'aria-label': `complete ${task.id}`,
        },
        'complete'
      ),
      onDeleteTask
        ? React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => onDeleteTask(task.id),
              'aria-label': `delete ${task.id}`,
            },
            'delete'
          )
        : null
    ),
}));

vi.mock('@renderer/components/team/kanban/KanbanFilterPopover', () => ({
  KanbanFilterPopover: ({ onFilterChange }: { onFilterChange: (filter: unknown) => void }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'aria-label': '筛选任务',
        onClick: () =>
          onFilterChange({
            sessionId: null,
            selectedOwners: new Set(),
            columns: new Set(['todo']),
          }),
      },
      'filter'
    ),
}));

vi.mock('@renderer/components/team/kanban/KanbanSortPopover', () => ({
  KanbanSortPopover: ({ onSortChange }: { onSortChange: (sort: { field: string }) => void }) =>
    React.createElement(
      'button',
      { type: 'button', 'aria-label': '任务排序', onClick: () => onSortChange({ field: 'owner' }) },
      'sort'
    ),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    className,
    onClick,
    disabled,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    'aria-label'?: string;
  }) =>
    React.createElement(
      'button',
      { className, onClick, disabled, 'aria-label': ariaLabel, type: 'button' },
      children
    ),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/hooks/useResizableColumns', () => ({
  useResizableColumns: () => ({ widths: new Map(), getHandleProps: () => ({}) }),
}));

import { KanbanBoard } from './KanbanBoard';

import type { KanbanFilterState } from './KanbanFilterPopover';
import type { KanbanSortState } from './KanbanSortPopover';
import type { KanbanState, ResolvedTeamMember, TeamTask } from '@shared/types';

const baseTask = {
  displayId: 'task',
  owner: '',
  reviewer: '',
  changePresence: 'unknown',
  comments: [],
  blockedBy: [],
  blocks: [],
  workIntervals: [],
  historyEvents: [],
  createdAt: '2026-06-14T00:00:00.000Z',
  updatedAt: '2026-06-14T00:00:00.000Z',
} as const;

function makeTask(id: string, subject: string, status: TeamTask['status']): TeamTask {
  return {
    ...baseTask,
    id,
    displayId: id,
    subject,
    status,
  } as unknown as TeamTask;
}

const tasks: TeamTask[] = [
  makeTask('todo-1', 'Seeded TODO task', 'pending'),
  makeTask('doing-1', 'Seeded in-progress task', 'in_progress'),
  makeTask('done-1', 'Seeded done task', 'completed'),
];

const kanbanState: KanbanState = { teamName: 'qa-team', reviewers: [], tasks: {}, columnOrder: {} };
const filter: KanbanFilterState = {
  sessionId: null,
  selectedOwners: new Set(),
  columns: new Set(),
};
const sort: KanbanSortState = { field: 'updatedAt' };
const members: ResolvedTeamMember[] = [];

const noop = (): void => undefined;

function renderBoard(overrides: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const props: React.ComponentProps<typeof KanbanBoard> = {
    tasks,
    teamName: 'qa-team',
    kanbanState,
    filter,
    sort,
    sessions: [],
    members,
    onFilterChange: noop,
    onSortChange: noop,
    onRequestReview: noop,
    onApprove: noop,
    onRequestChanges: noop,
    onMoveBackToDone: noop,
    onStartTask: noop,
    onCompleteTask: noop,
    onCancelTask: noop,
    ...overrides,
  };

  return { host, root, props };
}

describe('KanbanBoard seeded board coverage', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders seeded TODO, in-progress, and done tasks in their columns', async () => {
    const { host, root, props } = renderBoard();

    await act(async () => {
      root.render(React.createElement(KanbanBoard, props));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('TODO');
    expect(host.textContent).toContain('IN PROGRESS');
    expect(host.textContent).toContain('DONE');
    expect(host.textContent).toContain('Seeded TODO task');
    expect(host.textContent).toContain('Seeded in-progress task');
    expect(host.textContent).toContain('Seeded done task');
    expect(host.querySelector('[data-testid="task-todo-1"]')?.getAttribute('data-column-id')).toBe(
      'todo'
    );
    expect(host.querySelector('[data-testid="task-doing-1"]')?.getAttribute('data-column-id')).toBe(
      'in_progress'
    );
    expect(host.querySelector('[data-testid="task-done-1"]')?.getAttribute('data-column-id')).toBe(
      'done'
    );
    expect(host.textContent).not.toContain('No tasks');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('wires task, filter, sort, trash, and view callbacks on a non-empty board', async () => {
    const onStartTask = vi.fn();
    const onCompleteTask = vi.fn();
    const onDeleteTask = vi.fn();
    const onFilterChange = vi.fn();
    const onSortChange = vi.fn();
    const onOpenTrash = vi.fn();
    const { host, root, props } = renderBoard({
      onStartTask,
      onCompleteTask,
      onDeleteTask,
      onFilterChange,
      onSortChange,
      deletedTaskCount: 2,
      onOpenTrash,
    });

    await act(async () => {
      root.render(React.createElement(KanbanBoard, props));
      await Promise.resolve();
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="start todo-1"]')?.click();
      host.querySelector<HTMLButtonElement>('[aria-label="complete done-1"]')?.click();
      host.querySelector<HTMLButtonElement>('[aria-label="delete doing-1"]')?.click();
      host.querySelector<HTMLButtonElement>('[aria-label="筛选任务"]')?.click();
      host.querySelector<HTMLButtonElement>('[aria-label="任务排序"]')?.click();
      host.querySelectorAll<HTMLButtonElement>('button')[2]?.click();
      await Promise.resolve();
    });

    expect(onStartTask).toHaveBeenCalledWith('todo-1');
    expect(onCompleteTask).toHaveBeenCalledWith('done-1');
    expect(onDeleteTask).toHaveBeenCalledWith('doing-1');
    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: null, columns: expect.any(Set) })
    );
    expect(onSortChange).toHaveBeenCalledWith({ field: 'owner' });
    expect(onOpenTrash).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
