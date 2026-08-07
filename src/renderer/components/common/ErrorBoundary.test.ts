import { describe, expect, it, vi } from 'vitest';

import { isStaleChunkError, maybeReloadForStaleChunk } from './ErrorBoundary';

// A minimal in-memory Storage replacement so tests don't touch real
// sessionStorage and can inject a controllable clock.
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe('isStaleChunkError', () => {
  it('matches every browser phrasing of the dynamic-import-fetch failure', () => {
    // Chrome
    expect(
      isStaleChunkError(
        new TypeError(
          'Failed to fetch dynamically imported module: http://127.0.0.1:5680/assets/ProjectEditorOverlay-DXas05kA.js'
        )
      )
    ).toBe(true);
    // Firefox
    expect(isStaleChunkError(new Error('error loading dynamically imported module'))).toBe(true);
    // Safari
    expect(isStaleChunkError(new Error('Importing a module script failed'))).toBe(true);
  });

  it('rejects unrelated errors and non-Error values', () => {
    expect(
      isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'map')"))
    ).toBe(false);
    expect(isStaleChunkError(new Error('Network request failed'))).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
    expect(isStaleChunkError({ message: 'Failed to fetch dynamically imported module: x' })).toBe(
      false
    );
  });
});

describe('maybeReloadForStaleChunk', () => {
  it('reloads on the first call and records the timestamp', () => {
    const storage = makeStorage();
    const reload = vi.fn();
    const now = vi.fn(() => 1_000_000);

    expect(maybeReloadForStaleChunk({ now, storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem('openhermit:staleChunkReloadAt')).toBe('1000000');
  });

  it('does NOT reload again within the cooldown (breaks the loop on a genuinely broken chunk)', () => {
    const storage = makeStorage();
    const reload = vi.fn();
    let t = 1_000_000;
    const now = vi.fn(() => t);

    expect(maybeReloadForStaleChunk({ now, storage, reload })).toBe(true);
    t += 3_000; // within the 10s cooldown
    expect(maybeReloadForStaleChunk({ now, storage, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again after the cooldown so a later deploy still auto-recovers', () => {
    const storage = makeStorage();
    const reload = vi.fn();
    let t = 1_000_000;
    const now = vi.fn(() => t);

    maybeReloadForStaleChunk({ now, storage, reload });
    t += 11_000; // past the cooldown
    expect(maybeReloadForStaleChunk({ now, storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
