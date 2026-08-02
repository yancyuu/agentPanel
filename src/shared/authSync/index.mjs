// App（advanced-connections）与 CLI（openhermit.json）登录态双向桥接（design D1–D4）。
// 纯转换函数 + 文件 IO 辅助，无任何第三方依赖；TS 侧直接 import，
// bin/lib 经相对路径 import（与 src/shared/constants/cloudConfig.mjs 同款 .mjs 共享模式）。
//
// 语义要点：
// - 只桥接 providerId='openhermit-agentbus' 且 managedDefault 的默认连接（D1）；
// - 写穿透前重读目标存储，目标 token 更新（updatedAt 更晚）则放弃写入（D3）；
// - 刷新失败不级联删除对方（D2：本模块只负责写与显式删除，不做失败清理）。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { AGENTBUS_PROVIDER_ID, agentbusCompatibilityManifest } from './compatManifest.mjs';

export { AGENTBUS_PROVIDER_ID };

const AUTH_STORE_SCHEMA_VERSION = 1;

/** 默认授予只读/聚合类；写方向与敏感粒度默认关闭（与 providerManifest 语义同源）。 */
export const DEFAULT_PERMISSION_DECISIONS = {
  'team.presence': 'denied',
  'team.directory': 'granted',
  'team.tasks.read': 'granted',
  'team.tasks.write': 'denied',
  'usage.aggregates': 'granted',
  'usage.project-metadata': 'denied',
  'usage.message-metadata': 'denied',
  'usage.message-content': 'denied',
  'capabilities.inventory': 'granted',
  'credentials.lark.export': 'denied',
};

export function isDefaultAgentbusRecord(record) {
  return Boolean(
    record?.managedDefault && record?.manifest?.provider?.id === AGENTBUS_PROVIDER_ID
  );
}

