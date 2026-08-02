import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { formatDistanceToNow } from 'date-fns';
import { BookMarked, Loader2, PackageOpen } from 'lucide-react';

import type { TeamAssetsResponse } from '@shared/types';

function formatRelative(timestamp: string): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return null;
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * 员工产物库（只读）：openspec living specs 列表 + 最近沉淀记录。
 * 产物由 agent 经 OpenSpec CLI 在工作区沉淀，此处仅展示。
 */
export const TeamAssetsSection = ({ teamName }: { teamName: string }): React.JSX.Element => {
  const [assets, setAssets] = useState<TeamAssetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await api.teams.getTeamAssets(teamName);
        if (!cancelled) setAssets(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '产物库读取失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamName]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-[var(--color-text-muted)]">
        <Loader2 size={14} className="animate-spin" />
        正在读取产物库...
      </div>
    );
  }

  if (error) {
    return <p className="text-xs text-red-400">{error}</p>;
  }

  const specs = assets?.specs ?? [];
  const archives = assets?.archives ?? [];

  if (specs.length === 0 && archives.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-dashed border-[var(--color-border)] px-3 py-2.5 text-xs text-[var(--color-text-muted)]">
        <PackageOpen size={14} className="mt-0.5 shrink-0 opacity-60" />
        <span>
          还没有沉淀的产物。对员工说「沉淀一下」，把好的工作方式固化为可复用的工作流、技能或行为契约。
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="team-assets">
      {specs.length > 0 ? (
        <div className="space-y-1" data-testid="asset-spec-list">
          <div className="text-[10px] font-medium text-[var(--color-text-muted)]">
            Living specs（{specs.length}）
          </div>
          <ul className="space-y-0.5">
            {specs.map((spec) => (
              <li
                key={spec.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-raised)]"
              >
                <BookMarked size={13} className="shrink-0 text-indigo-400" />
                <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">
                  {spec.title}
                </span>
                {formatRelative(spec.updatedAt) ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                        更新于 {formatRelative(spec.updatedAt)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">{spec.updatedAt}</TooltipContent>
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {archives.length > 0 ? (
        <div className="space-y-1" data-testid="asset-archive-list">
          <div className="text-[10px] font-medium text-[var(--color-text-muted)]">
            最近沉淀记录（{archives.length}）
          </div>
          <ul className="space-y-0.5">
            {archives.map((archive) => (
              <li
                key={archive.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-raised)]"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-secondary)]">
                  {archive.id}
                </span>
                {archive.operations.length > 0 ? (
                  <span className="flex shrink-0 items-center gap-1">
                    {archive.operations.map((operation) => (
                      <span
                        key={operation}
                        className="rounded bg-[var(--color-surface-raised)] px-1 py-0.5 text-[9px] font-medium text-[var(--color-text-muted)]"
                      >
                        {operation}
                      </span>
                    ))}
                  </span>
                ) : null}
                {formatRelative(archive.archivedAt) ? (
                  <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                    {formatRelative(archive.archivedAt)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};
