// AgentBus 兼容服务的静态 manifest（shared .mjs：TS 与 bin/lib 双侧同源引用）。
// 原先内嵌在 AdvancedConnectionService；登录态桥接在 CLI 侧创建默认连接记录时也需要它。

export const AGENTBUS_PROVIDER_ID = 'openhermit-agentbus';

export function agentbusCompatibilityManifest() {
  return {
    schemaVersion: 1,
    provider: {
      id: AGENTBUS_PROVIDER_ID,
      displayName: 'AgentBus 兼容服务',
      description: '兼容当前 AgentBus 用户授权、用量上报与 Token 池接口。',
    },
    apiVersion: 'compat-v1',
    capabilities: [
      { id: 'identity', displayName: '内部用户授权' },
      { id: 'team-bus', displayName: '团队总线' },
      { id: 'reporting', displayName: '数据上报' },
      { id: 'token-pool', displayName: 'Token 池' },
    ],
    authMethods: [
      {
        id: 'company-login',
        type: 'device_code',
        displayName: '公司账号登录',
        requestedScopes: ['auth:user.id:read', 'upload:read', 'upload:write'],
      },
    ],
    endpoints: {
      authStart: '/api/v1/auth/start',
      authPoll: '/api/v1/auth/poll',
      authRefresh: '/api/v1/auth/refresh',
      authMe: '/api/v1/auth/me',
      authLogout: '/api/v1/auth/logout',
      reportUsage: '/api/v1/report/usage',
      reportMessages: '/api/v1/report/messages',
      tokenCatalog: '/api/v1/token-distribution-v3/aliyun/discover',
      tokenProvision: '/api/v1/token-distribution-v3/aliyun/auto-provision',
      tokenOperation: '/api/v1/token-distribution-v3/aliyun/provisioning-runs/{operationId}',
      tokenClaim: '/api/v1/token-distribution-v3/aliyun/provisioning-runs/{operationId}/receipt',
    },
  };
}
