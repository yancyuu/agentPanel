/**
 * SettingsSectionCard - Premium settings panel surface.
 * Adds a subtle accent hairline and glow while preserving AgentPanel's dense control-console feel.
 */

interface SettingsSectionCardProps {
  readonly title: string;
  readonly description?: string;
  readonly icon?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}

export const SettingsSectionCard = ({
  title,
  description,
  icon,
  children,
  className = '',
}: SettingsSectionCardProps): React.JSX.Element => {
  return (
    <section
      className={`bg-[var(--color-surface-raised)]/55 group relative overflow-hidden rounded-2xl border shadow-sm shadow-black/10 transition-all duration-200 hover:border-[var(--color-border-emphasis)] ${className}`}
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[var(--color-accent-border)] to-transparent opacity-80" />
      <div className="pointer-events-none absolute -right-20 -top-24 size-48 rounded-full bg-[var(--color-accent-soft)] blur-3xl transition-opacity duration-300 group-hover:opacity-80" />

      <div
        className="relative border-b px-4 py-3"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <div className="flex items-start gap-3">
          {icon && (
            <div className="shadow-[var(--color-accent-glow)]/20 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-[var(--color-accent-border)] bg-[var(--color-accent-soft)] text-[var(--color-accent)] shadow-sm">
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--color-text)]">{title}</h3>
            {description && (
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
                {description}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="relative px-1">{children}</div>
    </section>
  );
};
