import { AdvancedConnectionsSection } from '@features/advanced-connections/renderer/ui/AdvancedConnectionsSection';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AdvancedConnectionSummary } from '@features/advanced-connections/contracts';

const connection: AdvancedConnectionSummary = {
  id: 'connection_1234567890abcdef',
  label: '公司 AgentBus',
  baseUrl: 'https://bus.company.test',
  secure: true,
  providerId: 'company-bus',
  providerName: '公司团队服务',
  state: 'authenticated',
  account: { displayName: '测试用户' },
  grantedScopes: ['identity:read'],
  capabilities: [
    { id: 'identity', displayName: '用户授权' },
    { id: 'team-bus', displayName: '团队总线' },
    { id: 'reporting', displayName: '数据上报' },
    { id: 'token-pool', displayName: 'Token 池' },
  ],
  authMethods: [
    {
      id: 'company-login',
      type: 'device_code',
      displayName: '公司账号登录',
      requestedScopes: ['identity:read'],
    },
  ],
  permissions: {
    'team.presence': 'denied',
    'team.directory': 'denied',
    'team.tasks.read': 'denied',
    'team.tasks.write': 'denied',
    'usage.aggregates': 'granted',
    'usage.project-metadata': 'denied',
    'usage.message-metadata': 'denied',
    'usage.message-content': 'denied',
    'capabilities.inventory': 'denied',
    'credentials.lark.export': 'denied',
  },
  secretPresent: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const noop = vi.fn();

describe('AdvancedConnectionsSection', () => {
  it('shows provider capabilities and precise data permissions without exposing raw credential export', () => {
    const html = renderToStaticMarkup(
      <AdvancedConnectionsSection
        connections={[connection]}
        host=""
        preview={null}
        loading={false}
        busyAction={null}
        error={null}
        notice={null}
        catalogStatus={{}}
        catalogs={{
          [connection.id]: {
            modelCount: 1,
            discoveryId: 'discovery-1',
            defaultModelName: 'Claude Sonnet',
            defaultModelApiIds: ['model-1'],
            models: [{ id: 'model-1', name: 'Claude Sonnet' }],
          },
        }}
        channelStatus={{}}
        onHostChange={noop}
        onDiscover={noop}
        onAddConnection={noop}
        onRemoveConnection={noop}
        onStartAuth={noop}
        onLogout={noop}
        onPermissionChange={noop}
        onSyncConnection={noop}
        onPullRemoteTasks={noop}
        onCheckTokenCatalog={noop}
        onClaimAndApplyToken={noop}
        onRefresh={noop}
      />
    );

    expect(html).toContain('开放连接');
    expect(html).toContain('系统如何判定兼容服务');
    expect(html).toContain('/.well-known/hermit-provider.json');
    expect(html).toContain('/api/v1/auth/me');
    expect(html).toContain('返回 404、网页内容或无法解析的 JSON');
    expect(html).toContain('返回 401 或 403');
    expect(html).toContain('暂不受支持');
    expect(html).toContain('公司 AgentBus');
    expect(html).toContain('当前账号：测试用户');
    expect(html).toContain('Usage 汇总');
    expect(html).toContain('消息正文');
    expect(html).not.toContain('飞书凭证委托');
    expect(html).toContain('同步已授权数据');
    expect(html).toContain('检查远程任务');
    expect(html).toContain('检测 Token 池');
    expect(html).toContain('领取并应用');
    expect(html).toContain('默认模型：Claude Sonnet');
  });
});
