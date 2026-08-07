/**
 * SettingsSectionHeader - Section header component.
 * Linear-style subtle label with optional icon.
 */

interface SettingsSectionHeaderProps {
  readonly title: string;
  readonly icon?: React.ReactNode;
}

export const SettingsSectionHeader = ({
  title,
  icon,
}: SettingsSectionHeaderProps): React.JSX.Element => {
  return (
    <h3
      className="mb-3 mt-8 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] first:mt-0"
      style={{ color: 'var(--color-text-muted)' }}
    >
      {icon && (
        <span
          className="flex size-4 items-center justify-center rounded opacity-70"
          style={{ backgroundColor: 'var(--color-border-subtle)' }}
        >
          {icon}
        </span>
      )}
      {title}
      <div className="ml-1 h-px flex-1" style={{ backgroundColor: 'var(--color-border-subtle)' }} />
    </h3>
  );
};
