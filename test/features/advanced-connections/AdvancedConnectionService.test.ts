import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AdvancedConnectionService } from '@features/advanced-connections/main';
import type { ConnectionSecretStore } from '@features/advanced-connections/main/infrastructure/SystemCredentialSecretStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 版本比较用 CLI 真实实现（sortModelsByVersion/pickHighestVersionModel），不在测试里重写
const { sortModelsByVersion, pickHighestVersionModel } = (await import(
  pathToFileURL(path.join(process.cwd(), 'bin', 'lib', 'tokenDistribution.mjs')).href
)) as {
  sortModelsByVersion(modelIds: string[]): string[];
  pickHighestVersionModel(modelIds: string[]): string | null;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchInput = string | URL | Request;

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function compatibilityFetch(): typeof fetch {
  return vi.fn((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      // 授权面探测：POST /api/v1/auth/start 返回 device_code 契约三字段 → AgentBus 兼容
      requestUrl(input).endsWith('/api/v1/auth/start') && init?.method === 'POST'
        ? jsonResponse({
            flow_id: 'flow-1',
            poll_secret: 'poll-secret-1',
            authorization_url: 'https://login.company.test/authorize',
          })
        : requestUrl(input).endsWith('/api/v1/auth/me')
          ? jsonResponse({}, 401)
          : jsonResponse({}, 404)
    )
  ) as unknown as typeof fetch;
}

class MemorySecretStore implements ConnectionSecretStore {
  readonly values = new Map<string, string>();

  put(connectionId: string, serializedSecret: string): Promise<void> {
    this.values.set(connectionId, serializedSecret);
    return Promise.resolve();
  }

  get(connectionId: string): Promise<string | null> {
    return Promise.resolve(this.values.get(connectionId) ?? null);
  }

  has(connectionId: string): Promise<boolean> {
    return Promise.resolve(this.values.has(connectionId));
  }

  delete(connectionId: string): Promise<void> {
    this.values.delete(connectionId);
    return Promise.resolve();
  }
}

describe('AdvancedConnectionService', () => {
  let hermitHome: string;

  beforeEach(async () => {
    hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentcli-connections-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(hermitHome, { recursive: true, force: true });
  });

  it('falls back to AgentBus compatibility mode when the manifest path returns the web HTML shell', async () => {
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/v1/auth/start') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            flow_id: 'flow-1',
            poll_secret: 'poll-secret-1',
            authorization_url: 'https://login.company.test/authorize',
          })
        );
      }
      if (url.endsWith('/api/v1/auth/me')) return Promise.resolve(jsonResponse({}, 401));
      return Promise.resolve(
        new Response('<!doctype html><title>AI Monitor</title>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );
    });
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore: new MemorySecretStore(),
    });

    const discovered = await service.discover('http://47.112.24.153/');

    expect(discovered).toMatchObject({
      baseUrl: 'http://47.112.24.153',
      secure: false,
      compatibilityMode: true,
      manifest: { provider: { id: 'openhermit-agentbus' } },
    });
  });

  it('refuses bearer-token authorization over remote cleartext HTTP until the user allows it', async () => {
    const fetchImpl = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/v1/auth/me')) return Promise.resolve(jsonResponse({}, 401));
      if (url.endsWith('/api/v1/auth/start')) {
        return Promise.resolve(
          jsonResponse({
            flow_id: 'flow-1',
            poll_secret: 'poll-secret',
            authorization_url: 'http://47.112.24.153/authorize',
            user_code: '1234',
          })
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    }) as unknown as typeof fetch;
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl,
      secretStore: new MemorySecretStore(),
    });
    const connection = await service.create({ baseUrl: 'http://47.112.24.153/' });

    // 未确认前：HTTP 非回环拒绝下发凭据
    await expect(service.startAuthentication(connection.id, 'company-login')).rejects.toThrow(
      '必须使用 HTTPS'
    );

    // 用户确认风险后持久化放行，summary 携带 insecureAllowed
    const allowed = await service.allowInsecureTransport(connection.id);
    expect(allowed.insecureAllowed).toBe(true);

    const auth = await service.startAuthentication(connection.id, 'company-login');
    expect(auth.authorizationUrl).toContain('47.112.24.153');

    // 重启后（新 service 实例读同一存储）选择仍然生效，不重复询问
    const reloaded = new AdvancedConnectionService({
      hermitHome,
      fetchImpl,
      secretStore: new MemorySecretStore(),
    });
    const list = await reloaded.list();
    expect(list[0]?.insecureAllowed).toBe(true);
    // attempts 为实例内存，重载实例可再次发起；关键是传输放行已持久化，不再因 HTTPS 被拒
    const reloadedAuth = await reloaded.startAuthentication(connection.id, 'company-login');
    expect(reloadedAuth.authorizationUrl).toContain('47.112.24.153');
  });

  it('rejects remote cleartext authorization pages returned by an HTTPS provider', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/.well-known/hermit-provider.json')) {
        return jsonResponse({
          schemaVersion: 1,
          provider: { id: 'standard-provider', displayName: '标准 Provider' },
          apiVersion: '2026-01-01',
          capabilities: [{ id: 'identity', displayName: '授权' }],
          authMethods: [{ id: 'device', type: 'device_code', displayName: '登录' }],
          endpoints: { authStart: '/api/auth/start' },
        });
      }
      if (url.endsWith('/api/auth/start')) {
        return jsonResponse({
          flow_id: 'flow-http-login',
          poll_secret: 'poll-secret',
          authorization_url: 'http://login.company.test/authorize',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore: new MemorySecretStore(),
    });
    const connection = await service.create({ baseUrl: 'https://provider.company.test' });

    await expect(service.startAuthentication(connection.id, 'device')).rejects.toThrow(
      '授权页面必须使用 HTTPS'
    );
  });

  it('bridges App login/refresh/logout to the CLI auth store (managedDefault only)', async () => {
    let refreshCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      await Promise.resolve();
      const url = requestUrl(input);
      if (url.endsWith('/.well-known/hermit-provider.json')) return jsonResponse({}, 404);
      if (url.endsWith('/api/v1/auth/me') && !new Headers(init?.headers).get('Authorization')) {
        return jsonResponse({}, 401);
      }
      if (url.endsWith('/api/v1/auth/start')) {
        return jsonResponse({
          flow_id: 'flow-1',
          poll_secret: 'poll-secret-1',
          authorization_url: 'https://login.company.test/authorize',
          expires_in: 600,
          interval: 1,
        });
      }
      if (url.includes('/api/v1/auth/poll?')) {
        return jsonResponse({
          access_token: 'app-access-token',
          refresh_token: 'app-refresh-token',
          token_type: 'Bearer',
          scopes: ['upload:read'],
          expires_in: 30,
        });
      }
      if (url.endsWith('/api/v1/auth/me')) {
        return jsonResponse({
          status: 'ok',
          account: { id: 'u-1', display_name: '测试用户', tenant_name: '测试公司' },
        });
      }
      if (url.endsWith('/api/v1/auth/refresh')) {
        refreshCount += 1;
        return jsonResponse({
          access_token: 'app-access-token-v2',
          refresh_token: 'app-refresh-token-v2',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (url.endsWith('/api/v1/auth/logout')) return jsonResponse({ ok: true });
      if (url.endsWith('/api/v1/token-distribution-v3/aliyun/discover')) {
        return jsonResponse({ discovery_id: 'd-1', model_apis: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const authStorePath = path.join(hermitHome, 'auth', 'openhermit.json');
    const readCliStore = async () =>
      JSON.parse(await readFile(authStorePath, 'utf8').catch(() => 'null')) as never;
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore: new MemorySecretStore(),
    });
    const connection = await service.ensureDefaultConnection('https://bus.company.test');

    // 1) App 登录 → CLI auth store 立即已登录（账号与 App 一致）
    await service.startAuthentication(connection.id, 'company-login');
    let cliStore = await readCliStore();
    for (let attempt = 0; attempt < 20 && cliStore === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      cliStore = await readCliStore();
    }
    expect(cliStore).toMatchObject({
      provider: 'openhermit',
      issuer: 'https://bus.company.test',
      account: { id: 'u-1', name: '测试用户', tenantName: '测试公司' },
      token: { accessToken: 'app-access-token', refreshToken: 'app-refresh-token' },
    });

    // 2) App 刷新成功 → CLI store token 写穿透一致（sync 触发 getValidSecret → refresh）
    await service.syncAuthorizedData(connection.id, {
      generatedAt: '2026-01-01T00:00:00.000Z',
      teams: [],
      tasks: [],
      usage: {},
    });
    expect(refreshCount).toBe(1);
    cliStore = await readCliStore();
    expect(cliStore).toMatchObject({
      token: { accessToken: 'app-access-token-v2', refreshToken: 'app-refresh-token-v2' },
    });

    // 3) App 登出 → CLI auth store 删除
    await service.logout(connection.id);
    expect(await readCliStore()).toBeNull();
  });

  it('does not bridge non-default connections or cascade CLI store deletion on refresh failure', async () => {
    let refreshShouldFail = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      await Promise.resolve();
      const url = requestUrl(input);
      if (url.endsWith('/.well-known/hermit-provider.json')) {
        return jsonResponse({
          schemaVersion: 1,
          provider: { id: 'standard-provider', displayName: '标准 Provider' },
          apiVersion: '2026-01-01',
          capabilities: [{ id: 'identity', displayName: '授权' }],
          authMethods: [{ id: 'device', type: 'device_code', displayName: '登录' }],
          endpoints: {
            authStart: '/api/auth/start',
            authPoll: '/api/auth/poll',
            authRefresh: '/api/auth/refresh',
            authMe: '/api/auth/me',
            authLogout: '/api/auth/logout',
          },
        });
      }
      if (url.endsWith('/api/auth/start')) {
        return jsonResponse({
          flow_id: 'flow-1',
          poll_secret: 'poll-secret-1',
          authorization_url: 'https://login.company.test/authorize',
          expires_in: 600,
          interval: 1,
        });
      }
      if (url.includes('/api/auth/poll?')) {
        return jsonResponse({
          access_token: 'standard-access-token',
          refresh_token: 'standard-refresh-token',
          token_type: 'Bearer',
          expires_in: 30,
        });
      }
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ status: 'ok', account: { id: 'u-2', display_name: '标准用户' } });
      }
      if (url.endsWith('/api/auth/refresh')) {
        if (refreshShouldFail) return jsonResponse({ error: 'invalid_grant' }, 401);
        return jsonResponse({ access_token: 'standard-access-token-v2', expires_in: 3600 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const authStorePath = path.join(hermitHome, 'auth', 'openhermit.json');
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore: new MemorySecretStore(),
    });

    // 非默认连接登录：不写 CLI store（D1 只桥接 managedDefault）
    const custom = await service.create({ baseUrl: 'https://provider.company.test' });
    await service.startAuthentication(custom.id, 'device');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cliStoreAfterCustomLogin = await readFile(authStorePath, 'utf8').catch(() => null);
    expect(cliStoreAfterCustomLogin).toBeNull();

    // 手工种一个 CLI store，随后 App 默认连接刷新失败：不级联删除（D2）
    const defaultConnection = await service.ensureDefaultConnection('https://bus.company.test');
    const { writeJsonAtomic } = await import('@shared/authSync/index.mjs');
    await writeJsonAtomic(authStorePath, {
      provider: 'openhermit',
      token: { accessToken: 'cli-token', updatedAt: '2026-01-01T00:00:00.000Z' },
    });
    const secretStore = new MemorySecretStore();
    void secretStore;
    // 默认连接写入一个即将过期且刷新会失败的 secret
    const failingService = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore: new MemorySecretStore(),
    });
    const expiring = {
      schemaVersion: 1 as const,
      connectionId: defaultConnection.id,
      providerId: 'openhermit-agentbus',
      issuerOrigin: 'https://bus.company.test',
      accessToken: 'stale-token',
      refreshToken: 'stale-refresh',
      tokenType: 'Bearer',
      scopes: [],
      expiresAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await (
      failingService as never as { secretStore: { put(id: string, s: string): Promise<void> } }
    ).secretStore.put(defaultConnection.id, JSON.stringify(expiring));
    refreshShouldFail = true;
    const refreshed = await (
      failingService as never as {
        getValidSecret(record: unknown): Promise<unknown>;
      }
    ).getValidSecret(defaultConnection);

    expect(refreshed).toBeNull();
    // App 自身降级（secret 删除、state 回退），但 CLI store 保留
    const cliStore = JSON.parse(await readFile(authStorePath, 'utf8')) as {
      token?: { accessToken?: string };
    };
    expect(cliStore.token?.accessToken).toBe('cli-token');
  });

  it('keeps the secret when token refresh fails with a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore: new MemorySecretStore(),
    });
    const connection = await service.ensureDefaultConnection('https://bus.company.test');
    const record = await (
      service as never as {
        requireRecord(id: string): Promise<Record<string, unknown>>;
      }
    ).requireRecord(connection.id);
    const expiring = {
      schemaVersion: 1 as const,
      connectionId: connection.id,
      providerId: 'openhermit-agentbus',
      issuerOrigin: 'https://bus.company.test',
      accessToken: 'stale-token',
      refreshToken: 'stale-refresh',
      tokenType: 'Bearer',
      scopes: [],
      expiresAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const secretStore = (
      service as never as { secretStore: { put(id: string, s: string): Promise<void> } }
    ).secretStore;
    await secretStore.put(connection.id, JSON.stringify(expiring));
    // 模拟已登录状态
    await (
      service as never as {
        updateRecord(
          id: string,
          updater: (c: Record<string, unknown>) => Record<string, unknown>
        ): Promise<unknown>;
      }
    ).updateRecord(connection.id, (c: Record<string, unknown>) => ({
      ...c,
      state: 'authenticated',
      account: { id: 'u-1' },
    }));

    const refreshed = await (
      service as never as { getValidSecret(record: unknown): Promise<unknown> }
    ).getValidSecret(record);

    // 网络级失败：本轮拿不到有效凭证，但 secret 保留、连接不被登出
    expect(refreshed).toBeNull();
    const current = await (
      service as never as {
        requireRecord(id: string): Promise<{ state: string; lastError?: { code: string } }>;
      }
    ).requireRecord(connection.id);
    expect(current.state).toBe('authenticated');
    expect(current.lastError?.code).toBe('auth_refresh_network');
    const stored = await (
      secretStore as never as { get(id: string): Promise<string | null> }
    ).get(connection.id);
    expect(stored).not.toBeNull();
  });

  it('creates the default AgentBus connection only once without blocking on discovery', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore: new MemorySecretStore(),
    });

    const first = await service.ensureDefaultConnection('https://agentbus.skg.com');
    const second = await service.ensureDefaultConnection('https://agentbus.skg.com/');

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ providerId: 'openhermit-agentbus', state: 'auth_required' });
    expect(await service.list()).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists the default connection even when the OS credential backend is unavailable', async () => {
    const unavailableStore: ConnectionSecretStore = {
      put: async () => Promise.reject(new Error('secret-tool unavailable')),
      get: async () => Promise.reject(new Error('secret-tool unavailable')),
      has: async () => Promise.reject(new Error('secret-tool unavailable')),
      delete: async () => Promise.reject(new Error('secret-tool unavailable')),
    };
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: compatibilityFetch(),
      secretStore: unavailableStore,
    });

    const connection = await service.ensureDefaultConnection('https://agentbus.skg.com');

    expect(connection).toMatchObject({ providerId: 'openhermit-agentbus', secretPresent: false });
    expect(await service.list()).toEqual([
      expect.objectContaining({ id: connection.id, secretPresent: false }),
    ]);
  });

  it('creates an AgentBus compatibility connection with read/aggregate permissions granted by default', async () => {
    const secretStore = new MemorySecretStore();
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: compatibilityFetch(),
      secretStore,
    });

    const connection = await service.create({ baseUrl: 'https://bus.company.test' });

    expect(connection.providerId).toBe('openhermit-agentbus');
    expect(connection.state).toBe('auth_required');
    expect(connection.secretPresent).toBe(false);
    // 默认授予只读/聚合类；写方向与敏感粒度默认关闭
    expect(connection.permissions['team.tasks.read']).toBe('granted');
    expect(connection.permissions['usage.aggregates']).toBe('granted');
    expect(connection.permissions['team.tasks.write']).toBe('denied');
    expect(connection.permissions['usage.project-metadata']).toBe('denied');
    expect(connection.permissions['usage.message-content']).toBe('denied');
    expect(connection.permissions['credentials.lark.export']).toBe('granted');
    expect(JSON.stringify(connection)).not.toContain('access_token');
    expect(JSON.stringify(connection)).not.toContain('refresh_token');
  });

  it('keeps device-flow secrets main-side and exposes only account/scopes after login', async () => {
    let postedUsage: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      await Promise.resolve();
      const url = requestUrl(input);
      if (url.endsWith('/.well-known/hermit-provider.json')) return jsonResponse({}, 404);
      if (url.endsWith('/api/v1/auth/start')) {
        return jsonResponse({
          flow_id: 'flow-1',
          poll_secret: 'poll-secret-1',
          authorization_url: 'https://login.company.test/authorize',
          expires_in: 600,
          interval: 1,
        });
      }
      if (url.includes('/api/v1/auth/poll?')) {
        return jsonResponse({
          access_token: 'secret-access-token',
          refresh_token: 'secret-refresh-token',
          token_type: 'Bearer',
          scopes: ['auth:user.id:read', 'upload:read', 'upload:write'],
          expires_in: 3600,
        });
      }
      if (url.endsWith('/api/v1/auth/me') && !new Headers(init?.headers).get('Authorization')) {
        return jsonResponse({}, 401);
      }
      if (url.endsWith('/api/v1/auth/me')) {
        return jsonResponse({
          status: 'ok',
          scopes: ['auth:user.id:read', 'upload:read', 'upload:write'],
          account: { id: 'u-1', display_name: '测试用户', tenant_name: '测试公司' },
        });
      }
      if (url.endsWith('/api/v1/report/usage')) {
        postedUsage = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ ok: true });
      }
      if (url.endsWith('/api/v1/token-distribution-v3/aliyun/discover')) {
        return jsonResponse({
          discovery_id: 'discovery-1',
          default_api_name: 'Claude Sonnet',
          default_model_api_ids: ['model-1'],
          api_key: 'must-not-cross-renderer-boundary',
          model_apis: [
            {
              model_api_id: 'model-1',
              api_name: 'Claude Sonnet',
              provider: 'anthropic',
              access_token: 'nested-secret',
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/token-distribution-v3/aliyun/auto-provision')) {
        return jsonResponse({ run_id: 'run-1' }, 202);
      }
      if (url.endsWith('/api/v1/token-distribution-v3/aliyun/provisioning-runs/run-1')) {
        return jsonResponse({ status: 'succeeded' });
      }
      if (url.endsWith('/api/v1/token-distribution-v3/aliyun/provisioning-runs/run-1/receipt')) {
        return jsonResponse({
          key: 'sk-secret-token-pool-value',
          key_id: 'key-1',
          endpoints: {
            anthropic: 'https://anthropic.company.test',
            openai: 'https://openai.company.test',
          },
          model_ids: ['claude-sonnet-4'],
          expires_at: '2027-01-01T00:00:00.000Z',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const secretStore = new MemorySecretStore();
    const runtimeCredentialApplier = vi.fn(async () => ({
      ok: true,
      runtimes: [
        { runtime: 'claude', ok: true, path: '/Users/test/.claude/settings.json' },
        { runtime: 'codex-auth', ok: true, path: '/Users/test/.codex/auth.json' },
        { runtime: 'codex-config', ok: true, path: '/Users/test/.codex/config.toml' },
        { runtime: 'pi', ok: true, path: '/Users/test/.pi/agent/models.json' },
      ],
    }));
    // CLI 版 tokenDistribution 注入桩（面板链路与 CLI 同一实现；region 由模块内置）
    const tokenDistribution = {
      discoverCatalog: vi.fn(async () => ({
        modelApis: [],
        defaultApiName: 'Claude Sonnet',
        defaultModelApiIds: ['model-1'],
        discoveryId: 'discovery-1',
        gatewayId: 'gw-1',
        regionId: 'cn-shenzhen',
        raw: {},
      })),
      selectModelApiIds: (ids?: string[]) => ids ?? [],
      provisionRun: vi.fn(async () => ({ runId: 'run-1', raw: {} })),
      pollRun: vi.fn(
        async (_runId: string, options?: { onTick?: (status: string) => void }) => {
          options?.onTick?.('running');
          return {};
        }
      ),
      claimSecret: vi.fn(async () => ({
        key: 'sk-secret-token-pool-value',
        keyId: 'key-1',
        endpoint: 'https://anthropic.company.test',
        endpoints: {
          anthropic: 'https://anthropic.company.test',
          openai: 'https://openai.company.test',
        },
        runtimeProfiles: {},
        modelsUrl: '',
        modelIds: ['glm-4.5-air', 'glm-5.2', 'glm-5.1'],
        expiresAt: '2027-01-01T00:00:00.000Z',
        raw: {},
      })),
      sortModelsByVersion,
      pickHighestVersionModel,
    };
    let service: AdvancedConnectionService;
    const onAuthenticated = vi.fn(async (connectionId: string) => {
      await service.syncAuthorizedData(connectionId, {
        generatedAt: '2026-01-01T00:00:00.000Z',
        teams: [],
        tasks: [],
        usage: {
          totalTokens: 42,
          projects: [{ workDir: '/Users/private/project', project: 'private-project' }],
          localUsers: [{ username: 'private-user' }],
        },
      });
    });
    service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore,
      runtimeHome: '/Users/test',
      runtimeCredentialApplier,
      tokenDistribution,
      onAuthenticated,
    });
    const connection = await service.ensureDefaultConnection('https://bus.company.test');

    const auth = await service.startAuthentication(connection.id, 'company-login');
    expect(auth.authorizationUrl).toBe('https://login.company.test/authorize');
    expect(JSON.stringify(auth)).not.toContain('poll-secret-1');

    let loggedIn = (await service.list())[0];
    for (let attempt = 0; attempt < 30 && loggedIn?.state !== 'connected'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      loggedIn = (await service.list())[0];
    }
    expect(loggedIn?.state).toBe('connected');
    expect(loggedIn?.account?.displayName).toBe('测试用户');
    expect(loggedIn?.secretPresent).toBe(true);
    expect(loggedIn?.permissions['usage.aggregates']).toBe('granted');
    expect(onAuthenticated).toHaveBeenCalledWith(connection.id);
    // 兼容模式：/report/usage 只读（405），聚合用量由消息上报通道自动汇总，不再 POST
    expect(postedUsage).toBeUndefined();
    expect(JSON.stringify(loggedIn)).not.toContain('secret-access-token');
    expect(JSON.stringify(loggedIn)).not.toContain('secret-refresh-token');

    expect(secretStore.values.get(connection.id)).toContain('secret-access-token');

    // 链式第一段：discover → provision → poll → claim → 挂起选模型（receipt 含授权清单）
    const stepEvents: { step: string; status: string; text?: string; error?: string }[] = [];
    const staged = await service.claimAndApplyToken(
      connection.id,
      { runtimes: ['claude', 'codex', 'pi'] },
      (event) => stepEvents.push(event)
    );
    expect(staged).toMatchObject({
      ok: true,
      stage: 'select-model',
      modelIds: ['glm-5.2', 'glm-5.1', 'glm-4.5-air'],
      recommendedModel: 'glm-5.2',
    });
    expect(JSON.stringify(staged)).not.toContain('sk-secret-token-pool-value');
    // 推荐项 = CLI 同款 pickHighestVersionModel（5.2 > 5.1 > 4.5-air）
    expect(pickHighestVersionModel(['glm-4.5-air', 'glm-5.2', 'glm-5.1'])).toBe('glm-5.2');
    expect(tokenDistribution.discoverCatalog).toHaveBeenCalledTimes(1);
    expect(tokenDistribution.provisionRun).toHaveBeenCalledWith({
      discoveryId: 'discovery-1',
      gatewayId: 'gw-1',
      aliyunModelApiIds: ['model-1'],
    });
    expect(tokenDistribution.pollRun).toHaveBeenCalledWith('run-1', expect.anything());
    expect(tokenDistribution.claimSecret).toHaveBeenCalledWith('run-1');
    // 挂起中防重入
    await expect(
      service.claimAndApplyToken(connection.id, { runtimes: ['claude'] })
    ).rejects.toThrow('正在执行');
    // 「读取目录」步骤无多余信息行（默认模型文案已删）
    expect(stepEvents.find((e) => e.step === 'discover' && e.status === 'done')?.text).toBeUndefined();

    // 第二段：确认所选模型 → 写入配置带 choices.model
    const applied = await service.confirmClaimModel(
      connection.id,
      { model: 'glm-5.1' },
      (event) => stepEvents.push(event)
    );
    expect(applied).toMatchObject({
      ok: true,
      keyId: 'key-1',
      model: 'glm-5.1',
      expiresAt: '2027-01-01T00:00:00.000Z',
      runtimes: [
        { runtime: 'claude', ok: true, path: 'settings.json' },
        { runtime: 'codex', ok: true, path: 'config.toml' },
        { runtime: 'pi', ok: true, path: 'models.json' },
      ],
    });
    expect(JSON.stringify(applied)).not.toContain('sk-secret-token-pool-value');
    // 明文 key 只经内存进 runtimeCredentialApplier，不落盘、不出现在返回体
    expect(runtimeCredentialApplier).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: expect.objectContaining({ key: 'sk-secret-token-pool-value' }),
        choices: expect.objectContaining({ model: 'glm-5.1' }),
        runtimes: ['claude', 'codex', 'pi'],
      })
    );
    // 步骤顺序与进度（六步全部 done，poll 有 progress）
    const doneSteps = stepEvents.filter((e) => e.status === 'done').map((e) => e.step);
    expect(doneSteps).toEqual(['discover', 'provision', 'poll', 'claim', 'select-model', 'apply']);
    expect(stepEvents.some((e) => e.step === 'poll' && e.status === 'progress')).toBe(true);
    // service 代码不再直接请求第二套 /aliyun/* 端点
    expect(
      fetchImpl.mock.calls.some(([input]) => requestUrl(input).includes('/aliyun/'))
    ).toBe(false);
  });

  it('keeps aggregate usage denied for a custom standard Provider after login', async () => {
    const reportUsage = vi.fn();
    const manifest = {
      schemaVersion: 1,
      provider: { id: 'standard-provider', displayName: '标准 Provider' },
      apiVersion: '2026-01-01',
      capabilities: [
        { id: 'identity', displayName: '用户授权' },
        { id: 'reporting', displayName: '数据上报' },
      ],
      authMethods: [{ id: 'device', type: 'device_code', displayName: '登录' }],
      endpoints: {
        authStart: '/api/auth/start',
        authPoll: '/api/auth/poll',
        authMe: '/api/auth/me',
        reportUsage: '/api/report-usage',
      },
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/.well-known/hermit-provider.json')) return jsonResponse(manifest);
      if (url.endsWith('/api/auth/start')) {
        return jsonResponse({
          flow_id: 'standard-flow',
          poll_secret: 'standard-poll-secret',
          authorization_url: 'https://login.provider.test/authorize',
          interval: 1,
        });
      }
      if (url.endsWith('/api/auth/poll')) {
        return jsonResponse({ access_token: 'standard-secret', token_type: 'Bearer' });
      }
      if (url.endsWith('/api/auth/me')) return jsonResponse({ account: { id: 'standard-user' } });
      if (url.endsWith('/api/report-usage')) {
        reportUsage();
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    let service: AdvancedConnectionService;
    const onAuthenticated = vi.fn(async (connectionId: string) => {
      await service.syncAuthorizedData(connectionId, {
        generatedAt: '2026-01-01T00:00:00.000Z',
        teams: [],
        tasks: [],
        usage: { totalTokens: 99 },
      });
    });
    service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore: new MemorySecretStore(),
      onAuthenticated,
    });
    const connection = await service.create({ baseUrl: 'https://provider.company.test' });

    await service.startAuthentication(connection.id, 'device');
    let loggedIn = (await service.list())[0];
    for (let attempt = 0; attempt < 30 && loggedIn?.state !== 'connected'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      loggedIn = (await service.list())[0];
    }

    expect(onAuthenticated).toHaveBeenCalledWith(connection.id);
    // 聚合用量默认开启：登录后立即上报一次
    expect(loggedIn?.permissions['usage.aggregates']).toBe('granted');
    expect(reportUsage).toHaveBeenCalled();
  });

  it('sends only locally authorized provider channels and previews remote tasks without executing them', async () => {
    const posted: { url: string; body?: Record<string, unknown> }[] = [];
    const manifest = {
      schemaVersion: 1,
      provider: { id: 'standard-provider', displayName: '标准 Provider' },
      apiVersion: '2026-01-01',
      capabilities: [
        { id: 'identity', displayName: '用户授权' },
        { id: 'team-bus', displayName: '团队总线' },
        { id: 'reporting', displayName: '数据上报' },
      ],
      authMethods: [],
      endpoints: {
        teamDirectory: '/api/team-directory',
        teamTasks: '/api/team-tasks',
        reportUsage: '/api/report-usage',
      },
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/.well-known/hermit-provider.json')) return jsonResponse(manifest);
      if (url.endsWith('/api/team-tasks') && !init?.method) {
        return jsonResponse({
          tasks: [{ id: 'remote-1', title: '远程任务', description: '待确认' }],
        });
      }
      posted.push({
        url,
        ...(typeof init?.body === 'string'
          ? { body: JSON.parse(init.body) as Record<string, unknown> }
          : {}),
      });
      return jsonResponse({ ok: true });
    });
    const secretStore = new MemorySecretStore();
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore,
    });
    const connection = await service.create({ baseUrl: 'https://provider.company.test' });
    secretStore.values.set(
      connection.id,
      JSON.stringify({
        schemaVersion: 1,
        connectionId: connection.id,
        providerId: 'standard-provider',
        issuerOrigin: 'https://provider.company.test',
        accessToken: 'secret-token',
        tokenType: 'Bearer',
        scopes: [],
        updatedAt: new Date().toISOString(),
      })
    );
    await service.updatePermissions(connection.id, {
      permissions: {
        'team.directory': 'granted',
        'team.tasks.read': 'granted',
        'usage.aggregates': 'granted',
      },
    });

    const synced = await service.syncAuthorizedData(connection.id, {
      generatedAt: '2026-01-01T00:00:00.000Z',
      teams: [{ slug: 'team-a', displayName: '团队 A', online: true }],
      tasks: [],
      usage: {
        totalTokens: 12,
        projects: [{ project: 'private-project', workDir: '/Users/private/project' }],
        localUsers: [{ username: 'private-user' }],
        unresolvedUsage: { sourcePath: '/Users/private/session.jsonl' },
      },
    });
    const pulled = await service.pullRemoteTasks(connection.id);

    expect(synced.sent.map((item) => item.channel)).toEqual(['team-directory', 'usage']);
    expect(synced.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'team-tasks', reason: '本地授权未开启' }),
      ])
    );
    expect(posted.map((entry) => entry.url)).toEqual(
      expect.arrayContaining([
        'https://provider.company.test/api/team-directory',
        'https://provider.company.test/api/report-usage',
      ])
    );
    const usagePost = posted.find((entry) => entry.url.endsWith('/api/report-usage'));
    expect(usagePost?.body).toEqual({
      schemaVersion: 1,
      source: 'agentcli',
      generatedAt: '2026-01-01T00:00:00.000Z',
      aggregates: { totalTokens: 12 },
    });
    expect(JSON.stringify(usagePost?.body)).not.toContain('/Users/private');
    expect(JSON.stringify(usagePost?.body)).not.toContain('private-project');
    expect(JSON.stringify(usagePost?.body)).not.toContain('private-user');
    expect(pulled.tasks).toEqual([
      { remoteId: 'remote-1', title: '远程任务', description: '待确认' },
    ]);
  });

  it('compat 模式同步：usage 一并跳过通用 Provider 载荷，不向 /report/usage POST', async () => {
    const posted: string[] = [];
    const baseFetch = compatibilityFetch();
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') posted.push(requestUrl(input));
      return baseFetch(input, init);
    });
    const secretStore = new MemorySecretStore();
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secretStore,
    });
    const connection = await service.create({ baseUrl: 'https://bus.company.test' });
    expect(connection.compatibilityMode).toBe(true);
    secretStore.values.set(
      connection.id,
      JSON.stringify({
        schemaVersion: 1,
        connectionId: connection.id,
        providerId: 'openhermit-agentbus',
        issuerOrigin: 'https://bus.company.test',
        accessToken: 'secret-token',
        tokenType: 'Bearer',
        scopes: [],
        updatedAt: new Date().toISOString(),
      })
    );
    await service.updatePermissions(connection.id, {
      permissions: {
        'team.directory': 'granted',
        'team.tasks.write': 'granted',
        'usage.aggregates': 'granted',
        'capabilities.inventory': 'granted',
      },
    });

    const synced = await service.syncAuthorizedData(connection.id, {
      generatedAt: '2026-01-01T00:00:00.000Z',
      teams: [],
      tasks: [],
      usage: { totalTokens: 42 },
    });

    expect(synced.sent).toEqual([]);
    // compat 下 usage 与其他通道一样不 POST：/report/usage 只读（405），聚合由消息上报通道汇总
    expect(synced.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'usage', reason: '聚合用量由消息上报通道自动汇总' }),
      ])
    );
    expect(posted.some((url) => url.endsWith('/api/v1/report/usage'))).toBe(false);
  });

  it('领取链式：provision 失败停在对应步骤并透出服务端原始错误，且防重入', async () => {
    const secretStore = new MemorySecretStore();
    let resolvePoll!: (value: unknown) => void;
    const tokenDistribution = {
      discoverCatalog: vi.fn(async () => ({
        modelApis: [],
        defaultApiName: null,
        defaultModelApiIds: ['model-1'],
        discoveryId: 'discovery-1',
        gatewayId: null,
        regionId: 'cn-shenzhen',
        raw: {},
      })),
      selectModelApiIds: (ids?: string[]) => ids ?? [],
      provisionRun: vi.fn(async () => ({ runId: 'run-1', raw: {} })),
      pollRun: vi.fn(
        () =>
          new Promise((resolve) => {
            resolvePoll = resolve;
          })
      ),
      claimSecret: vi.fn(),
      sortModelsByVersion,
      pickHighestVersionModel,
    };
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: compatibilityFetch(),
      secretStore,
      tokenDistribution,
    });
    const connection = await service.create({ baseUrl: 'https://bus.company.test' });
    secretStore.values.set(
      connection.id,
      JSON.stringify({
        schemaVersion: 1,
        connectionId: connection.id,
        providerId: 'openhermit-agentbus',
        issuerOrigin: 'https://bus.company.test',
        accessToken: 'secret-token',
        tokenType: 'Bearer',
        scopes: [],
        updatedAt: new Date().toISOString(),
      })
    );

    // 防重入：第一次停在 poll（不 resolve），第二次直接拒绝
    const stepEvents: { step: string; status: string; error?: string }[] = [];
    const first = service.claimAndApplyToken(
      connection.id,
      { runtimes: ['claude'] },
      (event) => stepEvents.push(event)
    );
    await vi.waitFor(() => {
      expect(stepEvents.some((e) => e.step === 'poll' && e.status === 'start')).toBe(true);
    });
    await expect(
      service.claimAndApplyToken(connection.id, { runtimes: ['claude'] })
    ).rejects.toThrow('正在执行');

    // poll 失败：错误透出服务端原文（error_code: error_message），步骤停在 poll
    resolvePoll(Promise.reject(new Error('provisioning failed: aliyun_model_api_not_found: 未找到固定生产消费者组 agent-bus')));
    await expect(first).rejects.toThrow(
      'Token 池认领失败：provisioning failed: aliyun_model_api_not_found: 未找到固定生产消费者组 agent-bus'
    );
    const errorEvents = stepEvents.filter((e) => e.status === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.step).toBe('poll');
    expect(errorEvents[0]?.error).toContain('未找到固定生产消费者组 agent-bus');
    expect(tokenDistribution.claimSecret).not.toHaveBeenCalled();

    // 失败后锁已释放，可再次发起
    tokenDistribution.provisionRun.mockRejectedValueOnce(
      new Error('422 Unprocessable Entity: {"detail":{"message":"未找到固定生产消费者组 agent-bus"}}')
    );
    const secondEvents: { step: string; status: string; error?: string }[] = [];
    await expect(
      service.claimAndApplyToken(connection.id, { runtimes: ['claude'] }, (event) =>
        secondEvents.push(event)
      )
    ).rejects.toThrow('Token 池认领启动失败：422 Unprocessable Entity');
    const provisionError = secondEvents.find((e) => e.status === 'error');
    expect(provisionError?.step).toBe('provision');
    expect(provisionError?.error).toContain('未找到固定生产消费者组 agent-bus');
  });

  it('出站调用写入服务日志（status/duration/无 token 无 query）', async () => {
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: compatibilityFetch(),
      secretStore: new MemorySecretStore(),
    });
    await service.create({ baseUrl: 'https://bus.company.test' });

    const raw = await readFile(
      path.join(hermitHome, 'logs', 'agentbus-http.log'),
      'utf8'
    );
    const entries = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(0);
    const probe = entries.find((entry) => String(entry.url).includes('/api/v1/auth/start'))!;
    expect(probe).toBeDefined();
    expect(probe.method).toBe('POST');
    expect(probe.status).toBe(200);
    expect(typeof probe.durationMs).toBe('number');
    expect(String(probe.url)).not.toContain('?');
    // 日志中不出现任何 token/secret 形态
    expect(raw).not.toContain('Authorization');
    expect(raw).not.toContain('secret-token');
  });

  it('provision 传同一次 discover 的 defaultModelApiIds（服务端精选集）', async () => {
    const secretStore = new MemorySecretStore();
    const tokenDistribution = {
      discoverCatalog: vi.fn(async () => ({
        modelApis: [],
        defaultApiName: 'Claude Sonnet',
        defaultModelApiIds: ['cpamc-cc', 'cpamc-openai'],
        discoveryId: 'discovery-1',
        gatewayId: 'gw-1',
        regionId: 'cn-shenzhen',
        raw: {},
      })),
      selectModelApiIds: (ids?: string[]) => ids ?? [],
      provisionRun: vi.fn(async () => ({ runId: 'run-1', raw: {} })),
      pollRun: vi.fn(async () => ({})),
      claimSecret: vi.fn(async () => ({
        key: 'sk-once',
        keyId: 'key-1',
        endpoint: 'https://gw/cpamc-cc',
        endpoints: {},
        runtimeProfiles: {},
        modelsUrl: '',
        modelIds: [],
        expiresAt: null,
        raw: {},
      })),
      sortModelsByVersion,
      pickHighestVersionModel,
    };
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: compatibilityFetch(),
      secretStore,
      runtimeCredentialApplier: vi.fn(async () => ({
        ok: true,
        runtimes: [{ runtime: 'claude', ok: true, path: '/Users/test/.claude/settings.json' }],
      })),
      tokenDistribution,
    });
    const connection = await service.create({ baseUrl: 'https://bus.company.test' });
    secretStore.values.set(
      connection.id,
      JSON.stringify({
        schemaVersion: 1,
        connectionId: connection.id,
        providerId: 'openhermit-agentbus',
        issuerOrigin: 'https://bus.company.test',
        accessToken: 'secret-token',
        tokenType: 'Bearer',
        scopes: [],
        updatedAt: new Date().toISOString(),
      })
    );

    const applied = await service.claimAndApplyToken(connection.id, { runtimes: ['claude'] });
    expect(applied.ok).toBe(true);
    expect(tokenDistribution.provisionRun).toHaveBeenCalledWith({
      discoveryId: 'discovery-1',
      gatewayId: 'gw-1',
      aliyunModelApiIds: ['cpamc-cc', 'cpamc-openai'],
    });
  });

  it('discovery 过期（aliyun_discovery_stale）自动重新 discover 并重试一次；再失败照常透出', async () => {
    const secretStore = new MemorySecretStore();
    const makeCatalog = (discoveryId: string) => ({
      modelApis: [],
      defaultApiName: 'Claude Sonnet',
      defaultModelApiIds: ['cpamc-cc'],
      discoveryId,
      gatewayId: 'gw-1',
      regionId: 'cn-shenzhen',
      raw: {},
    });
    const tokenDistribution = {
      discoverCatalog: vi
        .fn()
        .mockImplementationOnce(async () => makeCatalog('discovery-stale'))
        .mockImplementation(async () => makeCatalog('discovery-fresh')),
      selectModelApiIds: (ids?: string[]) => ids ?? [],
      provisionRun: vi
        .fn()
        .mockImplementationOnce(async () => {
          throw new Error(
            '410 Gone: {"error_code":"aliyun_discovery_stale","error_message":"discovery expired"}'
          );
        })
        .mockImplementation(async () => ({ runId: 'run-1', raw: {} })),
      pollRun: vi.fn(async () => ({})),
      claimSecret: vi.fn(async () => ({
        key: 'sk-once',
        keyId: 'key-1',
        endpoint: 'https://gw/cpamc-cc',
        endpoints: {},
        runtimeProfiles: {},
        modelsUrl: '',
        modelIds: [],
        expiresAt: null,
        raw: {},
      })),
      sortModelsByVersion,
      pickHighestVersionModel,
    };
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: compatibilityFetch(),
      secretStore,
      runtimeCredentialApplier: vi.fn(async () => ({
        ok: true,
        runtimes: [{ runtime: 'claude', ok: true, path: '/Users/test/.claude/settings.json' }],
      })),
      tokenDistribution,
    });
    const connection = await service.create({ baseUrl: 'https://bus.company.test' });
    secretStore.values.set(
      connection.id,
      JSON.stringify({
        schemaVersion: 1,
        connectionId: connection.id,
        providerId: 'openhermit-agentbus',
        issuerOrigin: 'https://bus.company.test',
        accessToken: 'secret-token',
        tokenType: 'Bearer',
        scopes: [],
        updatedAt: new Date().toISOString(),
      })
    );

    // 第一次 stale → 自动重 discover（第 2 次）→ 用新 discoveryId 重试成功
    const stepEvents: { step: string; status: string; text?: string }[] = [];
    const applied = await service.claimAndApplyToken(connection.id, { runtimes: ['claude'] }, (e) =>
      stepEvents.push(e)
    );
    expect(applied.ok).toBe(true);
    expect(tokenDistribution.discoverCatalog).toHaveBeenCalledTimes(2);
    expect(tokenDistribution.provisionRun).toHaveBeenCalledTimes(2);
    expect(tokenDistribution.provisionRun).toHaveBeenNthCalledWith(2, {
      discoveryId: 'discovery-fresh',
      gatewayId: 'gw-1',
      aliyunModelApiIds: ['cpamc-cc'],
    });
    expect(
      stepEvents.some((e) => e.step === 'provision' && e.status === 'progress')
    ).toBe(true);

    // 连续 stale（重试也失败）→ 透出错误，不再第三次尝试
    tokenDistribution.discoverCatalog.mockClear();
    tokenDistribution.provisionRun.mockClear();
    tokenDistribution.provisionRun.mockImplementation(async () => {
      throw new Error('410 Gone: {"error_code":"aliyun_discovery_stale"}');
    });
    await expect(
      service.claimAndApplyToken(connection.id, { runtimes: ['claude'] })
    ).rejects.toThrow('Token 池认领启动失败');
    expect(tokenDistribution.discoverCatalog).toHaveBeenCalledTimes(2);
    expect(tokenDistribution.provisionRun).toHaveBeenCalledTimes(2);
  });

  it('授权面探测：auth/start 404 或响应缺字段均不判定为兼容服务', async () => {
    // 404：端点不存在 → 非兼容
    const notFoundService = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: vi.fn(async () => jsonResponse({}, 404)) as unknown as typeof fetch,
      secretStore: new MemorySecretStore(),
    });
    await expect(notFoundService.discover('https://unknown.example.com')).rejects.toThrow(
      '不是可识别的 AgentBus 服务'
    );

    // 200 但缺 device_code 契约字段 → 非兼容
    const noFieldsService = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith('/api/v1/auth/start')
          ? jsonResponse({ ok: true })
          : jsonResponse({}, 404)
      ) as unknown as typeof fetch,
      secretStore: new MemorySecretStore(),
    });
    await expect(noFieldsService.discover('https://odd.example.com')).rejects.toThrow(
      '不是可识别的 AgentBus 服务'
    );

    // 4xx（非 404，端点存在）→ 判定兼容
    const deniedService = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith('/api/v1/auth/start')
          ? jsonResponse({}, 401)
          : jsonResponse({}, 404)
      ) as unknown as typeof fetch,
      secretStore: new MemorySecretStore(),
    });
    const discovered = await deniedService.discover('https://bus.company.test');
    expect(discovered.compatibilityMode).toBe(true);
  });

  it('取消领取：丢弃已领 key 不写配置，随后可重新发起', async () => {
    const secretStore = new MemorySecretStore();
    const runtimeCredentialApplier = vi.fn(async () => ({
      ok: true,
      runtimes: [{ runtime: 'claude', ok: true, path: '/Users/test/.claude/settings.json' }],
    }));
    const tokenDistribution = {
      discoverCatalog: vi.fn(async () => ({
        modelApis: [],
        defaultApiName: null,
        defaultModelApiIds: ['model-1'],
        discoveryId: 'discovery-1',
        gatewayId: null,
        regionId: 'cn-shenzhen',
        raw: {},
      })),
      selectModelApiIds: (ids?: string[]) => ids ?? [],
      provisionRun: vi.fn(async () => ({ runId: 'run-1', raw: {} })),
      pollRun: vi.fn(async () => ({})),
      claimSecret: vi.fn(async () => ({
        key: 'sk-pending-burn',
        keyId: 'key-1',
        endpoint: '',
        endpoints: {},
        runtimeProfiles: {},
        modelsUrl: '',
        modelIds: ['glm-5.2', 'glm-5.1'],
        expiresAt: null,
        raw: {},
      })),
      sortModelsByVersion,
      pickHighestVersionModel,
    };
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: compatibilityFetch(),
      secretStore,
      runtimeCredentialApplier,
      tokenDistribution,
    });
    const connection = await service.create({ baseUrl: 'https://bus.company.test' });
    secretStore.values.set(
      connection.id,
      JSON.stringify({
        schemaVersion: 1,
        connectionId: connection.id,
        providerId: 'openhermit-agentbus',
        issuerOrigin: 'https://bus.company.test',
        accessToken: 'secret-token',
        tokenType: 'Bearer',
        scopes: [],
        updatedAt: new Date().toISOString(),
      })
    );

    const staged = await service.claimAndApplyToken(connection.id, { runtimes: ['claude'] });
    expect(staged).toMatchObject({ stage: 'select-model', recommendedModel: 'glm-5.2' });

    await service.cancelTokenClaim(connection.id);
    // 不写配置、key 不落盘
    expect(runtimeCredentialApplier).not.toHaveBeenCalled();
    const indexRaw = await readFile(
      path.join(hermitHome, 'connections', 'index.json'),
      'utf8'
    );
    expect(indexRaw).not.toContain('sk-pending-burn');
    // 取消后锁已释放，可重新发起
    const restaged = await service.claimAndApplyToken(connection.id, { runtimes: ['claude'] });
    expect(restaged).toMatchObject({ stage: 'select-model' });
    await service.cancelTokenClaim(connection.id);
  });

  it('uses the file-based secret store end to end (secretPresent 与授权状态一致)', async () => {
    const { SystemCredentialSecretStore } = await import(
      '@features/advanced-connections/main/infrastructure/SystemCredentialSecretStore'
    );
    const secretStore = new SystemCredentialSecretStore(
      path.join(hermitHome, 'connections', 'secrets')
    );
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: compatibilityFetch(),
      secretStore,
    });
    const connection = await service.create({ baseUrl: 'https://bus.company.test' });

    // 默认文件后端：hermitHome/connections/secrets
    expect((await service.list())[0]?.secretPresent).toBe(false);
    await secretStore.put(
      connection.id,
      JSON.stringify({ accessToken: 'token', tokenType: 'Bearer', scopes: [] })
    );
    expect((await service.list())[0]?.secretPresent).toBe(true);
    await secretStore.delete(connection.id);
    expect((await service.list())[0]?.secretPresent).toBe(false);
  });

  it('persists only an explicit permission grant', async () => {
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: compatibilityFetch(),
      secretStore: new MemorySecretStore(),
    });
    const connection = await service.create({ baseUrl: 'https://bus.company.test' });

    const updated = await service.updatePermissions(connection.id, {
      permissions: { 'usage.aggregates': 'granted' },
    });

    expect(updated.permissions['usage.aggregates']).toBe('granted');
    expect(updated.permissions['usage.message-content']).toBe('denied');
    expect(updated.permissions['credentials.lark.export']).toBe('granted');
  });
});
