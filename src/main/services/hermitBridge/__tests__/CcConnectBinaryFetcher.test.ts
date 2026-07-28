import { describe, expect, it } from 'vitest';

import { ensureCcConnectBinary } from '../CcConnectBinaryFetcher';

// We only test the pure, side-effect-free pieces reachable without network:
// the mirror URL ordering + platform detection (via observable behavior of
// ensureCcConnectBinary when the platform is unsupported / version unknown).
// Full download is exercised manually against a real release.

describe('ensureCcConnectBinary', () => {
  it('rejects an already-aborted preparation before filesystem or network work', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      ensureCcConnectBinary('/tmp/hermit-test', controller.signal)
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('returns null for an unsupported platform/arch combo', async () => {
    // Force an unsupported combination via process override shim.
    const origPlatform = process.platform;
    const origArch = process.arch;
    Object.defineProperty(process, 'platform', {
      value: 'freebsd' as NodeJS.Platform,
      configurable: true,
    });
    Object.defineProperty(process, 'arch', {
      value: 's390x' as NodeJS.Architecture,
      configurable: true,
    });
    try {
      const result = await ensureCcConnectBinary('/tmp/hermit-test');
      expect(result).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
    }
  });

  it('does not throw on an unsupported platform — degrades gracefully', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'aix' as NodeJS.Platform,
      configurable: true,
    });
    try {
      await expect(ensureCcConnectBinary('/tmp/hermit-test')).resolves.toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });
});
