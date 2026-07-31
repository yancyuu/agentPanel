import { cn } from '@renderer/lib/utils';
import { SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';
import {
  Bot,
  CalendarClock,
  ClipboardList,
  Inbox,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import type { Tab } from '@renderer/types/tabs';
import type { ComponentType } from 'react';

export type WorkbenchNavigationArea =
  | 'inbox'
  | 'tasks'
  | 'overview'
  | 'agents'
  | 'collaboration'
  | 'schedules'
  | 'extensions'
  | 'notifications'
  | 'system-manager'
  | 'settings'
  | 'community';

type WorkbenchTabDescriptor = Pick<Tab, 'type' | 'teamName'>;

export function getWorkbenchNavigationArea(
  tab: WorkbenchTabDescriptor | null
): WorkbenchNavigationArea | null {
  if (!tab) return null;
  if (tab.type === 'inbox') return 'inbox';
  if (tab.type === 'tasks') return 'tasks';
  if (tab.type === 'collaboration') return 'collaboration';
  if (tab.type === 'teams' || tab.type === 'graph') return 'agents';
  if (tab.type === 'team') {
    return tab.teamName === SYSTEM_MANAGER_TEAM_NAME ? 'system-manager' : 'agents';
  }
  if (tab.type === 'schedules') return 'schedules';
  if (tab.type === 'extensions') return 'extensions';
  if (tab.type === 'notifications') return 'notifications';
  if (tab.type === 'settings') return 'settings';
  if (tab.type === 'chat') return 'community';
  if (tab.type === 'dashboard' || tab.type === 'session' || tab.type === 'report') {
    return 'overview';
  }
  return null;
}

interface NavigationItem {
  id: WorkbenchNavigationArea;
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  badge?: number;
  dot?: boolean;
  dotLabel?: string;
}

export interface AppNavigationRailProps {
  activeArea: WorkbenchNavigationArea | null;
  inboxHasUnread?: boolean;
  onOpenInbox(): void;
  onOpenTasks(): void;
  onOpenOverview(): void;
  onOpenAgents(): void;
  onOpenCollaboration(): void;
  onOpenSchedules(): void;
  onOpenSystemManager(): void;
  onOpenSettings(): void;
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
        'group relative flex h-10 w-full items-center gap-2.5 rounded-lg px-3 text-sm transition-all duration-150',
        active
          ? 'bg-brand/[0.09] font-medium text-brand shadow-[inset_0_0_0_1px_rgba(var(--brand-rgb),0.08)]'
          : 'text-muted-foreground hover:bg-white/70 hover:text-foreground dark:hover:bg-white/[0.05]'
      )}
    >
      {active ? (
        <span className="absolute -left-2 top-2 h-6 w-0.5 rounded-full bg-brand" aria-hidden />
      ) : null}
      <span className="relative shrink-0">
        <Icon className="size-4" />
        <span
          className={cn(
            'absolute -right-1 -top-1 size-2 rounded-full bg-red-500 ring-2 ring-app-shell transition-[opacity,transform] duration-150',
            item.dot ? 'scale-100 opacity-100' : 'scale-75 opacity-0'
          )}
          aria-label={item.dot ? (item.dotLabel ?? '有新内容') : undefined}
          aria-hidden={!item.dot}
        />
      </span>
      <span className="hidden min-w-0 flex-1 truncate text-left xl:block">{item.label}</span>
      {badgeLabel ? (
        <span className="hidden min-w-5 rounded-full bg-brand/10 px-1.5 text-center text-xs text-brand xl:inline-flex xl:justify-center">
          {badgeLabel}
        </span>
      ) : null}
    </button>
  );
}

export function AppNavigationRail({
  activeArea,
  inboxHasUnread = false,
  onOpenInbox,
  onOpenTasks,
  onOpenOverview,
  onOpenAgents,
  onOpenCollaboration,
  onOpenSchedules,
  onOpenSystemManager,
  onOpenSettings,
}: Readonly<AppNavigationRailProps>): React.JSX.Element {
  const primaryItems: NavigationItem[] = [
    { id: 'overview', label: '概览', icon: LayoutDashboard, onClick: onOpenOverview },
    {
      id: 'inbox',
      label: '收件箱',
      icon: Inbox,
      onClick: onOpenInbox,
      dot: inboxHasUnread && activeArea !== 'inbox',
      dotLabel: '有新任务反馈',
    },
    { id: 'tasks', label: '任务', icon: ClipboardList, onClick: onOpenTasks },
    { id: 'schedules', label: '定时任务', icon: CalendarClock, onClick: onOpenSchedules },
    { id: 'agents', label: '智能体', icon: Bot, onClick: onOpenAgents },
    {
      id: 'collaboration',
      label: '小队',
      icon: UsersRound,
      onClick: onOpenCollaboration,
    },
  ];
  const utilityItems: NavigationItem[] = [
    { id: 'system-manager', label: '诊断', icon: ShieldCheck, onClick: onOpenSystemManager },
    { id: 'settings', label: '设置', icon: Settings, onClick: onOpenSettings },
  ];

  return (
    <aside className="bg-app-shell/95 flex h-full w-14 shrink-0 flex-col border-r border-[var(--surface-border-subtle)] px-2 py-3 backdrop-blur-xl xl:w-52">
      <div className="mb-3 flex h-9 items-center gap-2.5 px-2.5 text-foreground">
        <img
          src="/icon.png"
          alt=""
          className="size-6 shrink-0 rounded-[7px] shadow-[0_3px_10px_rgba(var(--brand-rgb),0.18)]"
        />
        <span className="hidden truncate text-sm font-semibold tracking-[-0.01em] xl:block">
          AgentCLI
        </span>
      </div>

      <nav aria-label="主导航" className="space-y-1.5">
        {primaryItems.map((item) => (
          <NavigationButton key={item.id} item={item} active={activeArea === item.id} />
        ))}
      </nav>

      <div className="mt-auto space-y-1.5 border-t border-[var(--surface-border-subtle)] pt-2.5">
        {utilityItems.map((item) => (
          <NavigationButton key={item.id} item={item} active={activeArea === item.id} />
        ))}
      </div>
    </aside>
  );
}
