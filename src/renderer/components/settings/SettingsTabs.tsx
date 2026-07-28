import { BarChart3, Bot, Settings, Wrench } from 'lucide-react';

import type { LucideIcon } from 'lucide-react';
import type { KeyboardEvent } from 'react';

export type SettingsSection = 'general' | 'harness' | 'task-bus' | 'advanced';

export interface SettingsCategory {
  readonly id: SettingsSection;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly description: string;
}

export const SETTINGS_CATEGORIES = [
  {
    id: 'general',
    label: '通用',
    icon: Settings,
    description: '主题、语言、显示与启动偏好。',
  },
  {
    id: 'harness',
    label: 'Harness',
    icon: Bot,
    description: '管理 Agent 运行时、Provider 与 CLI。',
  },
  {
    id: 'task-bus',
    label: 'Usage 监测',
    icon: BarChart3,
    description: '查看本地会话与 Usage 数据。',
  },
  {
    id: 'advanced',
    label: '高级',
    icon: Wrench,
    description: '管理原始配置、服务与版本信息。',
  },
] as const satisfies readonly SettingsCategory[];

interface SettingsTabsProps {
  activeSection: SettingsSection;
  compact?: boolean;
  onSectionChange: (section: SettingsSection) => void;
}

function activateAdjacentCategory(
  event: KeyboardEvent<HTMLButtonElement>,
  currentIndex: number,
  onSectionChange: (section: SettingsSection) => void
): void {
  const { key } = event;
  const vertical = key === 'ArrowUp' || key === 'ArrowDown';
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  if (!vertical && !horizontal && key !== 'Home' && key !== 'End') return;

  event.preventDefault();
  const nextIndex =
    key === 'Home'
      ? 0
      : key === 'End'
        ? SETTINGS_CATEGORIES.length - 1
        : key === 'ArrowUp' || key === 'ArrowLeft'
          ? (currentIndex - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length
          : (currentIndex + 1) % SETTINGS_CATEGORIES.length;

  const category = SETTINGS_CATEGORIES[nextIndex];
  if (!category) return;
  onSectionChange(category.id);
  const tabList = event.currentTarget.closest('[role="tablist"]');
  const nextTab = tabList?.querySelector<HTMLButtonElement>(`#settings-tab-${category.id}`);
  nextTab?.focus();
}

const CategoryButton = ({
  category,
  activeSection,
  compact,
  index,
  onSectionChange,
}: Readonly<{
  category: SettingsCategory;
  activeSection: SettingsSection;
  compact: boolean;
  index: number;
  onSectionChange: (section: SettingsSection) => void;
}>): React.JSX.Element => {
  const Icon = category.icon;
  const isActive = category.id === activeSection;

  return (
    <button
      id={`settings-tab-${category.id}`}
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-current={isActive ? 'page' : undefined}
      aria-controls={`settings-panel-${category.id}`}
      tabIndex={isActive ? 0 : -1}
      onClick={() => onSectionChange(category.id)}
      onKeyDown={(event) => activateAdjacentCategory(event, index, onSectionChange)}
      className={`group flex border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)] ${
        compact
          ? 'min-w-[168px] flex-1 items-center gap-2.5 rounded-md px-3 py-2'
          : 'w-full items-start gap-3 rounded-md px-3 py-2.5'
      } ${
        isActive
          ? 'border-[var(--color-accent-border)] bg-[var(--color-accent-soft)] text-[var(--color-text)]'
          : 'border-transparent text-[var(--color-text-secondary)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]'
      }`}
    >
      <Icon
        aria-hidden="true"
        className={`mt-0.5 size-4 shrink-0 ${isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium">{category.label}</span>
        <span
          className={`mt-0.5 block text-[10px] leading-4 text-[var(--color-text-muted)] ${compact ? 'truncate' : ''}`}
        >
          {category.description}
        </span>
      </span>
    </button>
  );
};

export const SettingsTabs = ({
  activeSection,
  compact = false,
  onSectionChange,
}: Readonly<SettingsTabsProps>): React.JSX.Element => (
  <nav aria-label="设置分类" className={compact ? 'min-w-0 max-w-full' : 'w-[216px] shrink-0'}>
    <div
      role="tablist"
      aria-label="设置分类"
      aria-orientation={compact ? 'horizontal' : 'vertical'}
      className={
        compact
          ? 'flex max-w-full gap-2 overflow-x-auto overscroll-x-contain pb-1'
          : 'flex flex-col gap-1'
      }
    >
      {SETTINGS_CATEGORIES.map((category, index) => (
        <CategoryButton
          key={category.id}
          category={category}
          activeSection={activeSection}
          compact={compact}
          index={index}
          onSectionChange={onSectionChange}
        />
      ))}
    </div>
  </nav>
);
