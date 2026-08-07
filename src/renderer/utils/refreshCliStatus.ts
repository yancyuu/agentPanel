interface RefreshCliStatusOptions {
  multimodelEnabled: boolean;
  bootstrapCliStatus: (options?: { multimodelEnabled?: boolean }) => Promise<void>;
  fetchCliStatus: () => Promise<void>;
  force?: boolean;
}

export const CLI_STATUS_REFRESH_TTL_MS = 5_000;

type RefreshMode = 'multimodel' | 'single-model';

const inFlightRefreshes = new Map<RefreshMode, Promise<void>>();
const lastRefreshCompletedAt = new Map<RefreshMode, number>();

export function refreshCliStatusForCurrentMode({
  multimodelEnabled,
  bootstrapCliStatus,
  fetchCliStatus,
  force = false,
}: RefreshCliStatusOptions): Promise<void> {
  const mode: RefreshMode = multimodelEnabled ? 'multimodel' : 'single-model';
  const inFlight = inFlightRefreshes.get(mode);
  if (inFlight) {
    return inFlight;
  }

  const completedAt = lastRefreshCompletedAt.get(mode);
  if (!force && completedAt !== undefined && Date.now() - completedAt < CLI_STATUS_REFRESH_TTL_MS) {
    return Promise.resolve();
  }

  const refresh = multimodelEnabled
    ? bootstrapCliStatus({ multimodelEnabled: true })
    : fetchCliStatus();
  const trackedRefresh = refresh
    .then(() => {
      lastRefreshCompletedAt.set(mode, Date.now());
    })
    .finally(() => {
      inFlightRefreshes.delete(mode);
    });
  inFlightRefreshes.set(mode, trackedRefresh);
  return trackedRefresh;
}
