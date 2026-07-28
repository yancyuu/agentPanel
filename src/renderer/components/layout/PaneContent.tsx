/**
 * PaneContent - Renders tab content for a single pane.
 * Uses CSS display-toggle to keep all tabs mounted (preserving state).
 */

import { TeamGraphTab } from '@features/agent-graph/renderer';
import { TabUIProvider } from '@renderer/contexts/TabUIContext';
import { SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';

import { CommunityChatView } from '../chat/CommunityChatView';
import { DashboardView } from '../dashboard/DashboardView';
import { ExtensionStoreView } from '../extensions/ExtensionStoreView';
import { NotificationsView } from '../notifications/NotificationsView';
import { SessionReportTab } from '../report/SessionReportTab';
import { SchedulesView } from '../schedules/SchedulesView';
import { SettingsView } from '../settings/SettingsView';
import { SystemManagerView } from '../system-manager/SystemManagerView';
import { TasksView } from '../tasks/TasksView';
import { TeamDetailView } from '../team/TeamDetailView';
import { TeamListView } from '../team/TeamListView';

import { SessionTabContent } from './SessionTabContent';

import type { Pane } from '@renderer/types/panes';

interface PaneContentProps {
  pane: Pane;
  isPaneFocused: boolean;
}

export const PaneContent = ({ pane, isPaneFocused }: PaneContentProps): React.JSX.Element => {
  const activeTabId = pane.activeTabId;

  // Show the collaborative inbox whenever no tab is active. Initial routes are
  // restored before first render, so this fallback only covers the true no-tab
  // state (for example after all tabs are closed).
  const showDefaultInbox = !activeTabId && pane.tabs.length === 0;

  return (
    <div className="relative flex flex-1 overflow-hidden">
      {showDefaultInbox && (
        <div className="absolute inset-0 flex">
          <TasksView />
        </div>
      )}

      {pane.tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className="absolute inset-0 flex"
            style={{ display: isActive ? 'flex' : 'none' }}
          >
            {tab.type === 'dashboard' && <DashboardView />}
            {tab.type === 'chat' && <CommunityChatView />}
            {tab.type === 'notifications' && <NotificationsView />}
            {tab.type === 'settings' && <SettingsView />}
            {tab.type === 'teams' && <TeamListView />}
            {tab.type === 'team' && tab.teamName === SYSTEM_MANAGER_TEAM_NAME && (
              <TabUIProvider tabId={tab.id}>
                <SystemManagerView isPaneFocused={isPaneFocused} isActive={isActive} />
              </TabUIProvider>
            )}
            {tab.type === 'team' && tab.teamName !== SYSTEM_MANAGER_TEAM_NAME && (
              <TabUIProvider tabId={tab.id}>
                <TeamDetailView teamName={tab.teamName ?? ''} isPaneFocused={isPaneFocused} />
              </TabUIProvider>
            )}
            {tab.type === 'session' && (
              <TabUIProvider tabId={tab.id}>
                <SessionTabContent tab={tab} isActive={isActive} />
              </TabUIProvider>
            )}
            {tab.type === 'report' && <SessionReportTab tab={tab} />}
            {tab.type === 'extensions' && (
              <TabUIProvider tabId={tab.id}>
                <ExtensionStoreView />
              </TabUIProvider>
            )}
            {tab.type === 'schedules' && <SchedulesView />}
            {tab.type === 'tasks' && <TasksView />}
            {tab.type === 'graph' && (
              <TabUIProvider tabId={tab.id}>
                <TeamGraphTab
                  teamName={tab.teamName ?? ''}
                  isActive={isActive}
                  isPaneFocused={isPaneFocused}
                />
              </TabUIProvider>
            )}
          </div>
        );
      })}
    </div>
  );
};
