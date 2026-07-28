import { cn } from '@renderer/lib/utils';
import { SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';
import {
  Bell,
  Bot,
  CalendarClock,
  CircleHelp,
  Inbox,
  LayoutDashboard,
  MessageCircle,
  Puzzle,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';

import type { Tab } from '@renderer/types/tabs';
import type { ComponentType } from 'react';

export type WorkbenchNavigationArea =
  | 'inbox'
  | 'overview'
  | 'agents'
  | 'schedules'
  | 'extensions'
  | 'notifications'
  | 'system-manager'
  | 'settings';

type WorkbenchTabDescriptor = Pick<Tab, 'type' | 'teamName'>;

export function getWorkbenchNavigationArea(
  tab: WorkbenchTabDescriptor | null
): WorkbenchNavigationArea | null {
  if (!tab) return null;
  if (tab.type === 'tasks') return 'inbox';
  if (tab.type === 'teams' || tab.type === 'graph') return 'agents';
  if (tab.type === 'team') {
    return tab.teamName === SYSTEM_MANAGER_TEAM_NAME ? 'system-manager' : 'agents';
  }
  if (tab.type === 'schedules') return 'schedules';
  if (tab.type === 'extensions') return 'extensions';
  if (tab.type === 'notifications') return 'notifications';
  if (tab.type === 'settings') return 'settings';
  if (
    tab.type === 'dashboard' ||
    tab.type === 'session' ||
    tab.type === 'report' ||
    tab.type === 'chat'
  ) {
    return 'overview';
  }
  return null;
}

interface NavigationItem {
  id: WorkbenchNavigationArea | 'search' | 'community';
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  badge?: number;
}

export interface AppNavigationRailProps {
  activeArea: WorkbenchNavigationArea | null;
  unreadCount?: number;
  onOpenInbox(): void;
  onOpenOverview(): void;
  onOpenAgents(): void;
  onOpenSchedules(): void;
  onOpenExtensions(): void;
  onOpenNotifications(): void;
  onOpenSystemManager(): void;
  onOpenSettings(): void;
  onOpenSearch(): void;
  onOpenCommunity(): void;
}

function NavigationButton({
  item,
  active,
}: Readonly<{
  item: NavigationItem;
  active: boolean;
}>): React.JSX.Element {
  const Icon = item.icon;
  const badgeLabel = item.badge && item.badge > 99 ? '99+' : item.badge;

  return (
    <button
      type="button"
      title={item.label}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      onClick={item.onClick}
      className={cn(
        'group flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
        active
          ? 'bg-surface-selected font-medium text-foreground hover:bg-surface-selected'
          : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="hidden min-w-0 flex-1 truncate text-left xl:block">{item.label}</span>
      {badgeLabel ? (
        <span className="bg-brand/10 hidden min-w-5 rounded-full px-1.5 text-center text-xs text-brand xl:inline-flex xl:justify-center">
          {badgeLabel}
        </span>
      ) : null}
    </button>
  );
}

export function AppNavigationRail({
  activeArea,
  unreadCount = 0,
  onOpenInbox,
  onOpenOverview,
  onOpenAgents,
  onOpenSchedules,
  onOpenExtensions,
  onOpenNotifications,
  onOpenSystemManager,
  onOpenSettings,
  onOpenSearch,
  onOpenCommunity,
}: Readonly<AppNavigationRailProps>): React.JSX.Element {
  const primaryItems: NavigationItem[] = [
    { id: 'inbox', label: '收件箱', icon: Inbox, onClick: onOpenInbox },
    { id: 'overview', label: '概览', icon: LayoutDashboard, onClick: onOpenOverview },
    { id: 'agents', label: '数字员工', icon: Bot, onClick: onOpenAgents },
    { id: 'schedules', label: '定时任务', icon: CalendarClock, onClick: onOpenSchedules },
    { id: 'extensions', label: '扩展', icon: Puzzle, onClick: onOpenExtensions },
  ];
  const utilityItems: NavigationItem[] = [
    {
      id: 'notifications',
      label: '通知',
      icon: Bell,
      onClick: onOpenNotifications,
      badge: unreadCount,
    },
    { id: 'system-manager', label: 'Helm Loop', icon: ShieldCheck, onClick: onOpenSystemManager },
    { id: 'settings', label: '设置', icon: Settings, onClick: onOpenSettings },
    { id: 'search', label: '搜索', icon: Search, onClick: onOpenSearch },
    { id: 'community', label: '加入飞书群', icon: MessageCircle, onClick: onOpenCommunity },
  ];

  return (
    <aside className="flex h-full w-14 shrink-0 flex-col border-r border-[var(--surface-border)] bg-app-shell px-2 py-2 xl:w-52">
      <div className="mb-2 flex h-9 items-center gap-2.5 px-2.5 text-foreground">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground text-xs font-medium text-app-shell">
          H
        </span>
        <span className="hidden truncate text-sm font-medium xl:block">Hermit</span>
      </div>

      <nav aria-label="主导航" className="space-y-1">
        {primaryItems.map((item) => (
          <NavigationButton key={item.id} item={item} active={activeArea === item.id} />
        ))}
      </nav>

      <div className="mt-auto space-y-1 border-t border-[var(--surface-border-subtle)] pt-2">
        {utilityItems.map((item) => (
          <NavigationButton key={item.id} item={item} active={activeArea === item.id} />
        ))}
        <div className="flex h-8 items-center justify-center text-muted-foreground xl:justify-start xl:px-2.5">
          <CircleHelp className="size-3.5 shrink-0" />
          <span className="ml-2 hidden text-xs xl:block">所有原有功能均保留</span>
        </div>
      </div>
    </aside>
  );
}
