import { formatDuration, formatTokensCompact } from '@renderer/utils/formatters';

import type { MemberFullStats } from '@shared/types';

interface MemberDetailStatsProps {
  stats: MemberFullStats | null;
  statsLoading?: boolean;
  statsError?: string | null;
  activityCount?: number;
}

function formatDurationShort(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMin}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export const MemberDetailStats = ({
  stats,
  statsLoading,
  activityCount,
}: MemberDetailStatsProps): React.JSX.Element => {
  const totalTokens = stats?.totalTokens ?? 0;

  const items = [
    {
      label: 'Sessions',
      value: statsLoading ? '...' : String(stats?.sessionCount ?? 0),
      sub: !statsLoading && stats ? `${stats.messageCount} messages` : undefined,
    },
    {
      label: 'Tokens',
      value: statsLoading ? '...' : formatTokensCompact(totalTokens),
    },
    {
      label: 'Duration',
      value: statsLoading
        ? '...'
        : stats?.totalDurationMs
          ? formatDurationShort(stats.totalDurationMs)
          : '—',
      sub: !statsLoading && stats?.tasksCompleted ? `${stats.tasksCompleted} completed` : undefined,
    },
    {
      label: 'Activity',
      value: String(activityCount ?? stats?.messageCount ?? 0),
    },
  ];

  return (
    <div className="grid min-w-0 flex-1 grid-cols-4 gap-1.5">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1.5"
        >
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm font-semibold tabular-nums text-[var(--color-text)]">
              {item.value}
            </span>
            <span className="text-[10px] text-[var(--color-text-muted)]">{item.label}</span>
          </div>
          {item.sub && (
            <span className="block text-[9px] text-[var(--color-text-muted)]">{item.sub}</span>
          )}
        </div>
      ))}
    </div>
  );
};
