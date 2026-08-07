import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { ChevronRight } from 'lucide-react';

function scrollAfterExpand(el: HTMLElement): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

interface CollapsibleTeamSectionProps {
  title: string;
  /** Icon rendered before the title text. */
  icon?: React.ReactNode;
  badge?: string | number;
  /** Secondary badge (e.g. unread count). Shown next to main badge when defined. */
  secondaryBadge?: number;
  /** Element rendered immediately after secondary badge (e.g. mark-all-read button). */
  afterBadge?: React.ReactNode;
  /** Extra element rendered inline after badges (e.g. notification icon). */
  headerExtra?: React.ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  action?: React.ReactNode;
  /** Stable identifier used for programmatic section navigation. */
  sectionId?: string;
  /** Extra classes applied to the content wrapper (e.g. padding). */
  contentClassName?: string;
  /** Extra classes for the outer content wrapper (e.g. remove default top/bottom gaps). */
  contentWrapperClassName?: string;
  /** Extra classes for the header bar (e.g. "-mx-6 w-[calc(100%+3rem)]" to match parent padding). */
  headerClassName?: string;
  /** Extra classes for the inner header content (e.g. "pl-6" to match parent padding). */
  headerContentClassName?: string;
  /** Extra classes for the clickable header surface itself (e.g. override rounded corners). */
  headerSurfaceClassName?: string;
  /** When true, children stay mounted (hidden via CSS) when collapsed. Useful when children drive header state (e.g. online indicators). */
  keepMounted?: boolean;
  children: React.ReactNode;
}

export const CollapsibleTeamSection = ({
  title,
  icon,
  badge,
  secondaryBadge,
  afterBadge,
  headerExtra,
  defaultOpen = true,
  forceOpen,
  onOpenChange,
  action,
  sectionId,
  contentClassName,
  contentWrapperClassName,
  headerClassName,
  headerContentClassName,
  headerSurfaceClassName,
  keepMounted,
  children,
}: CollapsibleTeamSectionProps): React.JSX.Element => {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen ? true : open;
  const sectionRef = useRef<HTMLElement>(null);

  const handleNavigate = useCallback((): void => {
    setOpen(true);
    if (sectionRef.current) scrollAfterExpand(sectionRef.current);
  }, []);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    el.addEventListener('team-section-navigate', handleNavigate);
    return () => el.removeEventListener('team-section-navigate', handleNavigate);
  }, [handleNavigate]);

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  return (
    <section ref={sectionRef} data-section-id={sectionId} className="min-w-0">
      <div className={cn('flex min-h-7 items-center gap-2', headerClassName)}>
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-[var(--color-section-bg)]',
            headerSurfaceClassName
          )}
          onClick={() =>
            setOpen((prev) => {
              const next = !prev;
              if (next && sectionRef.current) {
                scrollAfterExpand(sectionRef.current);
              }
              return next;
            })
          }
          aria-label={isOpen ? '收起区域' : '展开区域'}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-[var(--color-text-muted)] opacity-50 transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
          />
          {icon ? (
            <span className="shrink-0 text-[var(--color-text-muted)] opacity-60">{icon}</span>
          ) : null}
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {title}
          </span>
          {badge != null && (
            <span className="text-[10px] tabular-nums text-[var(--color-text-muted)] opacity-50">
              {badge}
            </span>
          )}
          {secondaryBadge != null && secondaryBadge > 0 && (
            <span
              className="text-[10px] tabular-nums text-indigo-400 opacity-70"
              title={`${secondaryBadge} unread`}
            >
              +{secondaryBadge}
            </span>
          )}
          {afterBadge}
          {headerExtra}
        </button>
        {action && <div className="flex shrink-0 items-center">{action}</div>}
      </div>
      {keepMounted ? (
        <div
          className={cn(
            'min-w-0 overflow-x-clip pb-2 pt-1',
            contentWrapperClassName,
            contentClassName
          )}
          style={isOpen ? undefined : { display: 'none' }}
        >
          {children}
        </div>
      ) : (
        isOpen && (
          <div
            className={cn(
              'min-w-0 overflow-x-clip pb-2 pt-1',
              contentWrapperClassName,
              contentClassName
            )}
          >
            {children}
          </div>
        )
      )}
    </section>
  );
};
