/**
 * Sentry initialisation for the **renderer** process.
 *
 * Must be called before `ReactDOM.createRoot()` in `main.tsx`.
 * Supports both Electron (preload bridge) and standalone browser mode.
 *
 * When `VITE_SENTRY_DSN` is not set (dev / self-builds), everything is a no-op.
 */

import {
  addBreadcrumb,
  browserTracingIntegration as reactBrowserTracing,
  captureException,
  init as reactInit,
  withScope,
} from '@sentry/react';
import {
  isValidDsn,
  SENTRY_ENVIRONMENT,
  SENTRY_RELEASE,
  TRACES_SAMPLE_RATE,
} from '@shared/utils/sentryConfig';

// ---------------------------------------------------------------------------
// Telemetry gate (mirrors src/main/sentry.ts pattern)
// ---------------------------------------------------------------------------

// Defaults to `true` so early renderer crashes are captured.
// Synced to user's telemetryEnabled preference via syncRendererTelemetry().
let telemetryAllowed = true;
let initialized = false;

/**
 * Sync the opt-in flag from config. Call after config is loaded
 * and whenever the user toggles telemetry in Settings.
 */
export function syncRendererTelemetry(enabled: boolean): void {
  telemetryAllowed = enabled;
}

export function initSentryRenderer(): void {
  if (initialized) return;

  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!isValidDsn(dsn)) return;

  const baseOptions = {
    dsn,
    release: SENTRY_RELEASE,
    environment: SENTRY_ENVIRONMENT,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-version @sentry/core type mismatch
  const beforeSend = (event: any): any => (telemetryAllowed ? event : null);

  // Web browser mode — direct HTTP transport
  reactInit({
    ...baseOptions,
    beforeSend,
    integrations: [reactBrowserTracing()],
  });

  initialized = true;
}

/** Whether the renderer SDK was successfully initialised. */
export function isSentryRendererActive(): boolean {
  return initialized;
}

// ---------------------------------------------------------------------------
// Public helpers (no-op when Sentry is not configured)
// ---------------------------------------------------------------------------

/** Record a navigation breadcrumb (tab switches). */
export function addNavigationBreadcrumb(from: string, to: string): void {
  if (!initialized) return;
  addBreadcrumb({
    category: 'navigation',
    message: `Tab: ${from} → ${to}`,
    level: 'info',
  });
}

/** Record a generic breadcrumb from the renderer. */
export function addRendererBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>
): void {
  if (!initialized) return;
  addBreadcrumb({ category, message, data, level: 'info' });
}

/** Capture an exception with optional extra context. */
export function captureRendererException(error: Error, context?: Record<string, unknown>): void {
  if (!initialized) return;
  withScope((scope) => {
    if (context) scope.setContext('react', context);
    captureException(error);
  });
}