/** App 连接 secret + record → CLI auth store（openhermit.json schema） */
export function buildAuthStoreFromConnection({ record, secret, now }) {
  const timestamp = now ?? new Date().toISOString();
  const scopes = Array.isArray(secret.scopes) ? secret.scopes : [];
  return {
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    provider: 'openhermit',
    issuer: record.baseUrl,
    baseUrl: record.baseUrl,
    clientId: 'openhermit-cli',
    account: record.account
      ? {
          id: record.account.id ?? null,
          email: record.account.email ?? null,
          name: record.account.displayName ?? record.account.email ?? null,
          ...(record.account.tenantName ? { tenantName: record.account.tenantName } : {}),
        }
      : null,
    token: {
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken ?? null,
      tokenType: secret.tokenType || 'Bearer',
      scope: scopes.join(' '),
      scopes,
      expiresAt: secret.expiresAt ?? null,
      updatedAt: secret.updatedAt ?? timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function scopesFromAuthStore(store) {
  if (Array.isArray(store?.token?.scopes) && store.token.scopes.length > 0) {
    return store.token.scopes.filter((scope) => typeof scope === 'string' && scope.trim());
  }
  const scope = typeof store?.token?.scope === 'string' ? store.token.scope : '';
  return scope.split(/\s+/u).filter(Boolean);
}

/** CLI auth store → App 连接 secret（connections/secrets/<id>.json schema） */
export function buildConnectionSecretFromAuthStore({ store, connectionId, now, providerId }) {
  const timestamp = now ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    connectionId,
    providerId: providerId ?? AGENTBUS_PROVIDER_ID,
    issuerOrigin: store.issuer ?? store.baseUrl ?? '',
    accessToken: store.token.accessToken,
    refreshToken: store.token.refreshToken ?? null,
    tokenType: store.token.tokenType || 'Bearer',
    scopes: scopesFromAuthStore(store),
    expiresAt: store.token.expiresAt ?? null,
    updatedAt: store.token.updatedAt ?? store.updatedAt ?? timestamp,
  };
}

// ---------------------------------------------------------------------------
// 文件 IO 辅助（0600 + 原子写）
// ---------------------------------------------------------------------------

export async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function deleteFileIfExists(file) {
  await fs.rm(file, { force: true });
}

function tokenUpdatedAt(store) {
  return store?.token?.updatedAt ?? store?.updatedAt ?? '';
}

/** D3：目标存储中的 token 比本次写入更新时放弃（返回 true 表示应放弃写入） */
export function shouldSkipWriteThrough(existingTokenUpdatedAt, incomingUpdatedAt) {
  if (!existingTokenUpdatedAt || !incomingUpdatedAt) return false;
  const existingMs = Date.parse(existingTokenUpdatedAt);
  const incomingMs = Date.parse(incomingUpdatedAt);
  if (Number.isNaN(existingMs) || Number.isNaN(incomingMs)) return false;
  return existingMs > incomingMs;
}

// ---------------------------------------------------------------------------
// App → CLI：写 openhermit.json
// ---------------------------------------------------------------------------

/** 登录/刷新成功后写穿透到 CLI auth store；目标更新时放弃。返回 'written' | 'skipped-newer' */
export async function writeAuthStoreThrough({ authStorePath, record, secret, now }) {
  const existing = await readJsonIfExists(authStorePath);
  if (shouldSkipWriteThrough(tokenUpdatedAt(existing), secret.updatedAt ?? now)) {
    return 'skipped-newer';
  }
  await writeJsonAtomic(authStorePath, buildAuthStoreFromConnection({ record, secret, now }));
  return 'written';
}

/** 显式登出/删除默认连接时删除 CLI auth store */
export async function removeAuthStore({ authStorePath }) {
  await deleteFileIfExists(authStorePath);
}

// ---------------------------------------------------------------------------
// CLI → App：写默认连接 record + secret
// ---------------------------------------------------------------------------

function connectionsIndexPath(connectionsDir) {
  return path.join(connectionsDir, 'index.json');
}

function connectionSecretPath(connectionsDir, connectionId) {
  return path.join(connectionsDir, 'secrets', `${connectionId}.json`);
}

async function readConnectionsIndex(connectionsDir) {
  const parsed = await readJsonIfExists(connectionsIndexPath(connectionsDir));
  if (parsed?.schemaVersion === 1 && Array.isArray(parsed.connections)) return parsed;
  return { schemaVersion: 1, connections: [] };
}

function newConnectionId() {
  return `connection_${randomUUID().replace(/-/gu, '').slice(0, 16)}`;
}

function findDefaultAgentbusRecord(index) {
  return index.connections.find((record) => isDefaultAgentbusRecord(record)) ?? null;
}

function upsertDefaultAgentbusRecord(index, { account, scopes, now, connectionId }) {
  const timestamp = now ?? new Date().toISOString();
  const existing = findDefaultAgentbusRecord(index);
  if (existing) {
    return {
      ...existing,
      state: 'authenticated',
      account: account ?? existing.account,
      grantedScopes: scopes,
      lastError: undefined,
      updatedAt: timestamp,
    };
  }
  return {
    schemaVersion: 1,
    id: connectionId,
    label: 'AgentBus',
    baseUrl: '',
    secure: true,
    compatibilityMode: true,
    managedDefault: true,
    manifest: agentbusCompatibilityManifest(),
    state: 'authenticated',
    account: account ?? undefined,
    grantedScopes: scopes,
    permissions: { ...DEFAULT_PERMISSION_DECISIONS },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * CLI 登录/刷新成功后写穿透：更新默认连接 record（state='authenticated'）并写 secret。
 * secret 比目标旧时放弃（D3）；默认连接不存在时按兼容 manifest 创建。
 * 返回 { outcome: 'written' | 'skipped-newer', connectionId }
 */
export async function writeConnectionThrough({ connectionsDir, store, issuerOrigin, now }) {
  const timestamp = now ?? new Date().toISOString();
  const index = await readConnectionsIndex(connectionsDir);
  const existing = findDefaultAgentbusRecord(index);
  const connectionId = existing?.id ?? newConnectionId();
  const secret = buildConnectionSecretFromAuthStore({
    store,
    connectionId,
    now: timestamp,
    providerId: AGENTBUS_PROVIDER_ID,
  });
  if (issuerOrigin && !secret.issuerOrigin) secret.issuerOrigin = issuerOrigin;

  const existingSecret = await readJsonIfExists(
    connectionSecretPath(connectionsDir, connectionId)
  );
  if (shouldSkipWriteThrough(existingSecret?.updatedAt, secret.updatedAt)) {
    return { outcome: 'skipped-newer', connectionId };
  }

  const scopes = scopesFromAuthStore(store);
  const nextRecord = upsertDefaultAgentbusRecord(index, {
    account: store.account ?? null,
    scopes,
    now: timestamp,
    connectionId,
  });
  if (issuerOrigin && !nextRecord.baseUrl) nextRecord.baseUrl = issuerOrigin;
  if (!nextRecord.baseUrl) nextRecord.baseUrl = store.baseUrl ?? store.issuer ?? '';
  nextRecord.secure = typeof nextRecord.baseUrl === 'string' ? nextRecord.baseUrl.startsWith('https:') : true;

  const position = index.connections.findIndex((record) => record.id === nextRecord.id);
  if (position >= 0) index.connections[position] = nextRecord;
  else index.connections.push(nextRecord);

  await writeJsonAtomic(connectionSecretPath(connectionsDir, connectionId), secret);
  await writeJsonAtomic(connectionsIndexPath(connectionsDir), index);
  return { outcome: 'written', connectionId };
}

/**
 * CLI 登出：删默认连接 secret 并置 state='auth_required'。
 * connectionId 缺省时自动定位 managedDefault 连接；连接不存在时只删 secret 目录中可能残留的文件。
 */
export async function clearConnectionAuth({ connectionsDir, connectionId, now }) {
  const timestamp = now ?? new Date().toISOString();
  const index = await readConnectionsIndex(connectionsDir);
  const target = connectionId
    ? (index.connections.find((record) => record.id === connectionId) ?? null)
    : findDefaultAgentbusRecord(index);
  if (target) {
    const next = {
      ...target,
      state: 'auth_required',
      account: undefined,
      grantedScopes: [],
      updatedAt: timestamp,
    };
    const position = index.connections.findIndex((record) => record.id === target.id);
    index.connections[position] = next;
    await writeJsonAtomic(connectionsIndexPath(connectionsDir), index);
    await deleteFileIfExists(connectionSecretPath(connectionsDir, target.id));
    return target.id;
  }
  return null;
}
