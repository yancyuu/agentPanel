import {
  defaultPermissionDecisions,
  mergePermissionDecisions,
  parseProviderManifest,
} from '@features/advanced-connections/core/domain/providerManifest';
import { describe, expect, it } from 'vitest';

describe('advanced connection provider manifest', () => {
  it('parses a provider-neutral manifest with same-origin relative endpoints', () => {
    const manifest = parseProviderManifest({
      schemaVersion: 1,
      provider: { id: 'company-bus', displayName: '公司团队服务' },
      apiVersion: '2026-01-01',
      capabilities: [
        { id: 'identity', displayName: '用户授权' },
        { id: 'reporting', displayName: '数据上报' },
      ],
      authMethods: [
        {
          id: 'company-login',
          type: 'device_code',
          displayName: '公司账号登录',
          requestedScopes: ['identity:read'],
        },
      ],
      endpoints: {
        authStart: '/api/auth/start',
        authPoll: '/api/auth/poll',
        reportUsage: '/api/report/usage',
      },
    });

    expect(manifest.provider.id).toBe('company-bus');
    expect(manifest.capabilities.map((item) => item.id)).toEqual(['identity', 'reporting']);
    expect(manifest.endpoints.authStart).toBe('/api/auth/start');
  });

  it('rejects absolute or protocol-relative endpoint declarations', () => {
    const base = {
      schemaVersion: 1,
      provider: { id: 'bad-provider', displayName: 'Bad Provider' },
      apiVersion: '1',
      capabilities: [],
      authMethods: [],
    };
    expect(() => parseProviderManifest({ ...base, endpoints: { authStart: 'https://evil.test' } })).toThrow(
      '同源相对路径'
    );
    expect(() => parseProviderManifest({ ...base, endpoints: { authStart: '//evil.test/path' } })).toThrow(
      '同源相对路径'
    );
  });

  it('defaults every local data permission to denied and only applies explicit decisions', () => {
    const defaults = defaultPermissionDecisions();
    expect(Object.values(defaults).every((decision) => decision === 'denied')).toBe(true);

    const updated = mergePermissionDecisions(defaults, {
      'usage.aggregates': 'granted',
      'usage.message-content': 'denied',
    });
    expect(updated['usage.aggregates']).toBe('granted');
    expect(updated['usage.message-content']).toBe('denied');
    expect(updated['credentials.lark.export']).toBe('denied');
  });
});
