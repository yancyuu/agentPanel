import { cn } from '@renderer/lib/utils';

export interface WorkbenchPageHeaderProps {
  title: string;
  description?: string;
  count?: number;
  actions?: React.ReactNode;
  className?: string;
}

export function WorkbenchPageHeader({
  title,
  description,
  count,
  actions,
  className,
}: Readonly<WorkbenchPageHeaderProps>): React.JSX.Element {
  return (
    <header
      className={cn(
        'flex min-h-12 shrink-0 items-center justify-between gap-4 border-b border-[var(--surface-border)] bg-page-canvas px-4 py-2.5',
        className
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-base font-medium text-foreground">{title}</h1>
          {typeof count === 'number' ? (
            <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
          ) : null}
        </div>
        {description ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
