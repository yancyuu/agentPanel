import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CLI_STATUS_REFRESH_TTL_MS, refreshCliStatusForCurrentMode } from '../refreshCliStatus';

let now = 0;

beforeEach(() => {
  now += CLI_STATUS_REFRESH_TTL_MS + 1;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

describe('refreshCliStatusForCurrentMode', () => {
  it('coalesces simultaneous refreshes for the same mode', async () => {
    let resolveRefresh: (() => void) | undefined;
    const fetchCliStatus = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const bootstrapCliStatus = vi.fn<() => Promise<void>>();

    const first = refreshCliStatusForCurrentMode({
      multimodelEnabled: false,
      bootstrapCliStatus,
      fetchCliStatus,
    });
    const second = refreshCliStatusForCurrentMode({
      multimodelEnabled: false,
      bootstrapCliStatus,
      fetchCliStatus,
    });

    expect(fetchCliStatus).toHaveBeenCalledTimes(1);
    resolveRefresh?.();
    await Promise.all([first, second]);
  });

  it('throttles repeated refreshes completed within the TTL', async () => {
    const fetchCliStatus = vi.fn().mockResolvedValue(undefined);
    const bootstrapCliStatus = vi.fn<() => Promise<void>>();
    const options = {
      multimodelEnabled: false,
      bootstrapCliStatus,
      fetchCliStatus,
    };

    await refreshCliStatusForCurrentMode(options);
    now += CLI_STATUS_REFRESH_TTL_MS - 1;
    await refreshCliStatusForCurrentMode(options);

    expect(fetchCliStatus).toHaveBeenCalledTimes(1);

    now += 2;
    await refreshCliStatusForCurrentMode(options);

    expect(fetchCliStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps single-model and multimodel refresh throttles independent', async () => {
    const fetchCliStatus = vi.fn().mockResolvedValue(undefined);
    const bootstrapCliStatus = vi.fn().mockResolvedValue(undefined);

    await refreshCliStatusForCurrentMode({
      multimodelEnabled: false,
      bootstrapCliStatus,
      fetchCliStatus,
    });
    await refreshCliStatusForCurrentMode({
      multimodelEnabled: true,
      bootstrapCliStatus,
      fetchCliStatus,
    });

    expect(fetchCliStatus).toHaveBeenCalledTimes(1);
    expect(bootstrapCliStatus).toHaveBeenCalledWith({ multimodelEnabled: true });
  });

  it('does not throttle the next refresh after a rejected attempt', async () => {
    const fetchCliStatus = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    const bootstrapCliStatus = vi.fn<() => Promise<void>>();
    const options = {
      multimodelEnabled: false,
      bootstrapCliStatus,
      fetchCliStatus,
    };

    await expect(refreshCliStatusForCurrentMode(options)).rejects.toThrow('temporary failure');
    await expect(refreshCliStatusForCurrentMode(options)).resolves.toBeUndefined();

    expect(fetchCliStatus).toHaveBeenCalledTimes(2);
  });

  it('allows explicit user refreshes to bypass the completed-refresh throttle', async () => {
    const fetchCliStatus = vi.fn().mockResolvedValue(undefined);
    const bootstrapCliStatus = vi.fn<() => Promise<void>>();
    const options = {
      multimodelEnabled: false,
      bootstrapCliStatus,
      fetchCliStatus,
    };

    await refreshCliStatusForCurrentMode(options);
    await refreshCliStatusForCurrentMode({ ...options, force: true });

    expect(fetchCliStatus).toHaveBeenCalledTimes(2);
  });
});
