import { mkdtemp, rm } from 'node:fs/promises';
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
      requestUrl(input).endsWith('/api/v1/auth/me')
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

  it('creates an AgentBus compatibility connection with every permission denied', async () => {
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
    expect(Object.values(connection.permissions).every((decision) => decision === 'denied')).toBe(true);
    expect(JSON.stringify(connection)).not.toContain('access_token');
    expect(JSON.stringify(connection)).not.toContain('refresh_token');
  });

  it('keeps device-flow secrets main-side and exposes only account/scopes after login', async () => {
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
      if (url.endsWith('/api/v1/token-distribution-v3/aliyun/discover')) {
        return jsonResponse({
          default_api_name: 'Claude Sonnet',
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
      throw new Error(`unexpected fetch ${url}`);
    });
    const secretStore = new MemorySecretStore();
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: fetchImpl as typeof fetch,
      secretStore,
    });
    const connection = await service.create({ baseUrl: 'https://bus.company.test' });

    const auth = await service.startAuthentication(connection.id, 'company-login');
    expect(auth.authorizationUrl).toBe('https://login.company.test/authorize');
    expect(JSON.stringify(auth)).not.toContain('poll-secret-1');

    let loggedIn = (await service.list())[0];
    for (let attempt = 0; attempt < 20 && loggedIn?.state === 'authenticating'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      loggedIn = (await service.list())[0];
    }
    expect(loggedIn?.state).toBe('authenticated');
    expect(loggedIn?.account?.displayName).toBe('测试用户');
    expect(loggedIn?.secretPresent).toBe(true);
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
  });

  it('sends only locally authorized provider channels and previews remote tasks without executing them', async () => {
    const posted: string[] = [];
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
        return jsonResponse({ tasks: [{ id: 'remote-1', title: '远程任务', description: '待确认' }] });
      }
      posted.push(url);
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
      usage: { totalTokens: 12 },
    });
    const pulled = await service.pullRemoteTasks(connection.id);

    expect(synced.sent.map((item) => item.channel)).toEqual(['team-directory', 'usage']);
    expect(synced.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'team-tasks', reason: '本地授权未开启' }),
      ])
    );
    expect(posted).toEqual(
      expect.arrayContaining([
        'https://provider.company.test/api/team-directory',
        'https://provider.company.test/api/report-usage',
      ])
    );
    expect(pulled.tasks).toEqual([
      { remoteId: 'remote-1', title: '远程任务', description: '待确认' },
    ]);
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
