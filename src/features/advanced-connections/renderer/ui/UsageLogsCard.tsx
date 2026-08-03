import { useCallback, useEffect, useState } from 'react';

import { FileText, Loader2, RefreshCw } from 'lucide-react';

interface UsageLogFileTail {
  name: string;
  missing: boolean;
  lines: string[];
}

interface UsageLogsResponse {
  ok: boolean;
  tail: number;
  files: UsageLogFileTail[];
}

const TAIL_LINES = 50;

/**
 * 用量上报日志区：展示 conversation-upload.log / telemetry-worker.log 尾部，
 * 方便排查「到底发没发出去」。数据来自 GET /api/usage-logs?tail=N。
 */
export function UsageLogsCard(): React.JSX.Element {
  const [files, setFiles] = useState<UsageLogFileTail[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/usage-logs?tail=${TAIL_LINES}`, {
        headers: { Accept: 'application/json' },
      });
      const payload = (await response.json().catch(() => null)) as
        | (UsageLogsResponse & { error?: string })
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `读取日志失败（HTTP ${response.status}）`);
      }
      setFiles(payload?.files ?? []);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '读取日志失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)]"
      data-testid="usage-logs-card"
    >
      <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-[var(--color-text-muted)]" />
          <div>
            <h3 className="text-xs font-semibold text-[var(--color-text)]">用量上报日志</h3>
            <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              最近 {TAIL_LINES} 行，排查上报是否发出。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="刷新用量上报日志"
          className="grid size-8 place-items-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </button>
      </div>
      <div className="space-y-3 p-4">
        {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
        {(files ?? []).map((file) => (
          <div key={file.name}>
            <p className="mb-1 text-[11px] font-medium text-[var(--color-text-secondary)]">
              {file.name}
            </p>
            {file.missing ? (
              <p
                className="text-[11px] text-[var(--color-text-muted)]"
                data-testid={`usage-log-empty:${file.name}`}
              >
                日志文件不存在（还没有上报记录）。
              </p>
            ) : file.lines.length === 0 ? (
              <p className="text-[11px] text-[var(--color-text-muted)]">暂无日志内容。</p>
            ) : (
              <pre
                className="max-h-40 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-[10px] leading-4 text-[var(--color-text-secondary)]"
                data-testid={`usage-log-tail:${file.name}`}
              >
                {file.lines.join('\n')}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
