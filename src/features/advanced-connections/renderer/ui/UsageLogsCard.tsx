import { useCallback, useEffect, useState } from 'react';

import { FileText, Loader2, RefreshCw } from 'lucide-react';

interface AgentBusHttpLogEntry {
  ts: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  requestSummary?: string;
  responseSummary?: string;
  error?: string;
}

interface UsageLogFileTail {
  name: string;
  missing: boolean;
  lines: string[];
}

interface UsageLogsResponse {
  ok: boolean;
  tail: number;
  httpEntries: AgentBusHttpLogEntry[];
  files: UsageLogFileTail[];
}

const TAIL_LINES = 50;

function formatTime(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function statusClassName(status: number): string {
  if (status >= 200 && status < 300)
    return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  if (status >= 400 && status < 500) return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
  if (status >= 500) return 'bg-rose-500/10 text-rose-500 dark:text-rose-400';
  return 'bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]';
}

function statusLabel(entry: AgentBusHttpLogEntry): string {
  return entry.status > 0 ? String(entry.status) : '网络错误';
}

/**
 * 服务日志：AgentBus 出站请求记录（方法/路径/状态码/耗时，可展开看请求与返回摘要）
 * + 用量上报相关文件尾部，方便排查「到底发没发出去、服务端回了什么」。
 * 数据来自 GET /api/usage-logs?tail=N。
 */
export function UsageLogsCard(): React.JSX.Element {
  const [httpEntries, setHttpEntries] = useState<AgentBusHttpLogEntry[]>([]);
  const [files, setFiles] = useState<UsageLogFileTail[]>([]);
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
      setHttpEntries(payload?.httpEntries ?? []);
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
            <h3 className="text-xs font-semibold text-[var(--color-text)]">服务日志</h3>
            <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              AgentBus 出站请求与返回（最近 {TAIL_LINES} 条），排查上报是否发出。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="刷新服务日志"
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

        <div>
          <p className="mb-1 text-[11px] font-medium text-[var(--color-text-secondary)]">
            请求记录（agentbus-http.log）
          </p>
          {httpEntries.length === 0 ? (
            <p
              className="text-[11px] text-[var(--color-text-muted)]"
              data-testid="service-log-empty"
            >
              暂无出站请求记录。
            </p>
          ) : (
            <div className="space-y-1" data-testid="service-log-entries">
              {httpEntries.map((entry, index) => (
                <details
                  key={`${entry.ts}:${index}`}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5"
                  data-testid="service-log-entry"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
                    <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                      {formatTime(entry.ts)}
                    </span>
                    <span className="shrink-0 font-medium">{entry.method}</span>
                    <span className="min-w-0 flex-1 truncate">{entry.url}</span>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusClassName(entry.status)}`}
                    >
                      {statusLabel(entry)}
                    </span>
                    <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                      {entry.durationMs}ms
                    </span>
                  </summary>
                  {entry.error ? (
                    <p className="mt-1.5 text-[11px] text-rose-500">{entry.error}</p>
                  ) : null}
                  {entry.requestSummary ? (
                    <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--color-border)] px-2 py-1 text-[10px] leading-4 text-[var(--color-text-muted)]">
                      {`请求：${entry.requestSummary}`}
                    </pre>
                  ) : null}
                  {entry.responseSummary ? (
                    <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--color-border)] px-2 py-1 text-[10px] leading-4 text-[var(--color-text-muted)]">
                      {`返回：${entry.responseSummary}`}
                    </pre>
                  ) : null}
                </details>
              ))}
            </div>
          )}
        </div>

        {files.map((file) => (
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
