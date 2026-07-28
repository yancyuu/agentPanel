/**
 * NotificationsView - Linear Inbox-style notifications page.
 * Single list showing all notifications with unread indicator.
 * Includes a filter chip bar to filter by trigger name.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { WorkbenchPageHeader } from '@features/collaborative-workbench/renderer';
import { useStore } from '@renderer/store';
import { getTriggerColorDef } from '@shared/constants/triggerColors';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CheckCheck, Inbox, Loader2, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { NotificationRow } from './NotificationRow';

import type { DetectedError } from '@renderer/types/data';

// Virtual list constants
const ROW_HEIGHT = 56;
const OVERSCAN = 5;

/** Stable store scope used for notifications without a triggerName. */
const OTHER_SCOPE_KEY = 'Other';
const OTHER_DISPLAY_LABEL = '其他';

interface FilterChip {
  scopeKey: string;
  label: string;
  count: number;
  colorHex: string;
}

export const NotificationsView = (): React.JSX.Element => {
  const {
    notifications,
    unreadCount,
    fetchNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    deleteNotification,
    clearNotifications,
    navigateToError,
  } = useStore(
    useShallow((s) => ({
      notifications: s.notifications,
      unreadCount: s.unreadCount,
      fetchNotifications: s.fetchNotifications,
      markNotificationRead: s.markNotificationRead,
      markAllNotificationsRead: s.markAllNotificationsRead,
      deleteNotification: s.deleteNotification,
      clearNotifications: s.clearNotifications,
      navigateToError: s.navigateToError,
    }))
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  // Fetch notifications on mount
  useEffect(() => {
    const loadNotifications = async (): Promise<void> => {
      setIsLoading(true);
      try {
        await fetchNotifications();
      } finally {
        setIsLoading(false);
      }
    };
    void loadNotifications();
  }, [fetchNotifications]);

  // Sort notifications by timestamp (most recent first)
  const sortedNotifications = useMemo(() => {
    return [...notifications].sort((a, b) => b.timestamp - a.timestamp);
  }, [notifications]);

  // Derive filter chips from notifications
  const filterChips = useMemo((): FilterChip[] => {
    const counts = new Map<string, { count: number; colorHex: string }>();
    for (const n of sortedNotifications) {
      const scopeKey = n.triggerName ?? OTHER_SCOPE_KEY;
      const existing = counts.get(scopeKey);
      if (existing) {
        existing.count++;
      } else {
        counts.set(scopeKey, {
          count: 1,
          colorHex: getTriggerColorDef(n.triggerColor).hex,
        });
      }
    }
    // Sort by frequency descending
    return Array.from(counts.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([scopeKey, { count, colorHex }]) => ({
        scopeKey,
        label: scopeKey === OTHER_SCOPE_KEY ? OTHER_DISPLAY_LABEL : scopeKey,
        count,
        colorHex,
      }));
  }, [sortedNotifications]);

  // Reset filter when all notifications are cleared
  useEffect(() => {
    if (notifications.length === 0) {
      setActiveFilter(null);
    }
  }, [notifications.length]);

  // Apply filter
  const filteredNotifications = useMemo(() => {
    if (activeFilter === null) return sortedNotifications;
    return sortedNotifications.filter((n) => {
      const scopeKey = n.triggerName ?? OTHER_SCOPE_KEY;
      return scopeKey === activeFilter;
    });
  }, [sortedNotifications, activeFilter]);

  // Estimate item size
  const estimateSize = useCallback(() => ROW_HEIGHT, []);

  // Set up virtualizer
  const rowVirtualizer = useVirtualizer({
    count: filteredNotifications.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: OVERSCAN,
  });

  // Scroll to top when filter changes
  useEffect(() => {
    rowVirtualizer.scrollToIndex(0);
  }, [activeFilter, rowVirtualizer]);

  // Derive filtered unread count for scoped button visibility
  const filteredUnreadCount = useMemo(() => {
    if (activeFilter === null) return unreadCount;
    return filteredNotifications.filter((n) => !n.isRead).length;
  }, [activeFilter, filteredNotifications, unreadCount]);

  // Handle mark all read (scoped to active filter)
  const handleMarkAllRead = async (): Promise<void> => {
    await markAllNotificationsRead(activeFilter ?? undefined);
  };

  // Handle clear all with confirmation (scoped to active filter)
  const handleClearAll = async (): Promise<void> => {
    if (showClearConfirm) {
      await clearNotifications(activeFilter ?? undefined);
      setShowClearConfirm(false);
    } else {
      setShowClearConfirm(true);
      // Auto-hide confirmation after 3 seconds
      setTimeout(() => setShowClearConfirm(false), 3000);
    }
  };

  // Handle archive (mark as read)
  const handleArchive = async (id: string): Promise<void> => {
    await markNotificationRead(id);
  };

  // Handle delete
  const handleDelete = async (id: string): Promise<void> => {
    await deleteNotification(id);
  };

  // Handle row click - navigate to error
  const handleRowClick = (error: DetectedError): void => {
    // Mark as read when navigating
    if (!error.isRead) {
      void markNotificationRead(error.id);
    }
    navigateToError(error);
  };

  // Handle filter chip click
  const handleFilterClick = (label: string): void => {
    setActiveFilter((prev) => (prev === label ? null : label));
  };

  const headerDescription =
    activeFilter !== null
      ? filteredUnreadCount > 0
        ? `当前筛选中有 ${filteredUnreadCount} 条未读通知`
        : `当前筛选中有 ${filteredNotifications.length} 条通知`
      : unreadCount > 0
        ? `${unreadCount} 条未读通知`
        : notifications.length > 0
          ? `共 ${notifications.length} 条通知`
          : '集中查看运行时、任务和团队事件。';

  const headerActions =
    !isLoading && notifications.length > 0 ? (
      <div className="flex items-center gap-1">
        {filteredUnreadCount > 0 && (
          <button
            type="button"
            onClick={handleMarkAllRead}
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            title={activeFilter !== null ? '将筛选结果全部标为已读' : '将全部通知标为已读'}
            aria-label={activeFilter !== null ? '将筛选结果全部标为已读' : '将全部通知标为已读'}
          >
            <CheckCheck className="size-4" />
            <span className="hidden sm:inline">
              {activeFilter !== null ? '筛选已读' : '全部已读'}
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={handleClearAll}
          className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
            showClearConfirm
              ? 'bg-red-500/15 text-red-400 hover:bg-red-500/20'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]'
          }`}
          title={activeFilter !== null ? '清除筛选结果' : '清除全部通知'}
          aria-label={
            showClearConfirm
              ? '再次点击确认清除通知'
              : activeFilter !== null
                ? '清除筛选结果'
                : '清除全部通知'
          }
        >
          <Trash2 className="size-4" />
          <span className="hidden sm:inline">
            {showClearConfirm ? '确认清除' : activeFilter !== null ? '清除筛选' : '清除全部'}
          </span>
        </button>
      </div>
    ) : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-page-canvas">
      <WorkbenchPageHeader
        title="通知"
        description={isLoading ? '正在加载通知...' : headerDescription}
        count={isLoading ? undefined : notifications.length}
        actions={headerActions}
      />

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center py-16">
          <Loader2 className="mr-2 size-5 animate-spin text-[var(--color-text-muted)]" />
          <span className="text-sm text-[var(--color-text-muted)]">正在加载通知...</span>
        </div>
      ) : (
        <>
          {/* Filter Chip Bar */}
          {filterChips.length > 1 && (
            <div
              className="scrollbar-none shrink-0 overflow-x-auto border-b"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              <div className="flex items-center gap-1.5 px-4 py-2">
                {/* All chip */}
                <button
                  type="button"
                  aria-pressed={activeFilter === null}
                  onClick={() => setActiveFilter(null)}
                  className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors"
                  style={{
                    backgroundColor:
                      activeFilter === null ? 'var(--color-surface-raised)' : undefined,
                    color: activeFilter === null ? 'var(--color-text)' : 'var(--color-text-muted)',
                    border:
                      activeFilter === null
                        ? '1px solid var(--color-border-emphasis)'
                        : '1px solid var(--color-border)',
                  }}
                >
                  全部
                  <span className="opacity-60">({sortedNotifications.length})</span>
                </button>
                {/* Trigger chips */}
                {filterChips.map((chip) => (
                  <button
                    key={chip.scopeKey}
                    type="button"
                    aria-pressed={activeFilter === chip.scopeKey}
                    onClick={() => handleFilterClick(chip.scopeKey)}
                    className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors"
                    style={{
                      backgroundColor:
                        activeFilter === chip.scopeKey ? 'var(--color-surface-raised)' : undefined,
                      color:
                        activeFilter === chip.scopeKey
                          ? 'var(--color-text)'
                          : 'var(--color-text-muted)',
                      border:
                        activeFilter === chip.scopeKey
                          ? '1px solid var(--color-border-emphasis)'
                          : '1px solid var(--color-border)',
                    }}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: chip.colorHex }}
                    />
                    {chip.label}
                    <span className="opacity-60">({chip.count})</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Notifications List */}
          <div ref={parentRef} className="min-w-0 flex-1 overflow-y-auto">
            {filteredNotifications.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center py-16"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <Inbox className="mb-3 size-10 opacity-30" />
                <p className="mb-1 text-sm font-medium">
                  {activeFilter !== null ? '没有匹配的通知' : '暂无通知'}
                </p>
                <p className="text-xs opacity-70">
                  {activeFilter !== null ? '请选择其他筛选条件。' : '当前没有需要处理的通知。'}
                </p>
              </div>
            ) : (
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const notification = filteredNotifications[virtualRow.index];
                  if (!notification) return null;

                  return (
                    <div
                      key={virtualRow.key}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <NotificationRow
                        error={notification}
                        onRowClick={() => handleRowClick(notification)}
                        onArchive={() => handleArchive(notification.id)}
                        onDelete={() => handleDelete(notification.id)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
