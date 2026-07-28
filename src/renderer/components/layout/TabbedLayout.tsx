/**
 * TabbedLayout - Main layout with full-width tab bar, sidebar, and multi-pane content.
 *
 * Layout structure:
 * - TabBarRow (full width): Pane TabBars + action buttons
 * - Sidebar (280px): Task list / date-grouped sessions
 * - Main content: PaneContainer with one or more panes
 *
 * Owns the DndContext for tab drag-and-drop across the entire layout
 * (TabBarRow tabs + PaneContainer split zones).
 */

import { useCallback, useMemo, useState } from 'react';

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  AppNavigationRail,
  getWorkbenchNavigationArea,
} from '@features/collaborative-workbench/renderer';
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import { CliInstallWarningBanner } from '../common/CliInstallWarningBanner';
import { GlobalProviderStatusHeader } from '../common/GlobalProviderStatusHeader';
import { WorkspaceIndicator } from '../common/WorkspaceIndicator';
import { CommandPalette } from '../search/CommandPalette';
import { GlobalTaskDetailDialog } from '../team/dialogs/GlobalTaskDetailDialog';

import { PaneContainer } from './PaneContainer';
import { Sidebar } from './Sidebar';
import { DragOverlayTab } from './SortableTab';
import { TabBarRow } from './TabBarRow';

import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { Tab } from '@renderer/types/tabs';

export const TabbedLayout = (): React.JSX.Element => {
  useKeyboardShortcuts();

  // --- DnD state (lifted from PaneContainer) ---
  const {
    panes,
    activeTabId,
    unreadCount,
    openTasksTab,
    openDashboard,
    openTeamsTab,
    openSchedulesTab,
    openExtensionsTab,
    openNotificationsTab,
    openSystemManager,
    openSettingsTab,
    openCommandPalette,
    openChatTab,
  } = useStore(
    useShallow((s) => ({
      panes: s.paneLayout.panes,
      activeTabId: s.activeTabId,
      unreadCount: s.unreadCount,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Zustand actions are receiver-independent.
      openTasksTab: s.openTasksTab,
      openDashboard: s.openDashboard,
      openTeamsTab: s.openTeamsTab,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Zustand actions are receiver-independent.
      openSchedulesTab: s.openSchedulesTab,
      openExtensionsTab: s.openExtensionsTab,
      openNotificationsTab: s.openNotificationsTab,
      openSystemManager: s.openSystemManager,
      openSettingsTab: s.openSettingsTab,
      openCommandPalette: s.openCommandPalette,
      openChatTab: s.openChatTab,
    }))
  );
  const [draggedTab, setDraggedTab] = useState<Tab | null>(null);
  const currentTab = useMemo(() => {
    if (!activeTabId) return null;
    for (const pane of panes) {
      const tab = pane.tabs.find((item) => item.id === activeTabId);
      if (tab) return tab;
    }
    return null;
  }, [activeTabId, panes]);
  const hasAnyTabs = panes.some((pane) => pane.tabs.length > 0);
  const activeArea =
    currentTab === null && !hasAnyTabs ? 'inbox' : getWorkbenchNavigationArea(currentTab);
  const showSidebar = currentTab?.type === 'team';

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const data = active.data.current;

      if (data?.type === 'tab') {
        const sourcePaneId = data.paneId as string;
        const tabId = data.tabId as string;

        const pane = panes.find((p) => p.id === sourcePaneId);
        const tab = pane?.tabs.find((t) => t.id === tabId);
        if (tab) {
          setDraggedTab(tab);
        }
      }
    },
    [panes]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      setDraggedTab(null);

      if (!over || !active.data.current) return;

      const activeData = active.data.current;
      const overData = over.data.current;

      if (activeData.type !== 'tab') return;

      const draggedTabId = activeData.tabId as string;
      const sourcePaneId = activeData.paneId as string;
      const state = useStore.getState();

      // Case 1: Drop on a split-zone (edge of pane) → create new pane
      if (overData?.type === 'split-zone') {
        const targetPaneId = overData.paneId as string;
        const side = overData.side as 'left' | 'right';
        state.moveTabToNewPane(draggedTabId, sourcePaneId, targetPaneId, side);
        return;
      }

      // Case 2: Drop on a tabbar (different pane) → move tab to that pane
      if (overData?.type === 'tabbar') {
        const targetPaneId = overData.paneId as string;
        if (sourcePaneId !== targetPaneId) {
          state.moveTabToPane(draggedTabId, sourcePaneId, targetPaneId);
        }
        return;
      }

      // Case 3: Drop on another sortable tab
      if (overData?.type === 'tab') {
        const overTabId = overData.tabId as string;
        const overPaneId = overData.paneId as string;

        if (sourcePaneId === overPaneId) {
          const pane = panes.find((p) => p.id === sourcePaneId);
          if (!pane) return;

          const fromIndex = pane.tabs.findIndex((t) => t.id === draggedTabId);
          const toIndex = pane.tabs.findIndex((t) => t.id === overTabId);

          if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
            state.reorderTabInPane(sourcePaneId, fromIndex, toIndex);
          }
        } else {
          const targetPane = panes.find((p) => p.id === overPaneId);
          if (!targetPane) return;

          const insertIndex = targetPane.tabs.findIndex((t) => t.id === overTabId);
          state.moveTabToPane(draggedTabId, sourcePaneId, overPaneId, insertIndex);
        }
      }
    },
    [panes]
  );

  return (
    <div className="flex h-screen bg-app-shell text-foreground">
      <AppNavigationRail
        activeArea={activeArea}
        unreadCount={unreadCount}
        onOpenInbox={openTasksTab}
        onOpenOverview={openDashboard}
        onOpenAgents={openTeamsTab}
        onOpenSchedules={openSchedulesTab}
        onOpenExtensions={openExtensionsTab}
        onOpenNotifications={openNotificationsTab}
        onOpenSystemManager={() => void openSystemManager()}
        onOpenSettings={() => openSettingsTab()}
        onOpenSearch={openCommandPalette}
        onOpenCommunity={openChatTab}
      />

      <div className="flex min-w-0 flex-1 flex-col bg-page-canvas">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <TabBarRow />
          <CliInstallWarningBanner />
          <GlobalProviderStatusHeader />
          <div className="flex flex-1 overflow-hidden">
            <CommandPalette />

            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-page-canvas">
              <PaneContainer />
            </div>

            {showSidebar ? <Sidebar /> : null}
          </div>

          <DragOverlay dropAnimation={null}>
            {draggedTab ? <DragOverlayTab tab={draggedTab} /> : null}
          </DragOverlay>
        </DndContext>
      </div>

      <GlobalTaskDetailDialog />
      <WorkspaceIndicator />
    </div>
  );
};
