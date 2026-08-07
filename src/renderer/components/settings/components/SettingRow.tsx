/**
 * SettingRow - Setting row component for consistent layout.
 * Linear-style clean row with optional icon.
 */

interface SettingRowProps {
  readonly label: string;
  readonly description?: string;
  readonly icon?: React.ReactNode;
  readonly children: React.ReactNode;
}

export const SettingRow = ({
  label,
  description,
  icon,
  children,
}: SettingRowProps): React.JSX.Element => {
  return (
    <div
      className="group flex items-center justify-between border-b px-3 py-3.5 transition-colors duration-150 last:border-b-0 hover:bg-[var(--color-accent-soft)]"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <div className="flex items-start gap-3">
        {icon ? (
          <div
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded transition-colors duration-150 group-hover:text-[var(--color-text)]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {icon}
          </div>
        ) : null}
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {label}
          </div>
          {description && (
            <div
              className="mt-0.5 text-xs leading-relaxed"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {description}
            </div>
          )}
        </div>
      </div>
      <div className="shrink-0 transition-transform duration-100 group-active:scale-[0.97]">
        {children}
      </div>
    </div>
  );
};
