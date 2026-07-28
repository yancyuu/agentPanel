import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DetectedError } from '@renderer/types/data';

const notificationA = {
  id: 'notification-a',
  timestamp: 20,
  isRead: false,
  triggerName: '运行时',
  triggerColor: 'blue',
  title: '运行时异常',
  message: '需要检查运行时',
} as unknown as DetectedError;
const notificationB = {
  id: 'notification-b',
  timestamp: 10,
  isRead: true,
  triggerName: '任务',
  triggerColor: 'green',
  title: '任务完成',
  message: '任务已完成',
} as unknown as DetectedError;

const storeState = {
  notifications: [notificationA, notificationB],
  unreadCount: 1,
  fetchNotifications: vi.fn(() => Promise.resolve()),
  markNotificationRead: vi.fn(() => Promise.resolve()),
  markAllNotificationsRead: vi.fn(() => Promise.resolve()),
  deleteNotification: vi.fn(() => Promise.resolve()),
  clearNotifications: vi.fn(() => Promise.resolve()),
  navigateToError: vi.fn(),
};
const scrollToIndexMock = vi.fn();

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    scrollToIndex: scrollToIndexMock,
    getTotalSize: () => count * 56,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: `row-${index}`,
        size: 56,
        start: index * 56,
      })),
  }),
}));
vi.mock('@renderer/components/notifications/NotificationRow', () => ({
  NotificationRow: ({
    error,
    onRowClick,
    onArchive,
    onDelete,
  }: {
    error: DetectedError;
    onRowClick: () => void;
    onArchive: () => void;
    onDelete: () => void;
  }) => (
    <div data-testid={`notification-${error.id}`}>
      <button type="button" onClick={onRowClick}>
        打开 {error.id}
      </button>
      <button type="button" onClick={onArchive}>
        归档 {error.id}
      </button>
      <button type="button" onClick={onDelete}>
        删除 {error.id}
      </button>
    </div>
  ),
}));

import { NotificationsView } from '@renderer/components/notifications/NotificationsView';

async function renderNotifications(): Promise<{
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<NotificationsView />);
    await Promise.resolve();
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

describe('NotificationsView workbench shell', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.notifications = [notificationA, notificationB];
    storeState.unreadCount = 1;
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses the shared header and preserves scoped notification actions', async () => {
    const { host, root } = await renderNotifications();

    expect(host.querySelector('header h1')?.textContent).toBe('通知');
    expect(host.textContent).toContain('1 条未读通知');
    expect(host.textContent).toContain('运行时');
    expect(host.textContent).toContain('任务');

    await act(async () => {
      findButton(host, '全部已读').click();
      await Promise.resolve();
    });
    expect(storeState.markAllNotificationsRead).toHaveBeenCalledWith(undefined);

    await act(async () => {
      findButton(host, '运行时').click();
      await Promise.resolve();
    });
    await act(async () => {
      findButton(host, '筛选已读').click();
      await Promise.resolve();
    });
    expect(storeState.markAllNotificationsRead).toHaveBeenLastCalledWith('运行时');

    await act(async () => {
      findButton(host, '清除筛选').click();
      await Promise.resolve();
    });
    await act(async () => {
      findButton(host, '确认清除').click();
      await Promise.resolve();
    });
    expect(storeState.clearNotifications).toHaveBeenCalledWith('运行时');

    await act(async () => {
      findButton(host, '打开 notification-a').click();
      findButton(host, '归档 notification-a').click();
      findButton(host, '删除 notification-a').click();
      await Promise.resolve();
    });
    expect(storeState.navigateToError).toHaveBeenCalledWith(notificationA);
    expect(storeState.markNotificationRead).toHaveBeenCalledWith('notification-a');
    expect(storeState.deleteNotification).toHaveBeenCalledWith('notification-a');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
