/**
 * Main workbench layout.
 *
 * The product now uses the left navigation rail as the single navigation model.
 * The old browser-style tab strip duplicated every destination and added an
 * unnecessary “+ / …” frame inside the native desktop window.
 */

import { useMemo } from 'react';

import {
  AppNavigationRail,
  getWorkbenchNavigationArea,
} from '@features/collaborative-workbench/renderer';
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts';
import { useStore } from '@renderer/store';
import { SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';
import { useShallow } from 'zustand/react/shallow';

import { CliInstallWarningBanner } from '../common/CliInstallWarningBanner';
import { GlobalProviderStatusHeader } from '../common/GlobalProviderStatusHeader';
import { WorkspaceIndicator } from '../common/WorkspaceIndicator';
import { CommandPalette } from '../search/CommandPalette';
import { GlobalTaskDetailDialog } from '../team/dialogs/GlobalTaskDetailDialog';

import { PaneContainer } from './PaneContainer';
import { Sidebar } from './Sidebar';

export const TabbedLayout = (): React.JSX.Element => {
  useKeyboardShortcuts();

  const {
    panes,
    activeTabId,
    inboxHasUnreadMessages,
    openInboxTab,
    openTasksTab,
    openDashboard,
    openTeamsTab,
    openTab,
    openSchedulesTab,
    openSystemManager,
    openSettingsTab,
  } = useStore(
    useShallow((state) => ({
      panes: state.paneLayout.panes,
      activeTabId: state.activeTabId,
      inboxHasUnreadMessages: state.inboxHasUnreadMessages,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Zustand actions are receiver-independent.
      openInboxTab: state.openInboxTab,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Zustand actions are receiver-independent.
      openTasksTab: state.openTasksTab,
      openDashboard: state.openDashboard,
      openTeamsTab: state.openTeamsTab,
      openTab: state.openTab,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Zustand actions are receiver-independent.
      openSchedulesTab: state.openSchedulesTab,
      openSystemManager: state.openSystemManager,
      openSettingsTab: state.openSettingsTab,
    }))
  );

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
  const showSidebar =
    currentTab?.type === 'team' && currentTab.teamName !== SYSTEM_MANAGER_TEAM_NAME;

  return (
    <div className="flex h-screen bg-app-shell text-foreground">
      <AppNavigationRail
        activeArea={activeArea}
        inboxHasUnread={inboxHasUnreadMessages}
        onOpenInbox={openInboxTab}
        onOpenTasks={openTasksTab}
        onOpenOverview={openDashboard}
        onOpenAgents={openTeamsTab}
        onOpenCollaboration={() => openTab({ type: 'collaboration', label: '小队' })}
        onOpenSchedules={openSchedulesTab}
        onOpenSystemManager={() => void openSystemManager()}
        onOpenSettings={() => openSettingsTab()}
      />

      <div className="flex min-w-0 flex-1 flex-col bg-page-canvas">
        <CliInstallWarningBanner />
        <GlobalProviderStatusHeader />
        <div className="flex flex-1 overflow-hidden">
          <CommandPalette />

          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-page-canvas">
            <PaneContainer />
          </div>

          {showSidebar ? <Sidebar /> : null}
        </div>
      </div>

      <GlobalTaskDetailDialog />
      <WorkspaceIndicator />
    </div>
  );
};
