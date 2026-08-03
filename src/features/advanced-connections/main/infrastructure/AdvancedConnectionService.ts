import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type AdvancedConnectionAccountSummary,
  type AdvancedConnectionLocalSnapshot,
  type AdvancedConnectionPullTasksResult,
  type AdvancedConnectionRuntimeApplyResult,
  type AdvancedConnectionRuntimeId,
  type AdvancedConnectionState,
  type AdvancedConnectionSummary,
  type AdvancedConnectionSyncResult,
  type AdvancedConnectionTokenClaimRequest,
  type AdvancedConnectionTokenClaimResult,
  type AdvancedConnectionTokenClaimStepEvent,
  type CreateAdvancedConnectionRequest,
  type DataPermissionId,
  type DiscoverAdvancedConnectionResponse,
  type PermissionDecision,
  type ProviderManifestV1,
  type StartAdvancedConnectionAuthResponse,
  type UpdateAdvancedConnectionPermissionsRequest,
} from '../../contracts';
import {
  defaultPermissionDecisions,
  mergePermissionDecisions,
  parseProviderManifest,
} from '../../core/domain/providerManifest';
import { agentbusCompatibilityManifest } from '@shared/authSync/compatManifest.mjs';

function compatibilityManifest(): ProviderManifestV1 {
  return agentbusCompatibilityManifest() as ProviderManifestV1;
}
import {
  isDefaultAgentbusRecord,
  removeAuthStore,
  writeAuthStoreThrough,
} from '@shared/authSync/index.mjs';

import {
  type ConnectionSecretStore,
  SystemCredentialSecretStore,
} from './SystemCredentialSecretStore';
import { createAgentBusHttpLogger } from './agentBusHttpLog';

const CONNECTION_SCHEMA_VERSION = 1;
const DISCOVERY_TIMEOUT_MS = 10_000;
const AUTH_REQUEST_TIMEOUT_MS = 30_000;
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- explicit cloud metadata blocklist
const CLOUD_METADATA_IPV4 = '169.254.169.254';

interface StoredConnectionRecord {
  schemaVersion: 1;
  id: string;
  label: string;
  baseUrl: string;
  secure: boolean;
  /** 用户已确认接受 HTTP 传输风险后放行（per-connection 持久化） */
  insecureAllowed?: boolean;
  compatibilityMode: boolean;
  /** 由桌面工作台托管的默认 AgentBus；仅该连接在登录后自动开启聚合用量同步。 */
  managedDefault?: boolean;
  manifest: ProviderManifestV1;
  state: AdvancedConnectionState;
  account?: AdvancedConnectionAccountSummary;
  grantedScopes: string[];
  permissions: Record<DataPermissionId, PermissionDecision>;
  lastError?: { code: string; message: string; at: string };
  createdAt: string;
  updatedAt: string;
}

interface ConnectionIndexFile {
  schemaVersion: 1;
  connections: StoredConnectionRecord[];
}

interface ConnectionSecret {
  schemaVersion: 1;
  connectionId: string;
  providerId: string;
  issuerOrigin: string;
  accessToken: string;
  refreshToken?: string | null;
  tokenType: string;
  scopes: string[];
  expiresAt?: string | null;
  updatedAt: string;
}

interface AuthAttempt {
  id: string;
  connectionId: string;
  flowId: string;
  pollSecret: string;
  pollUrl: string;
  meUrl?: string;
  expiresAtMs: number;
  intervalMs: number;
  legacyGet: boolean;
}

interface AuthStartPayload {
  flowId: string;
  pollSecret: string;
  authorizationUrl: string;
  userCode?: string;
  expiresIn: number;
  interval: number;
}

interface TokenPayload {
  accessToken: string;
  refreshToken?: string | null;
  tokenType: string;
  scopes: string[];
  expiresAt?: string | null;
  account?: AdvancedConnectionAccountSummary;
}

export interface RuntimeCredentialApplyInput {
  secret: Record<string, unknown>;
  choices: { model?: string; wireApi?: 'responses' | 'chat' };
  runtimes: AdvancedConnectionRuntimeId[];
  home: string;
}

export interface RuntimeCredentialApplyOutput {
  ok: boolean;
  runtimes?: { runtime?: string; ok?: boolean; path?: string; error?: string }[];
}

export type RuntimeCredentialApplier = (
  input: RuntimeCredentialApplyInput
) => Promise<RuntimeCredentialApplyOutput>;

interface AikeyRuntimeModule {
  validateClaimedSecret(secret: Record<string, unknown>): { ok: boolean; reason?: string };
  applyClaimedSecret(input: RuntimeCredentialApplyInput): RuntimeCredentialApplyOutput;
  maskKey(key: string): string;
}

let aikeyRuntimeModule: Promise<AikeyRuntimeModule> | undefined;

function loadAikeyRuntime(): Promise<AikeyRuntimeModule> {
  aikeyRuntimeModule ??= import(
    pathToFileURL(
      path.join(
        process.env.AGENTCLI_PACKAGE_ROOT?.trim() || process.cwd(),
        'bin',
        'lib',
        'aikey.mjs'
      )
    ).href
  ) as Promise<AikeyRuntimeModule>;
  return aikeyRuntimeModule;
}

/**
 * CLI 版 Token 池客户端（token-distribution-v3）——面板领取链路与 CLI 共用同一实现，
 * region 默认 cn-shenzhen 由模块内置，service 代码不再出现 region。
 */
interface TokenDistributionRuntime {
  discoverCatalog(options?: { regionId?: string; gatewayId?: string | null }): Promise<{
    modelApis: unknown[];
    defaultApiName: string | null;
    defaultModelApiIds: string[];
    discoveryId: string | null;
    gatewayId: string | null;
    regionId: string;
    raw: unknown;
  }>;
  selectModelApiIds(defaultModelApiIds?: string[]): string[];
  provisionRun(options: {
    discoveryId?: string;
    regionId?: string;
    gatewayId?: string | null;
    aliyunModelApiIds?: string[];
  }): Promise<{ runId: string; raw: unknown }>;
  pollRun(
    runId: string,
    options?: {
      timeoutMs?: number;
      intervalMs?: number;
      onTick?: ((status: string, body: unknown) => void) | null;
    }
  ): Promise<unknown>;
  claimSecret(runId: string): Promise<{
    key: string;
    keyId: string | null;
    endpoint: string;
    endpoints: Record<string, unknown>;
    runtimeProfiles: Record<string, unknown>;
    modelsUrl: string;
    modelIds: string[];
    expiresAt: string | null;
    raw: unknown;
  }>;
}

