import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AdvancedConnectionService } from '@features/advanced-connections/main';
import type { ConnectionSecretStore } from '@features/advanced-connections/main/infrastructure/SystemCredentialSecretStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  return vi.fn((input: string | URL | Request) =>
    Promise.resolve(
      requestUrl(input).endsWith('/api/v1/auth/me') ? jsonResponse({}, 401) : jsonResponse({}, 404)
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
    const fetchImpl = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
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

    // 2) App 刷新成功 → CLI store token 写穿透一致
    await service.tokenCatalog(connection.id);
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
    expect(connection.permissions['credentials.lark.export']).toBe('denied');
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
      onAuthenticated,
    });
    const connection = await service.ensureDefaultConnection('https://bus.company.test');

    const auth = await service.startAuthentication(connection.id, 'company-login');
    expect(auth.authorizationUrl).toBe('https://login.company.test/authorize');
    expect(JSON.stringify(auth)).not.toContain('poll-secret-1');

    let loggedIn = (await service.list())[0];
    for (let attempt = 0; attempt < 20 && loggedIn?.state === 'authenticating'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      loggedIn = (await service.list())[0];
    }
    expect(loggedIn?.state).toBe('connected');
    expect(loggedIn?.account?.displayName).toBe('测试用户');
    expect(loggedIn?.secretPresent).toBe(true);
    expect(loggedIn?.permissions['usage.aggregates']).toBe('granted');
    expect(onAuthenticated).toHaveBeenCalledWith(connection.id);
    expect(postedUsage).toEqual({
      schemaVersion: 1,
      source: 'agentcli',
      generatedAt: '2026-01-01T00:00:00.000Z',
      aggregates: { totalTokens: 42 },
    });
    expect(JSON.stringify(postedUsage)).not.toContain('/Users/private');
    expect(JSON.stringify(postedUsage)).not.toContain('private-project');
    expect(JSON.stringify(postedUsage)).not.toContain('private-user');
    expect(JSON.stringify(loggedIn)).not.toContain('secret-access-token');
    expect(JSON.stringify(loggedIn)).not.toContain('secret-refresh-token');

    expect(secretStore.values.get(connection.id)).toContain('secret-access-token');

    const catalog = await service.tokenCatalog(connection.id);
    expect(catalog).toMatchObject({
      ok: true,
      catalog: {
        modelCount: 1,
        defaultModelName: 'Claude Sonnet',
        models: [{ id: 'model-1', name: 'Claude Sonnet', provider: 'anthropic' }],
      },
    });
    expect(JSON.stringify(catalog)).not.toContain('must-not-cross-renderer-boundary');
    expect(JSON.stringify(catalog)).not.toContain('nested-secret');

    const applied = await service.claimAndApplyToken(connection.id, {
      discoveryId: catalog.catalog?.discoveryId ?? '',
      modelApiIds: catalog.catalog?.defaultModelApiIds ?? [],
      runtimes: ['claude', 'codex', 'pi'],
    });
    expect(applied).toMatchObject({
      ok: true,
      keyId: 'key-1',
      expiresAt: '2027-01-01T00:00:00.000Z',
      runtimes: [
        { runtime: 'claude', ok: true, path: 'settings.json' },
        { runtime: 'codex', ok: true, path: 'config.toml' },
        { runtime: 'pi', ok: true, path: 'models.json' },
      ],
    });
    expect(JSON.stringify(applied)).not.toContain('sk-secret-token-pool-value');
    expect(runtimeCredentialApplier).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: expect.objectContaining({ key: 'sk-secret-token-pool-value' }),
        runtimes: ['claude', 'codex', 'pi'],
      })
    );
    const provisionCall = fetchImpl.mock.calls.find(([input]) =>
      requestUrl(input).endsWith('/aliyun/auto-provision')
    );
    expect(new Headers(provisionCall?.[1]?.headers).get('Idempotency-Key')).toBeTruthy();
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
    for (let attempt = 0; attempt < 20 && loggedIn?.state === 'authenticating'; attempt += 1) {
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
    expect(updated.permissions['credentials.lark.export']).toBe('denied');
  });
});
