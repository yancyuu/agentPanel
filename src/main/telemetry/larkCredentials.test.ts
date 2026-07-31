/**
 * Tests for lark / feishu credential reporting in the telemetry worker. The
 * module under test reads from lark-cli's local store (macOS Keychain + ~/Library/
 * Application Support/lark-cli, or Windows DPAPI), but on Linux CI runners those
 * stores are absent. The `__lookupForTests` hook lets us bypass the disk read so
 * we can exercise the full success path end-to-end against a stub `fetch`.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __internals,
  buildLarkBatchPayload,
  type GetLarkCredentialsAllResult,
  getLarkCredentialsFreshAll,
  type LarkCredentials,
  meetsBatchFieldConstraints,
  parseLarkCliPersonalAuthorizations,
  refreshLarkCredentialsDirect,
  reportAllLarkCredentials,
  resolveBrandForProfile,
  shouldRefreshLarkCredentials,
} from './larkCredentials';

const TEST_CRED: LarkCredentials = {
  appId: 'cli_app_1',
  appSecret: 'should-never-leave-this-test',
  accessToken: 'u-at-1',
  refreshToken: 'u-rt-1',
  userOpenId: 'ou_test_user',
  brand: 'feishu',
  scope: 'contact:user.base:readonly',
  expiresAt: 1_900_000_000_000,
  refreshExpiresAt: 1_900_000_000_000,
};

function makeFetchMock(
  status = 200,
  body = ''
): {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('lark-cli profile authorization discovery', () => {
  it('infers the lark brand for a single-account refresh when callers omit brand', () => {
    const authorizations = [
      { profileName: 'intl', appId: 'cli_lark', userOpenId: 'ou_lark', brand: 'lark' },
      { profileName: 'cn', appId: 'cli_feishu', userOpenId: 'ou_feishu', brand: 'feishu' },
    ];
    expect(
      resolveBrandForProfile({ appId: 'cli_lark', userOpenId: 'ou_lark' }, authorizations)
    ).toBe('lark');
    expect(
      resolveBrandForProfile({ appId: 'cli_feishu', userOpenId: 'ou_feishu' }, authorizations)
    ).toBe('feishu');
    // No matching profile retains the backwards-compatible Feishu fallback.
    expect(
      resolveBrandForProfile({ appId: 'unknown', userOpenId: 'ou_unknown' }, authorizations)
    ).toBe('feishu');
  });

  it('keeps the exact profile name when auth metadata identifies a personal authorization', () => {
    expect(
      parseLarkCliPersonalAuthorizations({ name: '2222', appId: 'cli_aadcbb097af8dd2c' }, [
        {
          appId: 'cli_aadcbb097af8dd2c',
          userOpenId: 'ou_target_user',
        },
      ])
    ).toEqual([
      {
        profileName: '2222',
        appId: 'cli_aadcbb097af8dd2c',
        userOpenId: 'ou_target_user',
        brand: 'feishu',
      },
    ]);
  });

  it('rejects auth metadata whose app identity does not match the profile', () => {
    expect(
      parseLarkCliPersonalAuthorizations({ name: '2222', appId: 'cli_aadcbb097af8dd2c' }, [
        { appId: 'cli_other', userOpenId: 'ou_target_user' },
      ])
    ).toEqual([]);
  });

  it('parses Windows CLI JSON with a BOM, warning prefix, and Chinese fields', () => {
    expect(
      __internals.parseLarkCliJsonOutput(
        '\uFEFFwarning: using cached profile\r\n[{"appId":"cli_cn","userOpenId":"ou_cn","userName":"测试用户"}]'
      )
    ).toEqual([{ appId: 'cli_cn', userOpenId: 'ou_cn', userName: '测试用户' }]);
  });
});
describe('lark-cli profile selection', () => {
  it('uses the profile name for an app instead of assuming it equals the appId', () => {
    expect(
      __internals.pickProfileNameByAppId(
        [
          { appId: 'cli_default', name: 'cli_default' },
          { appId: 'cli_worker', name: 'support-worker' },
        ],
        'cli_worker'
      )
    ).toBe('support-worker');
  });

  it('falls back to the appId when its profile cannot be listed', () => {
    expect(__internals.pickProfileNameByAppId([], 'cli_default')).toBe('cli_default');
  });
});

describe('shouldRefreshLarkCredentials', () => {
  const NOW = 1_700_000_000_000;
  const cred = (refreshExpiresAt: number): LarkCredentials => ({ ...TEST_CRED, refreshExpiresAt });

  it('refreshes when the personal refresh token expires in the future', () => {
    expect(shouldRefreshLarkCredentials(cred(NOW + 60_000), NOW)).toBe(true);
  });

  it('skips refresh when the refresh token is already expired', () => {
    expect(shouldRefreshLarkCredentials(cred(NOW - 1), NOW)).toBe(false);
  });

  it('treats the exact expiry moment as expired (strictly greater-than)', () => {
    expect(shouldRefreshLarkCredentials(cred(NOW), NOW)).toBe(false);
  });

  it('skips refresh when refreshExpiresAt is missing/zero', () => {
    expect(shouldRefreshLarkCredentials(cred(0), NOW)).toBe(false);
    expect(shouldRefreshLarkCredentials(undefined, NOW)).toBe(false);
  });

  it('skips refresh for non-finite (corrupt) expiry values', () => {
    expect(shouldRefreshLarkCredentials(cred(Number.NaN), NOW)).toBe(false);
    expect(shouldRefreshLarkCredentials(cred(Number.POSITIVE_INFINITY), NOW)).toBe(false);
  });
});

describe('refresh-lock storage location', () => {
  it('keeps agentcli locks out of the lark-cli credential directory', () => {
    const lockPath = __internals.directRefreshLockPath('cli_app:ou_user');
    expect(lockPath).toContain('agentcli-lark-refresh-locks');
    expect(lockPath).not.toContain('Application Support/lark-cli');
  });
});

describe('direct Lark OAuth refresh', () => {
  const NOW = 1_700_000_000_000;
  const stored = JSON.stringify({
    appId: TEST_CRED.appId,
    userOpenId: TEST_CRED.userOpenId,
    accessToken: TEST_CRED.accessToken,
    refreshToken: TEST_CRED.refreshToken,
    expiresAt: TEST_CRED.expiresAt,
    refreshExpiresAt: TEST_CRED.refreshExpiresAt,
    scope: TEST_CRED.scope,
    grantedAt: 1_600_000_000_000,
    futureField: 'preserve-me',
  });

  function oauthResponse(overrides: Record<string, unknown> = {}) {
    return new Response(
      JSON.stringify({
        code: 0,
        access_token: `new-access-${'a'.repeat(40)}`,
        refresh_token: `new-refresh-${'b'.repeat(40)}`,
        expires_in: 7_200,
        refresh_token_expires_in: 2_592_000,
        scope: 'contact:user.base:readonly offline_access',
        ...overrides,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  it.each([
    ['feishu', 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'],
    ['lark', 'https://open.larksuite.com/open-apis/authen/v2/oauth/token'],
  ])('uses the %s OAuth v2 endpoint and exact refresh-token grant', async (brand, endpoint) => {
    const fetchImpl = vi.fn(async () => oauthResponse()) as unknown as typeof fetch;
    const writeStoredToken = vi.fn(async (_account: string, _value: string) => undefined);

    const result = await refreshLarkCredentialsDirect(
      { ...TEST_CRED, brand },
      {
        now: () => NOW,
        fetchImpl,
        readStoredToken: async () => stored,
        writeStoredToken,
      }
    );

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe(endpoint);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: 'refresh_token',
      client_id: TEST_CRED.appId,
      client_secret: TEST_CRED.appSecret,
      refresh_token: TEST_CRED.refreshToken,
    });
    expect(JSON.parse(writeStoredToken.mock.calls[0][1])).toMatchObject({
      accessToken: `new-access-${'a'.repeat(40)}`,
      refreshToken: `new-refresh-${'b'.repeat(40)}`,
      expiresAt: NOW + 7_200_000,
      refreshExpiresAt: NOW + 2_592_000_000,
      scope: 'contact:user.base:readonly offline_access',
      grantedAt: 1_600_000_000_000,
      futureField: 'preserve-me',
    });
  });

  it('rereads the current token before refresh and persists the rotated pair', async () => {
    const currentRefreshToken = `current-refresh-${'c'.repeat(40)}`;
    const fetchImpl = vi.fn(async () => oauthResponse()) as unknown as typeof fetch;
    const writeStoredToken = vi.fn(async (_account: string, _value: string) => undefined);

    const result = await refreshLarkCredentialsDirect(TEST_CRED, {
      now: () => NOW,
      fetchImpl,
      readStoredToken: async () =>
        JSON.stringify({ ...JSON.parse(stored), refreshToken: currentRefreshToken }),
      writeStoredToken,
    });

    expect(result).toMatchObject({
      ok: true,
      credentials: {
        accessToken: `new-access-${'a'.repeat(40)}`,
        refreshToken: `new-refresh-${'b'.repeat(40)}`,
        expiresAt: NOW + 7_200_000,
        refreshExpiresAt: NOW + 2_592_000_000,
      },
    });
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]?.body)).refresh_token).toBe(
      currentRefreshToken
    );
    expect(writeStoredToken).toHaveBeenCalledOnce();
  });

  it('rejects HTTP 200 semantic errors and never writes them', async () => {
    const writeStoredToken = vi.fn(async (_account: string, _value: string) => undefined);
    const result = await refreshLarkCredentialsDirect(TEST_CRED, {
      now: () => NOW,
      fetchImpl: vi.fn(async () =>
        oauthResponse({ code: 20037, msg: 'refresh token expired' })
      ) as unknown as typeof fetch,
      readStoredToken: async () => stored,
      writeStoredToken,
    });

    expect(result).toMatchObject({ ok: false, kind: 'oauth-error', code: 20037 });
    expect(writeStoredToken).not.toHaveBeenCalled();
  });

  it('does not call OAuth or write when the stored refresh token is expired', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const writeStoredToken = vi.fn(async (_account: string, _value: string) => undefined);
    const result = await refreshLarkCredentialsDirect(TEST_CRED, {
      now: () => NOW,
      fetchImpl,
      readStoredToken: async () => JSON.stringify({ ...JSON.parse(stored), refreshExpiresAt: NOW }),
      writeStoredToken,
    });

    expect(result).toMatchObject({ ok: false, kind: 'refresh-expired' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writeStoredToken).not.toHaveBeenCalled();
  });

  it('fails closed when persistence fails after token rotation', async () => {
    const result = await refreshLarkCredentialsDirect(TEST_CRED, {
      now: () => NOW,
      fetchImpl: vi.fn(async () => oauthResponse()) as unknown as typeof fetch,
      readStoredToken: async () => stored,
      writeStoredToken: async () => {
        throw new Error(
          `app_secret=${TEST_CRED.appSecret} refresh_token=${TEST_CRED.refreshToken}`
        );
      },
    });

    expect(result).toMatchObject({ ok: false, kind: 'persist-failed' });
    if (!result.ok) {
      expect(result.message).not.toContain(TEST_CRED.appSecret);
      expect(result.message).not.toContain(TEST_CRED.refreshToken);
      expect(result.message).toContain('[hidden]');
    }
  });

  it('retries once with the re-read token when another writer rotated the refresh token mid-flight', async () => {
    // The race this guards: lark-cli (or any other tool sharing the store) rotated
    // the refresh token between our read and our redeem, so the server rejects
    // OUR token as already-used. The re-read inside the lock then shows a NEW
    // refresh token — retry with it instead of failing the report.
    const rotatedRefresh = `rotated-${'d'.repeat(40)}`;
    const rotatedStored = JSON.stringify({ ...JSON.parse(stored), refreshToken: rotatedRefresh });
    let reads = 0;
    const sentRefreshTokens: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sentRefreshTokens.push(JSON.parse(String(init?.body)).refresh_token);
      if (sentRefreshTokens.length === 1) {
        return oauthResponse({ code: 20037, msg: 'refresh token is invalid' });
      }
      return oauthResponse();
    }) as unknown as typeof fetch;
    const writeStoredToken = vi.fn(async (_account: string, _value: string) => undefined);

    const result = await refreshLarkCredentialsDirect(TEST_CRED, {
      now: () => NOW,
      fetchImpl,
      readStoredToken: async () => (++reads === 1 ? stored : rotatedStored),
      writeStoredToken,
    });

    expect(result.ok).toBe(true);
    expect(sentRefreshTokens).toEqual([TEST_CRED.refreshToken, rotatedRefresh]);
    expect(writeStoredToken).toHaveBeenCalledOnce();
  });

  it('does NOT retry when the re-read refresh token is unchanged after an oauth-error', async () => {
    // No other writer rotated anything — the server genuinely rejects this token.
    // A retry would repeat the identical failing request, so fail fast.
    const fetchImpl = vi.fn(async () =>
      oauthResponse({ code: 20037, msg: 'refresh token is invalid' })
    ) as unknown as typeof fetch;

    const result = await refreshLarkCredentialsDirect(TEST_CRED, {
      now: () => NOW,
      fetchImpl,
      readStoredToken: async () => stored,
      writeStoredToken: async () => undefined,
    });

    expect(result).toMatchObject({ ok: false, kind: 'oauth-error', code: 20037 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('removes an orphaned refresh lock whose owner process no longer exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lark-refresh-lock-'));
    try {
      const lockPath = path.join(dir, 'orphan.lock');
      await writeFile(lockPath, '999999999\n');
      await expect(__internals.removeOrphanedRefreshLock(lockPath)).resolves.toBe(true);
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a vanished lock file as removable but keeps a live unparsable lock until it is stale', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lark-refresh-lock-'));
    try {
      // Gone between our open attempt and the orphan check → caller may retry at once.
      await expect(
        __internals.removeOrphanedRefreshLock(path.join(dir, 'gone.lock'))
      ).resolves.toBe(true);

      // A freshly created lock whose owner has not written its pid yet (content
      // unparsable) must NOT be broken — that is the create/write race window.
      const freshLock = path.join(dir, 'fresh.lock');
      await writeFile(freshLock, '');
      await expect(__internals.removeOrphanedRefreshLock(freshLock)).resolves.toBe(false);
      expect(await readFile(freshLock, 'utf8')).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent refreshes for the same account and rereads after acquiring the lock', async () => {
    let current = stored;
    let active = 0;
    let maxActive = 0;
    const seenRefreshTokens: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const sent = JSON.parse(String(init?.body)).refresh_token;
      seenRefreshTokens.push(sent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return oauthResponse({
        access_token: `access-${seenRefreshTokens.length}-${'a'.repeat(40)}`,
        refresh_token: `refresh-${seenRefreshTokens.length}-${'b'.repeat(40)}`,
      });
    }) as unknown as typeof fetch;
    const deps = {
      now: () => NOW,
      fetchImpl,
      readStoredToken: async () => current,
      writeStoredToken: async (_account: string, value: string) => {
        current = value;
      },
    };

    await Promise.all([
      refreshLarkCredentialsDirect(TEST_CRED, deps),
      refreshLarkCredentialsDirect(TEST_CRED, deps),
    ]);

    expect(maxActive).toBe(1);
    expect(seenRefreshTokens).toEqual([TEST_CRED.refreshToken, `refresh-1-${'b'.repeat(40)}`]);
  });
});

describe('getLarkCredentialsFreshAll — per-account failure isolation', () => {
  const authorizations = [
    { profileName: 'p1', appId: 'cli_app_1', userOpenId: 'ou_user_1', brand: 'feishu' },
    { profileName: 'p2', appId: 'cli_app_2', userOpenId: 'ou_user_2', brand: 'feishu' },
  ];
  const readCredentials = (opts: { appId?: string; userOpenId?: string; brand?: string }) => ({
    ok: true as const,
    credentials: {
      ...TEST_CRED,
      appId: String(opts.appId),
      userOpenId: String(opts.userOpenId),
    },
  });

  it('a THROWN refresh (e.g. cross-process lock timeout) skips that account instead of aborting the batch', async () => {
    // The cross-process lock is held across the 15s OAuth call but waiters only
    // waited ~5s — a slow refresh made the lock throw, and the uncaught throw
    // aborted reporting for EVERY account. The loop must isolate it per account.
    const result = await getLarkCredentialsFreshAll(
      {
        acquireAccountLock: async () => {
          throw new Error('timed out waiting for lark-cli refresh lock');
        },
      },
      { listAuthorizations: () => authorizations, readCredentials }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
    expect(result.credentials).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.reason)).toEqual(['refresh-failed', 'refresh-failed']);
    expect(result.skipped[0].message).toContain('timed out waiting');
  });

  it('falls back to stored DPAPI/Keychain profiles when lark-cli enumeration is empty', async () => {
    const readCredentials = vi.fn(() => ({ ok: false as const, message: 'missing test token' }));
    const result = await getLarkCredentialsFreshAll(
      {},
      {
        listAuthorizations: () => [],
        listStoredProfiles: () => [{ appId: 'cli_stored', userOpenId: 'ou_stored' }],
        readCredentials,
      }
    );

    expect(readCredentials).toHaveBeenCalledWith({
      appId: 'cli_stored',
      userOpenId: 'ou_stored',
      brand: 'feishu',
    });
    expect(result).toMatchObject({
      ok: true,
      credentials: [],
      skipped: [{ appId: 'cli_stored', userOpenId: 'ou_stored', reason: 'no-credentials' }],
    });
  });

  it('still reports the healthy accounts when only one account fails', async () => {
    const result = await getLarkCredentialsFreshAll(
      {
        acquireAccountLock: async (account, operation) => {
          if (account.startsWith('cli_app_1:')) throw new Error('lock contention');
          return operation();
        },
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              code: 0,
              access_token: `fresh-access-${'a'.repeat(40)}`,
              refresh_token: `fresh-refresh-${'b'.repeat(40)}`,
              expires_in: 7_200,
              refresh_token_expires_in: 2_592_000,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )) as unknown as typeof fetch,
        readStoredToken: async (account: string) =>
          JSON.stringify({
            appId: account.split(':')[0],
            userOpenId: account.split(':')[1],
            refreshToken: `stored-rt-${'c'.repeat(40)}`,
            refreshExpiresAt: 1_900_000_000_000,
          }),
        writeStoredToken: async () => undefined,
      },
      { listAuthorizations: () => authorizations, readCredentials }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
    expect(result.credentials.map((c) => c.appId)).toEqual(['cli_app_2']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ appId: 'cli_app_1', reason: 'refresh-failed' });
  });
});

describe('master key file fallback (macOS)', () => {
  it('reads a 32-byte master key file and rejects missing / wrong-length files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lark-master-key-'));
    try {
      expect(__internals.readMasterKeyFile(dir)).toBeNull();

      await writeFile(path.join(dir, 'master.key.file'), Buffer.alloc(16));
      expect(__internals.readMasterKeyFile(dir)).toBeNull();

      const key = randomBytes(32);
      await writeFile(path.join(dir, 'master.key.file'), key);
      expect(__internals.readMasterKeyFile(dir)?.equals(key)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('lark-cli batch reporting', () => {
  const batchCred = (index: number): LarkCredentials => ({
    ...TEST_CRED,
    appId: `cli_batch_${index}`,
    appSecret: `secret-${'a'.repeat(40)}-${index}`,
    accessToken: `access-${'a'.repeat(40)}-${index}`,
    refreshToken: `refresh-${'a'.repeat(40)}-${index}`,
    userOpenId: `ou_batch_${index}`,
  });

  const batchLookup = (credentials: LarkCredentials[]): GetLarkCredentialsAllResult => ({
    ok: true,
    credentials,
    skipped: [],
  });

  it('builds one unique wire item per personal authorization', () => {
    const payload = buildLarkBatchPayload([batchCred(1), batchCred(2), batchCred(3), batchCred(1)]);

    expect(payload.items).toHaveLength(3);
    expect(payload.items.map((item) => item.client_item_id)).toEqual([
      'cli_batch_1:ou_batch_1',
      'cli_batch_2:ou_batch_2',
      'cli_batch_3:ou_batch_3',
    ]);
    expect(payload.items[0]).toEqual({
      client_item_id: 'cli_batch_1:ou_batch_1',
      app_id: 'cli_batch_1',
      app_secret: batchCred(1).appSecret,
      access_token: batchCred(1).accessToken,
      refresh_token: batchCred(1).refreshToken,
    });
    expect(
      payload.items.every((item) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(item.client_item_id))
    ).toBe(true);
  });

  it('prevalidates batch items so one incomplete credential cannot reject the whole atomic request', () => {
    expect(meetsBatchFieldConstraints(batchCred(1))).toBe(true);
    expect(meetsBatchFieldConstraints({ ...batchCred(1), appId: 'not-cli' })).toBe(false);
    expect(meetsBatchFieldConstraints({ ...batchCred(1), appSecret: 'short' })).toBe(false);
    expect(meetsBatchFieldConstraints({ ...batchCred(1), accessToken: 'short' })).toBe(false);
    expect(meetsBatchFieldConstraints({ ...batchCred(1), refreshToken: 'short' })).toBe(false);
  });

  it('keeps an API-valid stable client item id when a profile identity exceeds 64 characters', () => {
    const long = {
      ...batchCred(1),
      appId: `cli_${'a'.repeat(150)}`,
      userOpenId: `ou_${'b'.repeat(80)}`,
    };
    const first = buildLarkBatchPayload([long]).items[0].client_item_id;
    const second = buildLarkBatchPayload([long]).items[0].client_item_id;

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
  });

  it('splits more than 20 eligible profiles into API-valid atomic batches', async () => {
    const { fn: fetchImpl, calls } = makeFetchMock(200, '{}');
    const credentials = Array.from({ length: 21 }, (_, index) => batchCred(index + 1));
    const result = await reportAllLarkCredentials({
      hermitHome: '/tmp/hermit-lark',
      resolveAuthedContext: async () => ({ baseUrl: 'http://monitor.test', token: 't' }),
      __lookupAllForTests: () => batchLookup(credentials),
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, accountCount: 21 });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => JSON.parse(String(call.init.body)).items.length)).toEqual([20, 1]);
  });

  it('reports an AgentBus upload timeout without confusing it with OAuth refresh failure', async () => {
    const credentials = [batchCred(1), batchCred(2), batchCred(3)];
    const result = await reportAllLarkCredentials({
      hermitHome: '/tmp/hermit-lark',
      resolveAuthedContext: async () => ({ baseUrl: 'https://monitor.test', token: 't' }),
      __lookupAllForTests: () => batchLookup(credentials),
      fetchImpl: vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }) as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'fetch-failed',
      message: 'AgentBus Lark 凭证上传超时（60 秒）',
    });
  });

  it('stops after a later batch fails without retransmitting earlier batches', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const status = calls.length === 2 ? 503 : 200;
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
    const credentials = Array.from({ length: 41 }, (_, index) => batchCred(index + 1));

    const result = await reportAllLarkCredentials({
      hermitHome: '/tmp/hermit-lark',
      resolveAuthedContext: async () => ({ baseUrl: 'http://monitor.test', token: 't' }),
      __lookupAllForTests: () => batchLookup(credentials),
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: 'http-error', lastHttpStatus: 503 });
    expect(calls.map((call) => JSON.parse(String(call.init.body)).items.length)).toEqual([20, 20]);
  });

  it('POSTs every eligible personal authorization to the atomic batch endpoint', async () => {
    const { fn: fetchImpl, calls } = makeFetchMock(200, '{"ok":true}');
    const credentials = [batchCred(1), batchCred(2), batchCred(3)];
    const result = await reportAllLarkCredentials({
      hermitHome: '/tmp/hermit-lark',
      resolveAuthedContext: async () => ({ baseUrl: 'http://monitor.test', token: 'test-token-1' }),
      __lookupAllForTests: () => batchLookup(credentials),
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, accountCount: 3 });
    expect(result.accounts).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://monitor.test/api/v1/feishu/lark-cli/credentials/batch');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(buildLarkBatchPayload(credentials));
  });

  it('filters invalid profiles before POST and does not send an empty batch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const resolver = vi.fn();
    const result = await reportAllLarkCredentials({
      hermitHome: '/tmp/hermit-lark',
      resolveAuthedContext: resolver,
      __lookupAllForTests: () => batchLookup([{ ...batchCred(1), accessToken: 'short' }]),
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: 'no-credentials', accountCount: 0 });
    expect(resolver).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps valid profiles when another profile is invalid', async () => {
    const { fn: fetchImpl, calls } = makeFetchMock(200, '{}');
    const result = await reportAllLarkCredentials({
      hermitHome: '/tmp/hermit-lark',
      resolveAuthedContext: async () => ({ baseUrl: 'http://monitor.test', token: 't' }),
      __lookupAllForTests: () =>
        batchLookup([batchCred(1), { ...batchCred(2), refreshToken: 'short' }]),
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, accountCount: 1 });
    expect(JSON.parse(String(calls[0].init.body)).items).toHaveLength(1);
  });
});

describe('lark-cli store crypto layer (mirrors bin/lib/larkSecrets.mjs)', () => {
  // These tests lock the decode / decrypt / discovery invariants that previously
  // drifted from the canonical CLI. The macOS Keychain + Windows DPAPI backends
  // can't run on CI, but the math underneath them can — and these are the exact
  // spots that drifted (single vs double base64, master_key vs master.key,
  // filename-split vs decrypt-and-parse).

  function doubleEncode(buf: Buffer): string {
    // Inverse of decodeMasterKey: raw bytes → inner base64 string → outer base64.
    return Buffer.from(buf.toString('base64'), 'utf8').toString('base64');
  }

  function seal(plain: string, key: Buffer): Buffer {
    // lark-cli .enc layout: iv(12) || aes-256-gcm ciphertext || tag(16).
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ct, tag]);
  }

  it('decodeMasterKey unwraps base64(base64(key)) and the go-keyring prefix, rejects wrong length', () => {
    const raw = randomBytes(32);
    const dbl = doubleEncode(raw);
    expect(__internals.decodeMasterKey(dbl)?.equals(raw)).toBe(true);
    expect(__internals.decodeMasterKey(`go-keyring-base64:${dbl}`)?.equals(raw)).toBe(true);
    // A SINGLE base64 pass (the old drift) decodes to wrong-length bytes → null.
    expect(__internals.decodeMasterKey(raw.toString('base64'))).toBeNull();
    // Not 32 bytes → null.
    expect(__internals.decodeMasterKey(doubleEncode(randomBytes(16)))).toBeNull();
  });

  it('decryptAesGcm round-trips the iv||ct||tag layout lark-cli writes', () => {
    const key = randomBytes(32);
    const plain = 'hello lark-cli';
    expect(__internals.decryptAesGcm(seal(plain, key), key)).toBe(plain);
    // Tampered / truncated blob → null, never throws.
    expect(__internals.decryptAesGcm(randomBytes(5), key)).toBeNull();
  });

  it('discoverProfilesMacCore reads ids from DECRYPTED content, not the (mangled) filename', async () => {
    // Reproduces the original bug: the account key `<appId>:<userOpenId>` is
    // safeFileName'd to `<appId>_<userOpenId>.enc` (':' → '_'), so splitting the
    // filename on ':' can never recover the ids. Discovery must decrypt + parse.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lark-store-'));
    try {
      const key = randomBytes(32);
      const appId = 'cli_test_app';
      const userOpenId = 'ou_test_user';

      const tokenJson = JSON.stringify({
        appId,
        userOpenId,
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresAt: 1_900_000_000_000,
        refreshExpiresAt: 1_900_000_000_000,
        scope: 'contact:user.base:readonly',
      });
      await writeFile(
        path.join(dir, __internals.safeFileName(`${appId}:${userOpenId}`)),
        seal(tokenJson, key)
      );
      // appsecret file: plaintext is a bare secret, NOT StoredUAToken JSON → excluded.
      await writeFile(
        path.join(dir, __internals.safeFileName(`appsecret:${appId}`)),
        seal('topsecret', key)
      );

      const profiles = __internals.discoverProfilesMacCore({ dir, key });
      expect(profiles).toEqual([{ appId, userOpenId }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('discoverProfilesMacCore returns [] when the key is null (Keychain unreadable)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lark-store-'));
    try {
      expect(__internals.discoverProfilesMacCore({ dir, key: null })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