let tokenDistributionModule: Promise<TokenDistributionRuntime> | undefined;

function loadTokenDistributionRuntime(): Promise<TokenDistributionRuntime> {
  tokenDistributionModule ??= import(
    pathToFileURL(
      path.join(
        process.env.AGENTCLI_PACKAGE_ROOT?.trim() || process.cwd(),
        'bin',
        'lib',
        'tokenDistribution.mjs'
      )
    ).href
  ) as Promise<TokenDistributionRuntime>;
  return tokenDistributionModule;
}

export interface AdvancedConnectionServiceOptions {
  hermitHome: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  secretStore?: ConnectionSecretStore;
  runtimeHome?: string;
  runtimeCredentialApplier?: RuntimeCredentialApplier;
  /** 测试注入：替换 CLI 版 tokenDistribution 运行时（默认动态 import bin/lib/tokenDistribution.mjs） */
  tokenDistribution?: TokenDistributionRuntime;
  onAuthenticated?: (connectionId: string) => Promise<void> | void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeScopes(payload: Record<string, unknown>): string[] {
  if (Array.isArray(payload.scopes)) {
    return payload.scopes.filter(
      (scope): scope is string => typeof scope === 'string' && Boolean(scope.trim())
    );
  }
  return stringValue(payload.scope)?.split(/\s+/u).filter(Boolean) ?? [];
}

function normalizeExpiry(expiresIn: unknown, expiresAt: unknown, nowMs: number): string | null {
  if (typeof expiresAt === 'string' && !Number.isNaN(Date.parse(expiresAt))) {
    return new Date(expiresAt).toISOString();
  }
  const seconds = Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(nowMs + seconds * 1000).toISOString()
    : null;
}

function normalizeAccount(value: unknown): AdvancedConnectionAccountSummary | undefined {
  const input = asRecord(value);
  const id = stringValue(input.id) ?? stringValue(input.user_id) ?? stringValue(input.open_id);
  const displayName =
    stringValue(input.displayName) ??
    stringValue(input.display_name) ??
    stringValue(input.name) ??
    stringValue(input.username);
  const email = stringValue(input.email);
  const tenantName = stringValue(input.tenantName) ?? stringValue(input.tenant_name);
  return id || displayName || email || tenantName
    ? { id, displayName, email, tenantName }
    : undefined;
}

/** provision 报 discovery 过期（aliyun_discovery_stale）判定：消息或 ApiError.body 任一命中 */
function isDiscoveryStaleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/aliyun_discovery_stale/i.test(message)) return true;
  const body = (error as { body?: unknown }).body;
  return body ? /aliyun_discovery_stale/i.test(JSON.stringify(body)) : false;
}

function normalizeBaseUrl(value: string): { baseUrl: string; secure: boolean } {
  const raw = value.trim();
  if (!raw) throw new Error('请输入连接服务地址');
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('连接服务地址格式无效');
  }
  if (url.username || url.password) throw new Error('连接地址不能包含用户名或密码');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('连接服务只支持 HTTP 或 HTTPS');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === CLOUD_METADATA_IPV4 || hostname.endsWith('.internal.metadata')) {
    throw new Error('不允许连接系统元数据地址');
  }
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (url.protocol === 'http:' && !isLoopback) {
    // Keep current internal AgentBus hosts compatible, but surface this as insecure in the DTO/UI.
  }
  return { baseUrl: url.origin, secure: url.protocol === 'https:' };
}

function validateAuthorizationUrl(value: string, allowInsecureHttp = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('授权服务返回了无效的登录地址');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('授权页面只支持 HTTP 或 HTTPS');
  }
  if (url.username || url.password) throw new Error('授权页面地址不能包含用户名或密码');
  const hostname = url.hostname.toLowerCase();
  if (hostname === CLOUD_METADATA_IPV4 || hostname.endsWith('.internal.metadata')) {
    throw new Error('授权页面地址无效');
  }
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (url.protocol === 'http:' && !isLoopback && !allowInsecureHttp) {
    throw new Error('远程授权页面必须使用 HTTPS');
  }
  return url.toString();
}

function sanitizeRemoteMessage(value: string, exactSecrets: string[] = []): string {
  let sanitized = value;
  for (const secret of exactSecrets) {
    if (secret) sanitized = sanitized.split(secret).join('[redacted key]');
  }
  return sanitized
    .replace(/(?:access|refresh)[_-]?token\s*[:=]\s*["']?[^\s,"';}]+["']?/giu, '[redacted token]')
    .replace(
      /(?:plaintext[_-]?key|api[_-]?key|key)\s*[:=]\s*["']?[^\s,"';}]+["']?/giu,
      '[redacted key]'
    )
    .replace(/app[_-]?secret\s*[:=]\s*["']?[^\s,"';}]+["']?/giu, '[redacted secret]')
    .slice(0, 300);
}

const USAGE_AGGREGATE_FIELDS = [
  'connected',
  'lastScan',
  'sessions',
  'messages',
  'imMessages',
  'imTokensTotal',
  'tokensIn',
  'tokensOut',
  'cacheRead',
  'cacheCreation',
  'totalTokens',
  'recentMessages',
  'recentTokensTotal',
  'recentByProvider',
  'activeDays',
  'hourly',
  'workSecondsByDay',
  'daily',
  'byProvider',
] as const;

function usageAggregatePayload(usage: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    USAGE_AGGREGATE_FIELDS.flatMap((field) =>
      Object.prototype.hasOwnProperty.call(usage, field) ? [[field, usage[field]]] : []
    )
  );
}

function endpointUrl(baseUrl: string, endpoint: string | undefined, label: string): string {
  if (!endpoint) throw new Error(`服务未声明${label}接口`);
  const resolved = new URL(endpoint, `${baseUrl}/`);
  if (resolved.origin !== new URL(baseUrl).origin)
    throw new Error(`${label}接口必须与连接服务同源`);
  return resolved.toString();
}

function tokenPayload(value: unknown, nowMs: number): TokenPayload | null {
  const payload = asRecord(value);
  const accessToken = stringValue(payload.access_token);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: stringValue(payload.refresh_token) ?? null,
    tokenType: stringValue(payload.token_type) ?? 'Bearer',
    scopes: normalizeScopes(payload),
    expiresAt: normalizeExpiry(
      payload.access_expires_in ?? payload.expires_in,
      payload.access_expires_at,
      nowMs
    ),
    account: normalizeAccount(payload.account ?? payload.identity ?? payload.user),
  };
}

