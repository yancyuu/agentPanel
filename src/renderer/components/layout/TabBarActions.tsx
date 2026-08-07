/**
 * TabBarActions - Context actions for the focused tab bar.
 *
 * Primary application navigation now lives in AppNavigationRail. This row keeps
 * the existing MoreMenu (notifications/search/settings/session actions) and the
 * team workspace sidebar toggle so no capability is removed.
 */

import { useMemo, useState } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { PanelRight } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { MoreMenu } from './MoreMenu';

export const TabBarActions = (): React.JSX.Element => {
  const { unreadCount, activeTabId, openTabs, tabSessionData, sidebarCollapsed, toggleSidebar } =
    useStore(
      useShallow((s) => ({
        unreadCount: s.unreadCount,
        activeTabId: s.activeTabId,
        openTabs: s.openTabs,
        tabSessionData: s.tabSessionData,
        sidebarCollapsed: s.sidebarCollapsed,
        toggleSidebar: s.toggleSidebar,
      }))
    );
  const [expandHover, setExpandHover] = useState(false);

  const activeTab = useMemo(
    () => openTabs.find((tab) => tab.id === activeTabId),
    [activeTabId, openTabs]
  );
  const activeTabSessionDetail = activeTabId
    ? (tabSessionData[activeTabId]?.sessionDetail ?? null)
    : null;

  return (
    <div
      className="ml-2 flex shrink-0 items-center gap-1"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <MoreMenu
        activeTab={activeTab}
        activeTabSessionDetail={activeTabSessionDetail}
        activeTabId={activeTabId}
        unreadCount={unreadCount}
      />

      {sidebarCollapsed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleSidebar}
              onMouseEnter={() => setExpandHover(true)}
              onMouseLeave={() => setExpandHover(false)}
              className="mr-1 rounded-md p-2 transition-colors"
              style={{
                color: expandHover ? 'var(--foreground)' : 'var(--muted-foreground)',
                backgroundColor: expandHover ? 'var(--surface-hover)' : 'transparent',
              }}
              aria-label="展开工作空间侧栏"
            >
              <PanelRight className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">展开工作空间侧栏</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
