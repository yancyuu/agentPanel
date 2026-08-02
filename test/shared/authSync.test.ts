import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAuthStoreFromConnection,
  buildConnectionSecretFromAuthStore,
  clearConnectionAuth,
  DEFAULT_PERMISSION_DECISIONS,
  isDefaultAgentbusRecord,
  readJsonIfExists,
  shouldSkipWriteThrough,
  writeAuthStoreThrough,
  writeConnectionThrough,
} from '@shared/authSync/index.mjs';

const temporaryDirectories: string[] = [];

async function makeHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-sync-test-'));
  temporaryDirectories.push(home);
  return home;
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'connection_1',
    label: 'AgentBus',
    baseUrl: 'https://agentbus.skg.com',
    managedDefault: true,
    state: 'authenticated',
    account: { id: 'u-1', email: 'dev@corp.test', displayName: '开发者', tenantName: '租户甲' },
    grantedScopes: ['upload:read'],
    manifest: { provider: { id: 'openhermit-agentbus' } },
    permissions: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSecret(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    connectionId: 'connection_1',
    providerId: 'openhermit-agentbus',
    issuerOrigin: 'https://agentbus.skg.com',
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    tokenType: 'Bearer',
    scopes: ['upload:read', 'upload:write'],
    expiresAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('authSync 纯函数', () => {
  it('buildAuthStoreFromConnection 映射 provider/issuer/account/scope', () => {
    const store = buildAuthStoreFromConnection({
      record: makeRecord() as never,
      secret: makeSecret() as never,
      now: '2026-01-01T01:00:00.000Z',
    });

    expect(store.provider).toBe('openhermit');
    expect(store.issuer).toBe('https://agentbus.skg.com');
    expect(store.clientId).toBe('openhermit-cli');
    expect(store.account).toMatchObject({
      id: 'u-1',
      email: 'dev@corp.test',
      name: '开发者',
      tenantName: '租户甲',
    });
    expect(store.token).toMatchObject({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      tokenType: 'Bearer',
      scope: 'upload:read upload:write',
      scopes: ['upload:read', 'upload:write'],
      expiresAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('buildConnectionSecretFromAuthStore 兼容 scopes 数组与 scope 字符串', () => {
    const fromArray = buildConnectionSecretFromAuthStore({
      store: {
        schemaVersion: 1,
        provider: 'openhermit',
        issuer: 'https://agentbus.skg.com',
        token: { accessToken: 'at', scopes: ['a', 'b'], updatedAt: '2026-01-01T00:00:00.000Z' },
      } as never,
      connectionId: 'connection_1',
    });
    expect(fromArray.scopes).toEqual(['a', 'b']);
    expect(fromArray.issuerOrigin).toBe('https://agentbus.skg.com');

    const fromString = buildConnectionSecretFromAuthStore({
      store: {
        schemaVersion: 1,
        provider: 'openhermit',
        issuer: 'https://agentbus.skg.com',
        token: { accessToken: 'at', scope: 'upload:read upload:write' },
      } as never,
      connectionId: 'connection_1',
    });
    expect(fromString.scopes).toEqual(['upload:read', 'upload:write']);
  });

  it('shouldSkipWriteThrough：目标更新则放弃，其余情况写入', () => {
    expect(shouldSkipWriteThrough('2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(
      true
    );
    expect(shouldSkipWriteThrough('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')).toBe(
      false
    );
    expect(shouldSkipWriteThrough(undefined, '2026-01-01T00:00:00.000Z')).toBe(false);
    expect(shouldSkipWriteThrough('not-a-date', '2026-01-01T00:00:00.000Z')).toBe(false);
  });

  it('isDefaultAgentbusRecord 只认 managedDefault + openhermit-agentbus', () => {
    expect(isDefaultAgentbusRecord(makeRecord() as never)).toBe(true);
    expect(isDefaultAgentbusRecord(makeRecord({ managedDefault: false }) as never)).toBe(false);
    expect(
      isDefaultAgentbusRecord(
        makeRecord({ manifest: { provider: { id: 'other-provider' } } }) as never
      )
    ).toBe(false);
  });
});

describe('writeAuthStoreThrough（App → CLI）', () => {
  it('写入 openhermit.json；目标更新时放弃', async () => {
    const home = await makeHome();
    const authStorePath = path.join(home, 'auth', 'openhermit.json');

    const outcome = await writeAuthStoreThrough({
      authStorePath,
      record: makeRecord() as never,
      secret: makeSecret() as never,
    });
    expect(outcome).toBe('written');
    const written = (await readJsonIfExists(authStorePath)) as never;
    expect(written).toMatchObject({
      provider: 'openhermit',
      token: { accessToken: 'at-1' },
    });

    // 目标更新 → 放弃
    const stat = await fs.stat(authStorePath);
    const newer = await writeAuthStoreThrough({
      authStorePath,
      record: makeRecord() as never,
      secret: makeSecret({ accessToken: 'at-old', updatedAt: '2020-01-01T00:00:00.000Z' }) as never,
    });
    expect(newer).toBe('skipped-newer');
    const after = (await readJsonIfExists(authStorePath)) as never;
    expect(after).toMatchObject({ token: { accessToken: 'at-1' } });
    expect((await fs.stat(authStorePath)).mtimeMs).toBe(stat.mtimeMs);
  });
});

describe('writeConnectionThrough / clearConnectionAuth（CLI → App）', () => {
  function makeCliStore() {
    return {
      schemaVersion: 1,
      provider: 'openhermit',
      issuer: 'https://agentbus.skg.com',
      baseUrl: 'https://agentbus.skg.com',
      clientId: 'openhermit-cli',
      account: { id: 'u-1', email: 'dev@corp.test', name: '开发者' },
      token: {
        accessToken: 'at-cli',
        refreshToken: 'rt-cli',
        tokenType: 'Bearer',
        scope: 'upload:read upload:write',
        expiresAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('无默认连接时创建 record（authenticated + 账号 + 默认权限）并写 secret', async () => {
    const home = await makeHome();
    const connectionsDir = path.join(home, 'connections');

    const { outcome, connectionId } = await writeConnectionThrough({
      connectionsDir,
      store: makeCliStore() as never,
    });
    expect(outcome).toBe('written');

    const index = (await readJsonIfExists(path.join(connectionsDir, 'index.json'))) as never;
    const record = (index as { connections: Record<string, never>[] }).connections[0];
    expect(record).toMatchObject({
      id: connectionId,
      managedDefault: true,
      state: 'authenticated',
      account: { email: 'dev@corp.test' },
      grantedScopes: ['upload:read', 'upload:write'],
    });
    expect(record?.permissions).toEqual(DEFAULT_PERMISSION_DECISIONS);

    const secret = (await readJsonIfExists(
      path.join(connectionsDir, 'secrets', `${connectionId}.json`)
    )) as never;
    expect(secret).toMatchObject({
      connectionId,
      providerId: 'openhermit-agentbus',
      accessToken: 'at-cli',
      refreshToken: 'rt-cli',
      scopes: ['upload:read', 'upload:write'],
    });
  });

  it('目标 secret 更新时放弃写入', async () => {
    const home = await makeHome();
    const connectionsDir = path.join(home, 'connections');
    const first = await writeConnectionThrough({ connectionsDir, store: makeCliStore() as never });

    const older = makeCliStore();
    older.token.accessToken = 'at-old';
    older.token.updatedAt = '2020-01-01T00:00:00.000Z';
    const second = await writeConnectionThrough({ connectionsDir, store: older as never });
    expect(second.outcome).toBe('skipped-newer');

    const secret = (await readJsonIfExists(
      path.join(connectionsDir, 'secrets', `${first.connectionId}.json`)
    )) as never;
    expect(secret).toMatchObject({ accessToken: 'at-cli' });
  });

  it('登出：state 置 auth_required 并删除 secret', async () => {
    const home = await makeHome();
    const connectionsDir = path.join(home, 'connections');
    const { connectionId } = await writeConnectionThrough({
      connectionsDir,
      store: makeCliStore() as never,
    });

    const cleared = await clearConnectionAuth({ connectionsDir });
    expect(cleared).toBe(connectionId);

    const index = (await readJsonIfExists(path.join(connectionsDir, 'index.json'))) as never;
    expect((index as { connections: Record<string, never>[] }).connections[0]).toMatchObject({
      state: 'auth_required',
      grantedScopes: [],
    });
    expect((index as { connections: Record<string, never>[] }).connections[0]?.account).toBeUndefined();
    expect(
      await readJsonIfExists(path.join(connectionsDir, 'secrets', `${connectionId}.json`))
    ).toBeNull();
  });
});
