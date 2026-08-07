import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Schedule } from '@shared/types';

const activeSchedule = {
  id: 'schedule-active',
  name: '每日巡检',
  teamName: 'alpha',
  status: 'active',
  nextRunAt: '2026-07-23T09:00:00.000Z',
} as unknown as Schedule;
const pausedSchedule = {
  id: 'schedule-paused',
  name: '周报',
  teamName: 'beta',
  status: 'paused',
  nextRunAt: null,
} as unknown as Schedule;

const storeState = {
  schedules: [pausedSchedule, activeSchedule],
  schedulesLoading: false,
  fetchSchedules: vi.fn(() => Promise.resolve()),
  openTeamTab: vi.fn(),
  teamByName: {
    alpha: { displayName: 'Alpha 团队', color: 'blue' },
    beta: { displayName: 'Beta 团队', color: 'green' },
  },
};
const calendarPropsMock = vi.fn();
const dialogPropsMock = vi.fn();

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('@renderer/components/schedules/calendar', () => ({
  ScheduleCalendarBoard: (props: {
    schedules: Schedule[];
    onEdit: (schedule: Schedule) => void;
    onTeamClick: (teamName: string) => void;
  }) => {
    calendarPropsMock(props);
    return (
      <div data-testid="schedule-board">
        <button type="button" onClick={() => props.onEdit(props.schedules[0])}>
          编辑首个计划
        </button>
        <button type="button" onClick={() => props.onTeamClick('alpha')}>
          打开 Alpha 团队
        </button>
      </div>
    );
  },
}));
vi.mock('@renderer/components/team/schedule/CcCronScheduleDialog', () => ({
  CcCronScheduleDialog: (props: {
    open: boolean;
    teamName?: string;
    schedule: Schedule | null;
    onClose: () => void;
  }) => {
    dialogPropsMock(props);
    return props.open ? (
      <div role="dialog" aria-label="计划编辑器">
        {props.schedule ? `编辑 ${props.schedule.id}` : '创建计划'}
        <button type="button" onClick={props.onClose}>
          关闭计划编辑器
        </button>
      </div>
    ) : null;
  },
}));

import { SchedulesView } from '@renderer/components/schedules/SchedulesView';

async function renderSchedules(): Promise<{
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SchedulesView />);
    await Promise.resolve();
  });
  return { host, root };
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label)
  );
  expect(button).toBeTruthy();
  return button!;
}

describe('SchedulesView workbench shell', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.schedules = [pausedSchedule, activeSchedule];
    storeState.schedulesLoading = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses the shared header and preserves create, edit, team and dialog wiring', async () => {
    const { host, root } = await renderSchedules();

    expect(host.querySelector('header h1')?.textContent).toBe('计划任务');
    expect(host.textContent).toContain('1 个计划正在运行');
    expect(host.querySelector('[data-testid="schedule-board"]')).not.toBeNull();
    expect(calendarPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        schedules: [activeSchedule, pausedSchedule],
      })
    );

    await act(async () => {
      findButton(host, '添加计划').click();
      await Promise.resolve();
    });
    expect(host.querySelector('[aria-label="计划编辑器"]')?.textContent).toContain('创建计划');

    await act(async () => {
      findButton(host, '关闭计划编辑器').click();
      findButton(host, '编辑首个计划').click();
      await Promise.resolve();
    });
    expect(host.querySelector('[aria-label="计划编辑器"]')?.textContent).toContain(
      '编辑 schedule-active'
    );

    await act(async () => {
      findButton(host, '打开 Alpha 团队').click();
      await Promise.resolve();
    });
    expect(storeState.openTeamTab).toHaveBeenCalledWith('alpha');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