function isLoopbackUrl(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export class AdvancedConnectionService {
  private readonly rootDir: string;
  private readonly indexPath: string;
  private readonly authStorePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly secretStore: ConnectionSecretStore;
  private readonly runtimeHome: string;
  private readonly runtimeCredentialApplier: RuntimeCredentialApplier;
  private readonly injectedTokenDistribution?: TokenDistributionRuntime;
  private readonly onAuthenticated?: (connectionId: string) => Promise<void> | void;
  private readonly attempts = new Map<string, AuthAttempt>();
  private readonly activeTokenClaims = new Set<string>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: AdvancedConnectionServiceOptions) {
    this.rootDir = path.join(options.hermitHome, 'connections');
    this.indexPath = path.join(this.rootDir, 'index.json');
    this.authStorePath = path.join(options.hermitHome, 'auth', 'openhermit.json');
    // 全部出站调用包一层 HTTP 交互记录器（服务日志，~/.hermit/logs/agentbus-http.log）
    this.fetchImpl = createAgentBusHttpLogger({ hermitHome: options.hermitHome }).wrapFetch(
      options.fetchImpl ?? fetch
    );
    this.now = options.now ?? (() => new Date());
    this.secretStore =
      options.secretStore ??
      new SystemCredentialSecretStore(path.join(options.hermitHome, 'connections', 'secrets'));
    this.runtimeHome = options.runtimeHome ?? os.homedir();
    this.runtimeCredentialApplier =
      options.runtimeCredentialApplier ??
      (async (input) => (await loadAikeyRuntime()).applyClaimedSecret(input));
    this.injectedTokenDistribution = options.tokenDistribution;
    this.onAuthenticated = options.onAuthenticated;
  }

  async ensureDefaultConnection(baseUrl: string): Promise<AdvancedConnectionSummary> {
    const normalized = normalizeBaseUrl(baseUrl);
    const timestamp = this.now().toISOString();
    const fallbackRecord: StoredConnectionRecord = {
      schemaVersion: 1,
      id: `connection_${randomUUID().replace(/-/gu, '').slice(0, 16)}`,
      label: 'AgentBus',
      baseUrl: normalized.baseUrl,
      secure: normalized.secure,
      compatibilityMode: true,
      managedDefault: true,
      manifest: compatibilityManifest(),
      state: 'auth_required',
      grantedScopes: [],
      permissions: defaultPermissionDecisions(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let stored = fallbackRecord;
    await this.mutateIndex((index) => {
      const duplicate = index.connections.find((item) => item.baseUrl === normalized.baseUrl);
      if (duplicate) {
        duplicate.managedDefault = true;
        duplicate.updatedAt = timestamp;
        stored = duplicate;
        return;
      }
      index.connections.push(fallbackRecord);
    });
    return this.toSummary(stored);
  }

  async discover(baseUrlInput: string): Promise<DiscoverAdvancedConnectionResponse> {
    const { baseUrl, secure } = normalizeBaseUrl(baseUrlInput);
    // 授权面探测（只对比授权）：well-known 探测失败时，按 CLI 同款参数 POST
    // /api/v1/auth/start——响应含 device_code 契约三字段（flow_id/poll_secret/
    // authorization_url）或 4xx 但端点存在（非 404），判定为 AgentBus 兼容服务。
    const compatibilityResult = async (): Promise<DiscoverAdvancedConnectionResponse | null> => {
      const probe = await this.fetchImpl(`${baseUrl}/api/v1/auth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        // client_kind:"cli" 与 CLI 一致：避免被参数校验 400 误判为不兼容
        body: JSON.stringify({ client_kind: 'cli' }),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        redirect: 'error',
      }).catch(() => null);
      if (!probe) return null;
      if (probe.ok) {
        const payload = asRecord(await probe.json().catch(() => null));
        const flowId = stringValue(payload.flow_id) ?? stringValue(payload.deviceCode);
        const pollSecret =
          stringValue(payload.poll_secret) ?? stringValue(payload.pollSecret) ?? flowId;
        const authorizationUrl =
          stringValue(payload.authorization_url) ?? stringValue(payload.verificationUriComplete);
        return flowId && pollSecret && authorizationUrl
          ? { baseUrl, secure, compatibilityMode: true, manifest: compatibilityManifest() }
          : null;
      }
      if (probe.status !== 404 && probe.status >= 400 && probe.status < 500) {
        return { baseUrl, secure, compatibilityMode: true, manifest: compatibilityManifest() };
      }
      return null;
    };

    const discoveryUrl = `${baseUrl}/.well-known/hermit-provider.json`;
    let response: Response;
    try {
      response = await this.fetchImpl(discoveryUrl, {
        headers: { Accept: 'application/vnd.hermit.provider+json;version=1' },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      throw new Error(`无法连接服务：${error instanceof Error ? error.message : '网络连接失败'}`);
    }
    if (response.status === 404) {
      const compatible = await compatibilityResult();
      if (compatible) return compatible;
      throw new Error('该地址没有提供 AgentCLI Provider Manifest，也不是可识别的 AgentBus 服务');
    }
    if (!response.ok) throw new Error(`服务发现失败（HTTP ${response.status}）`);

    try {
      const manifest = parseProviderManifest(await response.json());
      return { baseUrl, secure, compatibilityMode: false, manifest };
    } catch (manifestError) {
      // Some deployed AgentBus hosts route unknown paths to the web application's HTML shell.
      // Their authenticated API remains identifiable through the legacy auth endpoint.
      const compatible = await compatibilityResult();
      if (compatible) return compatible;
      throw new Error(
        `Provider manifest 格式无效：${manifestError instanceof Error ? manifestError.message : '无法解析响应'}`
      );
    }
  }

  async list(): Promise<AdvancedConnectionSummary[]> {
    let index = await this.readIndex();
    const interruptedIds = index.connections
      .filter(
        (record) =>
          record.state === 'authenticating' &&
          ![...this.attempts.values()].some((attempt) => attempt.connectionId === record.id)
      )
      .map((record) => record.id);
    if (interruptedIds.length > 0) {
      await this.mutateIndex((current) => {
        current.connections = current.connections.map((record) =>
          interruptedIds.includes(record.id)
            ? {
                ...record,
                state: 'error',
                lastError: {
                  code: 'auth_interrupted',
                  message: '授权流程因服务重启中断，请重新登录',
                  at: this.now().toISOString(),
                },
                updatedAt: this.now().toISOString(),
              }
            : record
        );
      });
      index = await this.readIndex();
    }
    return Promise.all(index.connections.map((record) => this.toSummary(record)));
  }

  async create(request: CreateAdvancedConnectionRequest): Promise<AdvancedConnectionSummary> {
    const discovered = await this.discover(request.baseUrl);
    const timestamp = this.now().toISOString();
    const record: StoredConnectionRecord = {
      schemaVersion: 1,
      id: `connection_${randomUUID().replace(/-/gu, '').slice(0, 16)}`,
      label: request.label?.trim() || discovered.manifest.provider.displayName,
      baseUrl: discovered.baseUrl,
      secure: discovered.secure,
      compatibilityMode: discovered.compatibilityMode,
      manifest: discovered.manifest,
      state: discovered.manifest.authMethods.length > 0 ? 'auth_required' : 'ready',
      grantedScopes: [],
      permissions: defaultPermissionDecisions(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.mutateIndex((index) => {
      const duplicate = index.connections.find((item) => item.baseUrl === record.baseUrl);
      if (duplicate) throw new Error('该连接服务已经添加');
      index.connections.push(record);
    });
    return this.toSummary(record);
  }

  async remove(connectionId: string): Promise<void> {
    this.cancelAuthAttempts(connectionId);
    const record = await this.requireRecord(connectionId);
    await this.mutateIndex((index) => {
      const next = index.connections.filter((candidate) => candidate.id !== connectionId);
      if (next.length === index.connections.length) throw new Error('连接不存在');
      index.connections = next;
    });
    await this.secretStore.delete(connectionId);
    await this.removeAuthStoreForCli(record);
  }

  async updatePermissions(
    connectionId: string,
    request: UpdateAdvancedConnectionPermissionsRequest
  ): Promise<AdvancedConnectionSummary> {
    if (request.permissions['credentials.lark.export'] === 'granted') {
      throw new Error('飞书凭证委托暂未开放，不能通过普通授权开关启用');
    }
    if (
      request.permissions['usage.message-content'] === 'granted' &&
      request.highRiskAcknowledged !== true
    ) {
      throw new Error('开启消息正文上报需要高风险确认');
    }
    const record = await this.updateRecord(connectionId, (current) => ({
      ...current,
      permissions: mergePermissionDecisions(current.permissions, request.permissions),
      state:
        current.state === 'authenticated' || current.state === 'ready' ? 'ready' : current.state,
    }));
    return this.toSummary(record);
  }

  async startAuthentication(
    connectionId: string,
    methodId: string
  ): Promise<StartAdvancedConnectionAuthResponse> {
    const record = await this.requireRecord(connectionId);
    this.assertAuthorizedTransport(record);
    if ([...this.attempts.values()].some((attempt) => attempt.connectionId === connectionId)) {
      throw new Error('该连接已经在等待授权');
    }
    const method = record.manifest.authMethods.find((candidate) => candidate.id === methodId);
    if (!method) throw new Error('授权方式不存在');
    if (method.type !== 'device_code') throw new Error('当前版本暂只支持设备授权登录');
    const startUrl = endpointUrl(record.baseUrl, record.manifest.endpoints.authStart, '授权启动');
    let response = await this.fetchImpl(startUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_kind: 'cli', requested_scopes: method.requestedScopes }),
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
    if (response.status === 404 && record.compatibilityMode) {
      response = await this.fetchImpl(`${record.baseUrl}/api/cli-auth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_kind: 'cli' }),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    }
    const payload = asRecord(await response.json().catch(() => null));
    if (!response.ok) throw new Error(`启动授权失败（HTTP ${response.status}）`);
    const start = this.normalizeAuthStart(payload, record.insecureAllowed === true);
    const attemptId = `auth_${randomUUID().replace(/-/gu, '').slice(0, 16)}`;
    const expiresAtMs = Date.now() + start.expiresIn * 1000;
    const attempt: AuthAttempt = {
      id: attemptId,
      connectionId,
      flowId: start.flowId,
      pollSecret: start.pollSecret,
      pollUrl: endpointUrl(record.baseUrl, record.manifest.endpoints.authPoll, '授权查询'),
      meUrl: record.manifest.endpoints.authMe
        ? endpointUrl(record.baseUrl, record.manifest.endpoints.authMe, '账号信息')
        : undefined,
      expiresAtMs,
      intervalMs: Math.max(1000, start.interval * 1000),
      legacyGet: record.compatibilityMode,
    };
    this.attempts.set(attemptId, attempt);
    await this.updateRecord(connectionId, (current) => ({
      ...current,
      state: 'authenticating',
      lastError: undefined,
    }));
    void this.pollAuthAttempt(attempt, record).catch(() => undefined);
    return {
      attemptId,
      authorizationUrl: start.authorizationUrl,
      userCode: start.userCode,
      expiresAt: new Date(expiresAtMs).toISOString(),
      pollAfterMs: attempt.intervalMs,
    };
  }

  async logout(connectionId: string): Promise<AdvancedConnectionSummary> {
    this.cancelAuthAttempts(connectionId);
    const record = await this.requireRecord(connectionId);
    const secret = await this.readSecret(connectionId, record);
    if (secret && record.manifest.endpoints.authLogout) {
      const url = endpointUrl(record.baseUrl, record.manifest.endpoints.authLogout, '退出登录');
      await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `${secret.tokenType} ${secret.accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
        redirect: 'error',
      }).catch(() => null);
    }
    await this.secretStore.delete(connectionId);
    await this.removeAuthStoreForCli(record);
    const updated = await this.updateRecord(connectionId, (current) => ({
      ...current,
      state: current.manifest.authMethods.length ? 'auth_required' : 'ready',
      account: undefined,
      grantedScopes: [],
      lastError: undefined,
    }));
    return this.toSummary(updated);
  }

  async claimAndApplyToken(
    connectionId: string,
    request: AdvancedConnectionTokenClaimRequest,
    onStep?: (event: AdvancedConnectionTokenClaimStepEvent) => void
  ): Promise<AdvancedConnectionTokenClaimResult> {
    const record = await this.requireRecord(connectionId);
    this.assertAuthorizedTransport(record);
    if (!record.manifest.capabilities.some((item) => item.id === 'token-pool')) {
      throw new Error('该服务未提供 Token 池');
    }
    if (this.activeTokenClaims.has(connectionId)) {
      throw new Error('该连接已有 Token 认领任务正在执行');
    }
    const runtimes = [...new Set(request.runtimes)].filter(
      (runtime): runtime is AdvancedConnectionRuntimeId =>
        runtime === 'claude' || runtime === 'codex' || runtime === 'pi'
    );
    if (runtimes.length === 0) throw new Error('请至少选择一个本地运行时');

    // 链式步骤事件（面板进度 + SSE token-claim-event）；失败停在对应步骤并透出服务端原始错误
    const emit = (
      step: AdvancedConnectionTokenClaimStepEvent['step'],
      status: AdvancedConnectionTokenClaimStepEvent['status'],
      extra: { text?: string; error?: string } = {}
    ): void => {
      onStep?.({ connectionId, step, status, ...extra });
    };
    const stepError = (step: AdvancedConnectionTokenClaimStepEvent['step'], label: string) => {
      return (error: unknown): never => {
        const message = error instanceof Error ? error.message : String(error);
        emit(step, 'error', { error: message });
        throw new Error(`${label}：${message}`);
      };
    };

    this.activeTokenClaims.add(connectionId);
    try {
      const tokenDistribution = await (this.injectedTokenDistribution ??
        loadTokenDistributionRuntime());
      // 1. 读取目录（region 默认 cn-shenzhen 由模块内置；defaultModelApiIds 即服务端
      // consumer-ready 精选集合，如 cpamc-cc / cpamc-openai——provision 不传全量目录）
      emit('discover', 'start');
      let catalog = await tokenDistribution
        .discoverCatalog({})
        .catch(stepError('discover', '读取 Token 池目录失败'));
      if (!catalog.discoveryId) {
        stepError('discover', '读取 Token 池目录失败')(new Error('目录未返回 discovery_id'));
      }
      emit('discover', 'done', {
        ...(catalog.defaultApiName ? { text: `默认模型 ${catalog.defaultApiName}` } : {}),
      });
      // 2. 发起认领：传同一次 discover 返回的 defaultModelApiIds（服务端精选集）；
      // discovery 过期（aliyun_discovery_stale）时自动重新 discover 一次并重试 provision（仅一次）
      emit('provision', 'start');
      let runId: string;
      try {
        ({ runId } = await tokenDistribution.provisionRun({
          discoveryId: catalog.discoveryId as string,
          gatewayId: catalog.gatewayId,
          aliyunModelApiIds: tokenDistribution.selectModelApiIds(catalog.defaultModelApiIds),
        }));
      } catch (error) {
        if (!isDiscoveryStaleError(error)) {
          stepError('provision', 'Token 池认领启动失败')(error);
        }
        emit('provision', 'progress', { text: 'discovery 已过期，重新读取目录并重试' });
        emit('discover', 'start');
        catalog = await tokenDistribution
          .discoverCatalog({})
          .catch(stepError('discover', '重新读取 Token 池目录失败'));
        if (!catalog.discoveryId) {
          stepError('discover', '重新读取 Token 池目录失败')(new Error('目录未返回 discovery_id'));
        }
        emit('discover', 'done', {
          ...(catalog.defaultApiName ? { text: `默认模型 ${catalog.defaultApiName}` } : {}),
        });
        ({ runId } = await tokenDistribution
          .provisionRun({
            discoveryId: catalog.discoveryId as string,
            gatewayId: catalog.gatewayId,
            aliyunModelApiIds: tokenDistribution.selectModelApiIds(catalog.defaultModelApiIds),
          })
          .catch(stepError('provision', 'Token 池认领启动失败')));
      }
      emit('provision', 'done');
      // 3. 等待开通（onTick 透传服务端状态做进度）
      emit('poll', 'start');
      await tokenDistribution
        .pollRun(runId, { onTick: (status) => emit('poll', 'progress', { text: status }) })
        .catch(stepError('poll', 'Token 池认领失败'));
      emit('poll', 'done');
      // 4. 领取凭证（明文 key 即焚语义：只经内存传给应用步骤，不落盘）
      emit('claim', 'start');
      const receipt = await tokenDistribution
        .claimSecret(runId)
        .catch(stepError('claim', 'Token 领取失败'));
      const claimedKey = receipt.key;
      emit('claim', 'done');
      // 5. 写入本地运行时配置（既有 aikey 复用路径）
      emit('apply', 'start');
      const claimedSecret: Record<string, unknown> = {
        key: claimedKey,
        keyId: receipt.keyId ?? undefined,
        endpoint: receipt.endpoint || undefined,
        endpoints: receipt.endpoints,
        runtimeProfiles: receipt.runtimeProfiles,
        modelsUrl: receipt.modelsUrl || undefined,
        modelIds: receipt.modelIds,
        expiresAt: receipt.expiresAt ?? undefined,
      };
      const aikeyRuntime = await loadAikeyRuntime();
      const validation = aikeyRuntime.validateClaimedSecret(claimedSecret);
      if (!validation.ok) {
        stepError(
          'apply',
          'Token 无法应用'
        )(new Error(sanitizeRemoteMessage(validation.reason || '返回内容无效')));
      }
      let applied: RuntimeCredentialApplyOutput;
      try {
        applied = await this.runtimeCredentialApplier({
          secret: claimedSecret,
          choices: {
            ...(request.model?.trim() ? { model: request.model.trim() } : {}),
            ...(request.wireApi ? { wireApi: request.wireApi } : {}),
          },
          runtimes,
          home: this.runtimeHome,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stepError(
          'apply',
          'Token 已领取，但本地应用失败'
        )(new Error(sanitizeRemoteMessage(message, [claimedKey])));
      }
      const expectedResultNames: Record<AdvancedConnectionRuntimeId, string[]> = {
        claude: ['claude'],
        codex: ['codex-auth', 'codex-config'],
        pi: ['pi'],
      };
      const runtimeResults: AdvancedConnectionRuntimeApplyResult[] = runtimes.map((runtime) => {
        const matches = (applied.runtimes ?? []).filter((item) =>
          expectedResultNames[runtime].includes(item.runtime ?? '')
        );
        const ok =
          applied.ok === true &&
          matches.length === expectedResultNames[runtime].length &&
          matches.every((item) => item.ok !== false && !item.error);
        const pathResult = [...matches].reverse().find((item) => item.path);
        const error = matches.find((item) => item.error)?.error;
        return {
          runtime,
          ok,
          ...(pathResult?.path ? { path: path.basename(pathResult.path) } : {}),
          ...(!ok
            ? {
                error: sanitizeRemoteMessage(
                  error || `缺少 ${expectedResultNames[runtime].join('/')} 成功结果`,
                  [claimedKey]
                ),
              }
            : {}),
        };
      });
      const warnings = runtimeResults
        .filter((result) => !result.ok)
        .map((result) => `${result.runtime}：${result.error || '本地配置失败'}`);
      if (warnings.length > 0) {
        stepError('apply', 'Token 已领取，但本地应用未完成')(new Error(warnings.join('；')));
      }
      emit('apply', 'done');
      return {
        ok: true,
        ...(receipt.keyId ? { keyId: receipt.keyId } : {}),
        maskedKey: aikeyRuntime.maskKey(claimedKey),
        ...(receipt.expiresAt ? { expiresAt: receipt.expiresAt } : {}),
        ...(request.model?.trim() ? { model: request.model.trim() } : {}),
        runtimes: runtimeResults,
        appliedAt: this.now().toISOString(),
        warnings,
      };
    } finally {
      this.activeTokenClaims.delete(connectionId);
    }
  }

  async syncAuthorizedData(
    connectionId: string,
    snapshot: AdvancedConnectionLocalSnapshot
  ): Promise<AdvancedConnectionSyncResult> {
    const record = await this.requireRecord(connectionId);
    this.assertAuthorizedTransport(record);
    const secret = await this.getValidSecret(record);
    if (!secret) throw new Error('请先完成用户授权');
    const sent: AdvancedConnectionSyncResult['sent'] = [];
    const skipped: AdvancedConnectionSyncResult['skipped'] = [];
    const postChannel = async (
      channel: string,
      endpoint: string | undefined,
      permitted: boolean,
      payload: Record<string, unknown>
    ): Promise<void> => {
      if (!permitted) {
        skipped.push({ channel, reason: '本地授权未开启' });
        return;
      }
      if (!endpoint) {
        skipped.push({ channel, reason: '服务未声明对应端点' });
        return;
      }
      if (record.compatibilityMode) {
        skipped.push({
          channel,
          // 新版 AgentBus 的 /report/usage 只读（405）：聚合用量由消息上报通道自动汇总
          reason:
            channel === 'usage'
              ? '聚合用量由消息上报通道自动汇总'
              : '当前 AgentBus 使用既有专用通道，不发送通用 Provider 载荷',
        });
        return;
      }
      const url = endpointUrl(record.baseUrl, endpoint, channel);
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `${secret.tokenType} ${secret.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ schemaVersion: 1, source: 'agentcli', ...payload }),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`${channel} 同步失败（HTTP ${response.status}）`);
      sent.push({ channel, endpoint });
    };

    const permissions = record.permissions;
    await postChannel(
      'team-directory',
      record.manifest.endpoints.teamDirectory,
      permissions['team.directory'] === 'granted' || permissions['team.presence'] === 'granted',
      {
        generatedAt: snapshot.generatedAt,
        teams: snapshot.teams.map((team) => ({
          slug: team.slug,
          displayName: team.displayName,
          ...(permissions['team.directory'] === 'granted'
            ? { description: team.description, harness: team.harness }
            : {}),
          ...(permissions['team.presence'] === 'granted' ? { online: team.online } : {}),
        })),
      }
    );
    await postChannel(
      'team-tasks',
      record.manifest.endpoints.teamTasks,
      permissions['team.tasks.write'] === 'granted',
      { generatedAt: snapshot.generatedAt, tasks: snapshot.tasks }
    );
    await postChannel(
      'usage',
      record.manifest.endpoints.reportUsage,
      permissions['usage.aggregates'] === 'granted' ||
        permissions['usage.project-metadata'] === 'granted',
      {
        generatedAt: snapshot.generatedAt,
        ...(permissions['usage.aggregates'] === 'granted'
          ? { aggregates: usageAggregatePayload(snapshot.usage ?? {}) }
          : {}),
        ...(permissions['usage.project-metadata'] === 'granted'
          ? {
              projects: snapshot.teams.map((team) => ({
                projectRef: team.slug,
                displayName: team.displayName,
                harness: team.harness,
              })),
            }
          : {}),
      }
    );
    await postChannel(
      'capabilities',
      record.manifest.endpoints.reportCapabilities,
      permissions['capabilities.inventory'] === 'granted',
      { generatedAt: snapshot.generatedAt, capabilities: snapshot.capabilities ?? [] }
    );
    await this.updateRecord(connectionId, (current) => ({
      ...current,
      // 同步无异常即视为已连接：兼容模式下通道按设计全部跳过（sent 为空）
      state: 'connected',
      lastError: undefined,
    }));
    return { ok: true, sent, skipped, syncedAt: new Date(this.now()).toISOString() };
  }

  async pullRemoteTasks(connectionId: string): Promise<AdvancedConnectionPullTasksResult> {
    const record = await this.requireRecord(connectionId);
    this.assertAuthorizedTransport(record);
    if (record.permissions['team.tasks.read'] !== 'granted') {
      throw new Error('请先允许“接收远程任务”');
    }
    const secret = await this.getValidSecret(record);
    if (!secret) throw new Error('请先完成用户授权');
    if (!record.manifest.endpoints.teamTasks) {
      throw new Error('服务未声明远程任务端点');
    }
    if (record.compatibilityMode) {
      throw new Error('当前 AgentBus 兼容接口尚未提供远程任务通道');
    }
    const url = endpointUrl(record.baseUrl, record.manifest.endpoints.teamTasks, '远程任务');
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `${secret.tokenType} ${secret.accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`读取远程任务失败（HTTP ${response.status}）`);
    const payload = asRecord(await response.json().catch(() => null));
    const rawTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    const tasks = rawTasks.slice(0, 100).flatMap((value) => {
      const task = asRecord(value);
      const remoteId = stringValue(task?.id) ?? stringValue(task?.task_id);
      const title = stringValue(task?.title);
      if (!remoteId || !title) return [];
      return [
        {
          remoteId,
          title,
          ...(stringValue(task?.description)
            ? { description: stringValue(task?.description) }
            : {}),
          ...(stringValue(task?.status) ? { status: stringValue(task?.status) } : {}),
          ...(stringValue(task?.assignee) ? { assignee: stringValue(task?.assignee) } : {}),
        },
      ];
    });
    return { ok: true, tasks, pulledAt: new Date(this.now()).toISOString() };
  }

  private normalizeAuthStart(
    payload: Record<string, unknown>,
    allowInsecureHttp = false
  ): AuthStartPayload {
    const flowId = stringValue(payload.flow_id) ?? stringValue(payload.deviceCode);
    const pollSecret =
      stringValue(payload.poll_secret) ?? stringValue(payload.pollSecret) ?? flowId;
    const rawAuthorizationUrl =
      stringValue(payload.authorization_url) ?? stringValue(payload.verificationUriComplete);
    if (!flowId || !pollSecret || !rawAuthorizationUrl) {
      throw new Error('授权服务返回格式不受支持');
    }
    const expiresInValue = Number(payload.expires_in ?? payload.expiresIn ?? 600);
    const intervalValue = Number(payload.interval ?? 2);
    const expiresIn = Number.isFinite(expiresInValue)
      ? Math.min(1800, Math.max(30, expiresInValue))
      : 600;
    const interval = Number.isFinite(intervalValue) ? Math.min(15, Math.max(1, intervalValue)) : 2;
    return {
      flowId,
      pollSecret,
      authorizationUrl: validateAuthorizationUrl(rawAuthorizationUrl, allowInsecureHttp),
      userCode: stringValue(payload.user_code) ?? stringValue(payload.userCode),
      expiresIn,
      interval,
    };
  }

  private async pollAuthAttempt(
    attempt: AuthAttempt,
    initialRecord: StoredConnectionRecord
  ): Promise<void> {
    let intervalMs = attempt.intervalMs;
    while (Date.now() < attempt.expiresAtMs && this.attempts.has(attempt.id)) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (!this.attempts.has(attempt.id)) return;

      const pollUrl = new URL(attempt.pollUrl);
      const init: RequestInit = attempt.legacyGet
        ? {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
            redirect: 'error',
          }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ flow_id: attempt.flowId, poll_secret: attempt.pollSecret }),
            signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
            redirect: 'error',
          };
      if (attempt.legacyGet) {
        pollUrl.searchParams.set('flow_id', attempt.flowId);
        pollUrl.searchParams.set('poll_secret', attempt.pollSecret);
      }

      let response: Response;
      try {
        response = await this.fetchImpl(pollUrl, init);
      } catch {
        intervalMs = Math.min(15_000, intervalMs + 1000);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        intervalMs = Math.min(15_000, intervalMs + 1000);
        continue;
      }

      const payload = asRecord(await response.json().catch(() => null));
      const token = tokenPayload(payload, Date.now());
      if (response.ok && token) {
        if (!this.attempts.has(attempt.id)) return;
        let account = token.account;
        let scopes = token.scopes;
        if (attempt.meUrl) {
          const meResponse = await this.fetchImpl(attempt.meUrl, {
            headers: {
              Authorization: `${token.tokenType} ${token.accessToken}`,
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
            redirect: 'error',
          }).catch(() => null);
          if (meResponse?.ok) {
            const me = asRecord(await meResponse.json().catch(() => null));
            account = normalizeAccount(me.account ?? me.user ?? me.identity ?? me) ?? account;
            const remoteScopes = normalizeScopes(me);
            scopes = remoteScopes.length > 0 ? remoteScopes : scopes;
          }
        }
        if (!this.attempts.has(attempt.id)) return;
        await this.writeSecret({
          schemaVersion: 1,
          connectionId: attempt.connectionId,
          providerId: initialRecord.manifest.provider.id,
          issuerOrigin: initialRecord.baseUrl,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken ?? null,
          tokenType: token.tokenType,
          scopes,
          expiresAt: token.expiresAt ?? null,
          updatedAt: this.now().toISOString(),
        });
        if (!this.attempts.has(attempt.id)) {
          await this.secretStore.delete(attempt.connectionId);
          return;
        }
        try {
          await this.updateRecord(attempt.connectionId, (current) => ({
            ...current,
            state: 'authenticated',
            account,
            grantedScopes: scopes,
            permissions:
              current.managedDefault && current.compatibilityMode
                ? { ...current.permissions, 'usage.aggregates': 'granted' }
                : current.permissions,
            lastError: undefined,
          }));
        } catch {
          await this.secretStore.delete(attempt.connectionId);
          this.attempts.delete(attempt.id);
          return;
        }
        this.attempts.delete(attempt.id);
        const loggedIn = await this.requireRecord(attempt.connectionId).catch(() => null);
        if (loggedIn) await this.syncAuthStoreToCli(loggedIn);
        await Promise.resolve(this.onAuthenticated?.(attempt.connectionId)).catch(() => undefined);
        return;
      }

      const status = stringValue(payload.error) ?? stringValue(payload.status);
      if (status === 'authorization_pending') continue;
      if (status === 'slow_down') {
        intervalMs = Math.min(15_000, intervalMs + 1000);
        continue;
      }
      this.attempts.delete(attempt.id);
      await this.setError(
        attempt.connectionId,
        'auth_poll_failed',
        sanitizeRemoteMessage(status || `授权查询失败（HTTP ${response.status}）`)
      ).catch(() => undefined);
      return;
    }
    if (this.attempts.delete(attempt.id)) {
      await this.setError(attempt.connectionId, 'auth_timeout', '授权已超时，请重新登录').catch(
        () => undefined
      );
    }
  }

  private cancelAuthAttempts(connectionId: string): void {
    for (const [attemptId, attempt] of this.attempts) {
      if (attempt.connectionId === connectionId) this.attempts.delete(attemptId);
    }
  }

  private async setError(connectionId: string, code: string, message: string): Promise<void> {
    await this.updateRecord(connectionId, (current) => ({
      ...current,
      state: 'error',
      lastError: { code, message: sanitizeRemoteMessage(message), at: this.now().toISOString() },
    }));
  }

  private assertAuthorizedTransport(record: StoredConnectionRecord): void {
    if (!record.secure && !isLoopbackUrl(record.baseUrl) && !record.insecureAllowed) {
      throw new Error('远程连接必须使用 HTTPS；HTTP 仅允许 localhost 或 127.0.0.1');
    }
  }

  /** 用户确认 HTTP 传输风险后，持久化放行该连接（secret 下发/Token 池随之可用） */
  async allowInsecureTransport(connectionId: string): Promise<AdvancedConnectionSummary> {
    const updated = await this.updateRecord(connectionId, (current) => ({
      ...current,
      insecureAllowed: true,
    }));
    return this.toSummary(updated);
  }

  private async requireRecord(connectionId: string): Promise<StoredConnectionRecord> {
    const index = await this.readIndex();
    const record = index.connections.find((item) => item.id === connectionId);
    if (!record) throw new Error('连接不存在');
    return record;
  }

  private async updateRecord(
    connectionId: string,
    updater: (record: StoredConnectionRecord) => StoredConnectionRecord
  ): Promise<StoredConnectionRecord> {
    let updated: StoredConnectionRecord | undefined;
    await this.mutateIndex((index) => {
      const position = index.connections.findIndex((item) => item.id === connectionId);
      if (position < 0) throw new Error('连接不存在');
      const current = index.connections[position];
      updated = { ...updater(current), updatedAt: this.now().toISOString() };
      index.connections[position] = updated;
    });
    return updated!;
  }

  private async toSummary(record: StoredConnectionRecord): Promise<AdvancedConnectionSummary> {
    const secretPresent = await this.secretStore.has(record.id).catch(() => false);
    return {
      id: record.id,
      label: record.label,
      baseUrl: record.baseUrl,
      secure: record.secure,
      ...(record.insecureAllowed ? { insecureAllowed: true } : {}),
      providerId: record.manifest.provider.id,
      providerName: record.manifest.provider.displayName,
      providerDescription: record.manifest.provider.description,
      compatibilityMode: record.compatibilityMode,
      state: record.state,
      account: record.account,
      grantedScopes: record.grantedScopes,
      capabilities: record.manifest.capabilities,
      authMethods: record.manifest.authMethods,
      permissions: record.permissions,
      secretPresent,
      lastError: record.lastError,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async readIndex(): Promise<ConnectionIndexFile> {
    try {
      const raw = await readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as ConnectionIndexFile;
      if (
        parsed?.schemaVersion === CONNECTION_SCHEMA_VERSION &&
        Array.isArray(parsed.connections)
      ) {
        return parsed;
      }
      throw new Error('连接配置版本无效');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, connections: [] };
      }
      throw new Error(`高级连接配置损坏：${error instanceof Error ? error.message : '无法读取'}`);
    }
  }

  private async mutateIndex(mutator: (index: ConnectionIndexFile) => void): Promise<void> {
    const operation = this.mutationQueue.then(async () => {
      const index = await this.readIndex();
      mutator(index);
      await mkdir(this.rootDir, { recursive: true });
      const temporary = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify(index, null, 2), { mode: 0o600 });
      await rename(temporary, this.indexPath);
    });
    this.mutationQueue = operation.catch(() => undefined);
    return operation;
  }

  private async getValidSecret(record: StoredConnectionRecord): Promise<ConnectionSecret | null> {
    const current = await this.readSecret(record.id, record);
    if (!current) return null;
    const expiresAtMs = current.expiresAt
      ? Date.parse(current.expiresAt)
      : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > Date.now() + 90_000) return current;
    if (!current.refreshToken || !record.manifest.endpoints.authRefresh) {
      await this.secretStore.delete(record.id);
      await this.updateRecord(record.id, (connection) => ({
        ...connection,
        state: 'auth_required',
        account: undefined,
        grantedScopes: [],
      }));
      return null;
    }
    const refreshUrl = endpointUrl(
      record.baseUrl,
      record.manifest.endpoints.authRefresh,
      '授权刷新'
    );
    let response: Awaited<ReturnType<typeof this.fetchImpl>>;
    try {
      response = await this.fetchImpl(refreshUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      // 网络级失败（断网/超时/DNS）：保留凭证，本轮操作软失败，下次再试。
      // 此前一律删 secret，导致网络抖动就会把用户踢下线。
      await this.updateRecord(record.id, (connection) => ({
        ...connection,
        lastError: {
          code: 'auth_refresh_network',
          message: `授权刷新暂时不可用（网络问题，将自动重试）：${error instanceof Error ? error.message : String(error)}`,
          at: this.now().toISOString(),
        },
      }));
      return null;
    }
    const refreshed = tokenPayload(await response.json().catch(() => null), Date.now());
    if (response.ok && refreshed) {
      const next: ConnectionSecret = {
        ...current,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || current.refreshToken,
        tokenType: refreshed.tokenType,
        scopes: refreshed.scopes.length > 0 ? refreshed.scopes : current.scopes,
        expiresAt: refreshed.expiresAt ?? null,
        updatedAt: this.now().toISOString(),
      };
      await this.writeSecret(next);
      await this.syncAuthStoreToCli(record);
      return next;
    }
    // 服务端明确拒绝（401/403 或无效响应）：非授权类 5xx 同样保留凭证
    if (response.status === 401 || response.status === 403 || response.status === 400) {
      await this.secretStore.delete(record.id);
      await this.updateRecord(record.id, (connection) => ({
        ...connection,
        state: 'auth_required',
        account: undefined,
        grantedScopes: [],
        lastError: {
          code: 'auth_refresh_failed',
          message: '登录授权已过期，请重新登录',
          at: this.now().toISOString(),
        },
      }));
      return null;
    }
    await this.updateRecord(record.id, (connection) => ({
      ...connection,
      lastError: {
        code: 'auth_refresh_server',
        message: `授权刷新暂时不可用（HTTP ${response.status}，将自动重试）`,
        at: this.now().toISOString(),
      },
    }));
    return null;
  }

  private async readSecret(
    connectionId: string,
    expected?: Pick<StoredConnectionRecord, 'baseUrl' | 'manifest'>
  ): Promise<ConnectionSecret | null> {
    try {
      const serialized = await this.secretStore.get(connectionId);
      if (!serialized) return null;
      const parsed = JSON.parse(serialized) as ConnectionSecret;
      if (parsed?.connectionId !== connectionId) return null;
      if (
        expected &&
        (parsed.providerId !== expected.manifest.provider.id ||
          parsed.issuerOrigin !== expected.baseUrl)
      ) {
        await this.secretStore.delete(connectionId);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeSecret(secret: ConnectionSecret): Promise<void> {
    await this.secretStore.put(secret.connectionId, JSON.stringify(secret));
  }

  /** App → CLI 写穿透（仅默认 AgentBus 连接；失败不阻断自身流程） */
  private async syncAuthStoreToCli(record: StoredConnectionRecord): Promise<void> {
    if (!isDefaultAgentbusRecord(record)) return;
    try {
      const secret = await this.readSecret(record.id, record);
      if (!secret) return;
      await writeAuthStoreThrough({
        authStorePath: this.authStorePath,
        record: record as never,
        secret,
        now: this.now().toISOString(),
      });
    } catch (error) {
      console.warn(
        '[auth-sync] App→CLI 写穿透失败（不影响本次操作）:',
        error instanceof Error ? error.message : error
      );
    }
  }

  /** App 显式登出/删除默认连接时同步删除 CLI auth store */
  private async removeAuthStoreForCli(record: StoredConnectionRecord): Promise<void> {
    if (!isDefaultAgentbusRecord(record)) return;
    try {
      await removeAuthStore({ authStorePath: this.authStorePath });
    } catch (error) {
      console.warn(
        '[auth-sync] 删除 CLI 登录态失败（不影响本次操作）:',
        error instanceof Error ? error.message : error
      );
    }
  }
}
