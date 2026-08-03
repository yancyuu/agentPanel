// Tests for bin/lib/featureState.mjs — the extracted feature-state aggregator.
//
// The module-surface test statically imports featureState.mjs, which transitively
// pulls in env/auth/daemon/settings/usageRemote/uploadState/aikey/
// runtime — so a green run proves the whole import graph resolves (no missing
// export, no circular import) after the extraction from hermit.mjs.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control the /me probe + local fallback so refreshAuthCacheFromServer's cache
// contract is testable without a live server. Spread the real auth module so the
// other auth exports used transitively (by daemon/settings/runtime) stay intact.
const { meMock, localMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  localMock: vi.fn(),
}));
vi.mock('../auth.mjs', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    refreshOpenHermitAuthStatus: meMock,
    readOpenHermitAuthStatus: localMock,
  };
});

import {
  clearWebRunningOptimistic,
  currentFeatureStates,
  invalidateAuthCache,
  markWebRunningOptimistic,
  readAikeyClaimed,
  refreshAuthCacheFromServer,
  refreshWebRunningState,
} from '../featureState.mjs';

describe('featureState module surface (proves the import graph resolves)', () => {
  it('exports the state family as functions', () => {
    expect(typeof currentFeatureStates).toBe('function');
    expect(typeof readAikeyClaimed).toBe('function');
    expect(typeof refreshWebRunningState).toBe('function');
    expect(typeof markWebRunningOptimistic).toBe('function');
    expect(typeof clearWebRunningOptimistic).toBe('function');
  });

  it('mark/clearWebRunningOptimistic are safe no-arg setters (idempotent clear)', () => {
    expect(() => markWebRunningOptimistic()).not.toThrow();
    expect(() => clearWebRunningOptimistic()).not.toThrow();
    expect(() => clearWebRunningOptimistic()).not.toThrow();
  });
});

describe('readAikeyClaimed', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'featurestate-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('is false when aikey.env is absent', () => {
    expect(readAikeyClaimed(tmp)).toBe(false);
  });

  it('is true when aikey.env holds an *_API_KEY export', () => {
    writeFileSync(path.join(tmp, 'aikey.env'), 'export ANTHROPIC_API_KEY="sk-test"\n');
    expect(readAikeyClaimed(tmp)).toBe(true);
  });

  it('is true when aikey.env holds only an OPENHERMIT_ACTIVE_KEY label', () => {
    writeFileSync(path.join(tmp, 'aikey.env'), 'export OPENHERMIT_ACTIVE_KEY="demo"\n');
    expect(readAikeyClaimed(tmp)).toBe(true);
  });

  it('is false for a malformed / non-env aikey.env', () => {
    writeFileSync(path.join(tmp, 'aikey.env'), 'not an env file\n\nset X=1\n');
    expect(readAikeyClaimed(tmp)).toBe(false);
  });

  it('defaults to hermitHome when called with no argument (smoke — does not throw)', () => {
    expect(() => readAikeyClaimed()).not.toThrow();
  });
});

describe('usageReportingEnabled — 上报状态权威开关（telemetry.enabled）', () => {
  let tmp;
  let previousHermitHome;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'featurestate-usage-'));
    previousHermitHome = process.env.HERMIT_HOME;
    process.env.HERMIT_HOME = tmp;
  });
  afterEach(() => {
    if (previousHermitHome === undefined) delete process.env.HERMIT_HOME;
    else process.env.HERMIT_HOME = previousHermitHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('enabled=false 时关闭、enabled=true 时开启（worker 存活不决定标题语义）', async () => {
    meMock.mockResolvedValue({ authorized: false, developerMode: false });
    localMock.mockReturnValue({ authorized: false, developerMode: false });
    writeFileSync(
      path.join(tmp, 'settings.json'),
      JSON.stringify({ taskBus: { telemetry: { enabled: false } } })
    );
    vi.resetModules();
    let fresh = await import('../featureState.mjs');
    expect(fresh.currentFeatureStates().usageReportingEnabled).toBe(false);

    writeFileSync(
      path.join(tmp, 'settings.json'),
      JSON.stringify({ taskBus: { telemetry: { enabled: true } } })
    );
    vi.resetModules();
    fresh = await import('../featureState.mjs');
    expect(fresh.currentFeatureStates().usageReportingEnabled).toBe(true);

    // 缺失 settings 时默认关闭
    rmSync(path.join(tmp, 'settings.json'));
    vi.resetModules();
    fresh = await import('../featureState.mjs');
    expect(fresh.currentFeatureStates().usageReportingEnabled).toBe(false);
  });
});

describe('refreshAuthCacheFromServer — /me is authoritative, never clobbers a fresh cache', () => {
  // Reproduces "我明明登录了，但上报/状态都还显示未登录": the menu reads
  // currentFeatureStates().auth, which comes from _authProbeCache. Two failures
  // starved it of the truth — (1) the /me result wasn't written into the cache,
  // (2) syncRefreshAuthCache() OVERWROTE a fresh /me cache with a stale local
  // read on every action. The fix: /me populates the cache; a transient /me
  // failure must NOT wipe a fresh value.
  beforeEach(() => {
    invalidateAuthCache();
    meMock.mockReset();
    localMock.mockReset();
    localMock.mockReturnValue({ authorized: false, developerMode: false });
  });

  it('caches the /me result so currentFeatureStates() reads the server truth', async () => {
    meMock.mockResolvedValue({ authorized: true, account: { name: 'server-me' }, developerMode: false });
    await refreshAuthCacheFromServer();
    expect(currentFeatureStates().auth.authorized).toBe(true);
    expect(currentFeatureStates().auth.account?.name).toBe('server-me');
  });

  it('keeps a fresh /me cache when /me transiently fails (no clobber)', async () => {
    meMock.mockResolvedValueOnce({ authorized: true, account: { name: 'server-me' }, developerMode: false });
    await refreshAuthCacheFromServer();
    // /me now fails; the local snapshot disagrees. A fresh cache must survive.
    meMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await refreshAuthCacheFromServer();
    expect(currentFeatureStates().auth.authorized).toBe(true);
    expect(currentFeatureStates().auth.account?.name).toBe('server-me');
  });

  it('seeds from the local store when /me fails and the cache is empty', async () => {
    meMock.mockRejectedValueOnce(new Error('no server'));
    localMock.mockReturnValue({ authorized: false, developerMode: false });
    await refreshAuthCacheFromServer();
    expect(currentFeatureStates().auth.authorized).toBe(false);
    expect(localMock).toHaveBeenCalled();
  });

  it('never throws — a failing /me degrades to a snapshot, not a crash', async () => {
    meMock.mockRejectedValueOnce(new Error('boom'));
    await expect(refreshAuthCacheFromServer()).resolves.toBeDefined();
  });
});
