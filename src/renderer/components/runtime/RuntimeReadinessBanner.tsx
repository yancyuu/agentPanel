import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { cn } from '@renderer/lib/utils';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';

import type { RuntimeReadiness } from '@shared/types/runtimeReadiness';

/**
 * RuntimeReadinessBanner — top-of-app degraded banner.
 *
 * Polls GET /api/v1/system/readiness and, while cc-connect is not ready
 * (binary missing OR sidecar offline), shows a yellow banner explaining the
 * problem and the exact remediation steps. Hides automatically once the runtime
 * becomes healthy (e.g. after the user installs cc-connect and restarts).
 *
 * CRASH-SAFETY CONTRACT: this component MUST NEVER throw. It is rendered at the
 * app root (inside App's ErrorBoundary but above TabbedLayout); an uncaught
 * exception here takes down the whole workbench. Every field access is
 * defensive and the render is wrapped — worst case the banner simply hides.
 *
 * Why this exists: previously a missing cc-connect surfaced only later as a
 * cryptic "fetch failed" when saving team config. The banner turns that into a
 * visible, actionable state at app-entry.
 *
 * Dismissable per-session (collapsed until next readiness change) so it does
 * not nag power users running an externally-managed bridge who intentionally
 * ignore the status.
 */
export const RuntimeReadinessBanner = () => {
  const [readiness, setReadiness] = useState<RuntimeReadiness | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api.systemReadiness.getStatus();
        if (!cancelled) setReadiness(data);
      } catch {
        /* network down — keep last known state; banner will retry */
      }
    };
    void poll();
    // Poll every 10s: cheap endpoint, and lets the banner self-clear once the
    // sidecar finishes coming up (which can take ~30s on cold boot).
    const timer = window.setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Defensive: tolerate ANY shape from the API (early boot, partial payload,
  // unexpected undefined fields). If we cannot confidently read the degraded
  // state, hide the banner rather than risk throwing.
  const binaryState = readiness?.bridgeBinary;
  const launchState = readiness?.bridgeLaunch;
  const overallOk =
    readiness?.status === 'ok' ||
    (binaryState?.status === 'ok' && launchState?.status === 'running');
  // The local Direct CLI runtime remains available when the optional external
  // channel plugin is disabled, so this is not a degraded desktop state.
  if (!readiness || readiness.status === 'disabled' || overallOk) return null;

  // Guard: only render when we have a clear "degraded" signal we can read.
  const binaryDegraded = binaryState?.status === 'degraded' ? binaryState : null;
  const launchOffline = launchState?.status === 'offline' ? launchState : null;
  // If neither sub-state is readable as degraded, bail out — safer to hide.
  if (!binaryDegraded && !launchOffline) return null;

  const binaryStatusKey = binaryState?.status ?? 'unknown';
  const launchStatusKey = launchState?.status ?? 'unknown';
  const stateKey = `${binaryStatusKey}:${launchStatusKey}`;
  if (dismissedKey === stateKey) return null;

  const reason = binaryDegraded?.reason || launchOffline?.reason || '运行时未就绪';
  const remediation = binaryDegraded
    ? (binaryDegraded.remediation ?? [])
    : ['请等待 cc-connect 启动，或检查端口 9820/9810 是否被占用'];

  return (
    <div
      className={cn(
        'flex items-start gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-200'
      )}
      role="status"
      aria-live="polite"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">cc-connect 运行时未就绪：团队配置、消息收发等功能将不可用</div>
        <div className="mt-0.5 text-xs text-amber-200/70">原因：{reason}</div>
        {remediation.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-200/80">
            {remediation.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        className="mt-0.5 inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-amber-200/70 hover:bg-amber-500/20 hover:text-amber-100"
        onClick={() => window.location.reload()}
        title="刷新页面重新检测"
      >
        <RefreshCw className="size-3" />
        重试
      </button>
      <button
        type="button"
        className="mt-0.5 inline-flex size-6 items-center justify-center rounded text-amber-200/70 hover:bg-amber-500/20 hover:text-amber-100"
        onClick={() => setDismissedKey(stateKey)}
        title="本次会话内隐藏（状态变化后会重新出现）"
        aria-label="隐藏横幅"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
};
