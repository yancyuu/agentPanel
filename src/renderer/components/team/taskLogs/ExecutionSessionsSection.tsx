import { MemberLogsTab } from '@renderer/components/team/members/MemberLogsTab';
import { Loader2 } from 'lucide-react';

import type { ComponentProps } from 'react';

interface ExecutionSessionsSectionProps extends ComponentProps<typeof MemberLogsTab> {
  isRefreshing?: boolean;
  isPreviewOnline?: boolean;
}

export const ExecutionSessionsSection = ({
  isRefreshing = false,
  isPreviewOnline = false,
  ...props
}: ExecutionSessionsSectionProps): React.JSX.Element => {
  return (
    <div className="space-y-2">
      <div className="flex min-h-4 items-center justify-end gap-2">
        {isRefreshing || isPreviewOnline ? (
          <span className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
            {isPreviewOnline ? (
              <span
                className="pointer-events-none relative inline-flex size-2 shrink-0"
                title="在线"
              >
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
            ) : null}
            {isRefreshing ? (
              <span className="flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                更新中...
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        按执行会话查看与当前任务关联的运行记录。
      </p>
      <MemberLogsTab {...props} />
    </div>
  );
};
