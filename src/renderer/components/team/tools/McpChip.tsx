/**
 * McpChip — compact chip for an installed MCP server.
 * Shows server name, status dot, and remove button on hover.
 */

import { X } from 'lucide-react';

import type { InstalledMcpEntry, McpServerDiagnostic } from '@shared/types/extensions';

interface McpChipProps {
  entry: InstalledMcpEntry;
  diagnostic?: McpServerDiagnostic;
  onRemove: (entry: InstalledMcpEntry) => void;
}

export const McpChip = ({ entry, diagnostic, onRemove }: McpChipProps): React.JSX.Element => {
  // Default to green ("connected"). Only show a problem color when diagnostics
  // explicitly report a failure or an auth requirement; absent/unknown status
  // (e.g. diagnostics endpoint unavailable) is treated as healthy.
  const statusColor =
    diagnostic?.status === 'failed'
      ? 'bg-red-500'
      : diagnostic?.status === 'needs-authentication'
        ? 'bg-amber-500'
        : 'bg-emerald-500';

  return (
    <div className="group inline-flex items-center gap-1.5 rounded-full bg-[var(--color-bg-secondary)] px-2.5 py-1 text-xs transition-colors hover:bg-[var(--color-bg-secondary-hover)]">
      <span
        className={`size-2 shrink-0 rounded-full ${statusColor}`}
        title={diagnostic?.status ?? 'unknown'}
      />
      <span className="max-w-[120px] truncate text-[var(--color-text)]">{entry.name}</span>
      <button
        type="button"
        className="shrink-0 rounded-full p-0.5 opacity-0 transition-opacity hover:bg-red-500/20 group-hover:opacity-100"
        onClick={() => onRemove(entry)}
        aria-label={`从当前项目移除 MCP 实例 ${entry.name}`}
        title="移除项目实例"
      >
        <X size={10} className="text-[var(--color-text-muted)] hover:text-red-400" />
      </button>
    </div>
  );
};
