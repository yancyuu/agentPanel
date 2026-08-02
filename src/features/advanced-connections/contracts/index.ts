export const ADVANCED_CONNECTIONS_API_BASE = '/api/advanced-connections' as const;

export type ConnectionCapabilityId = 'identity' | 'team-bus' | 'reporting' | 'token-pool';

export type DataPermissionId =
  | 'team.presence'
  | 'team.directory'
  | 'team.tasks.read'
  | 'team.tasks.write'
  | 'usage.aggregates'
  | 'usage.project-metadata'
  | 'usage.message-metadata'
  | 'usage.message-content'
  | 'capabilities.inventory'
  | 'credentials.lark.export';

export type PermissionDecision = 'granted' | 'denied';

export type AdvancedConnectionState =
  | 'discovered'
  | 'auth_required'
  | 'authenticating'
  | 'authenticated'
  | 'ready'
  | 'connected'
  | 'degraded'
  | 'error';

export interface ProviderCapabilityDeclaration {
  id: ConnectionCapabilityId;
  displayName: string;
  description?: string;
}

export interface ProviderDeviceCodeAuthMethod {
  id: string;
  type: 'device_code';
  displayName: string;
  requestedScopes: string[];
}

export interface ProviderOauthPkceAuthMethod {
  id: string;
  type: 'oauth_pkce';
  displayName: string;
  requestedScopes: string[];
}

export type ProviderAuthMethod = ProviderDeviceCodeAuthMethod | ProviderOauthPkceAuthMethod;

export interface ProviderEndpointMap {
  authStart?: string;
  authPoll?: string;
  authRefresh?: string;
  authMe?: string;
  authLogout?: string;
  teamConnect?: string;
  teamDirectory?: string;
  teamTasks?: string;
  reportUsage?: string;
  reportMessages?: string;
  reportCapabilities?: string;
  tokenCatalog?: string;
  tokenProvision?: string;
  tokenOperation?: string;
  tokenClaim?: string;
}

export interface ProviderManifestV1 {
  schemaVersion: 1;
  provider: {
    id: string;
    displayName: string;
    description?: string;
  };
  apiVersion: string;
  capabilities: ProviderCapabilityDeclaration[];
  authMethods: ProviderAuthMethod[];
  endpoints: ProviderEndpointMap;
}

export interface AdvancedConnectionAccountSummary {
  id?: string;
  displayName?: string;
  email?: string;
  tenantName?: string;
}

export interface AdvancedConnectionErrorSummary {
  code: string;
  message: string;
  at: string;
}

export interface AdvancedConnectionSummary {
  id: string;
  label: string;
  baseUrl: string;
  secure: boolean;
  /** 用户已确认接受该 HTTP 连接的传输风险（仅对非加密连接有意义） */
  insecureAllowed?: boolean;
  providerId: string;
  providerName: string;
  providerDescription?: string;
  state: AdvancedConnectionState;
  account?: AdvancedConnectionAccountSummary;
  grantedScopes: string[];
  capabilities: ProviderCapabilityDeclaration[];
  authMethods: ProviderAuthMethod[];
  permissions: Record<DataPermissionId, PermissionDecision>;
  secretPresent: boolean;
  lastError?: AdvancedConnectionErrorSummary;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoverAdvancedConnectionRequest {
  baseUrl: string;
}

export interface DiscoverAdvancedConnectionResponse {
  baseUrl: string;
  secure: boolean;
  compatibilityMode: boolean;
  manifest: ProviderManifestV1;
}

export interface CreateAdvancedConnectionRequest {
  baseUrl: string;
  label?: string;
}

export interface UpdateAdvancedConnectionPermissionsRequest {
  permissions: Partial<Record<DataPermissionId, PermissionDecision>>;
  highRiskAcknowledged?: boolean;
}

export interface StartAdvancedConnectionAuthRequest {
  methodId: string;
}

export interface StartAdvancedConnectionAuthResponse {
  attemptId: string;
  authorizationUrl: string;
  userCode?: string;
  expiresAt: string;
  pollAfterMs: number;
}

export interface AdvancedConnectionTokenCatalogItem {
  id: string;
  name: string;
  provider?: string;
}

export interface AdvancedConnectionTokenCatalogSummary {
  modelCount: number;
  discoveryId?: string;
  regionId?: string;
  gatewayId?: string;
  defaultModelName?: string;
  defaultModelApiIds: string[];
  models: AdvancedConnectionTokenCatalogItem[];
}

export interface AdvancedConnectionTokenCatalogResponse {
  ok: boolean;
  available: boolean;
  catalog?: AdvancedConnectionTokenCatalogSummary;
  error?: string;
}

export type AdvancedConnectionRuntimeId = 'claude' | 'codex' | 'pi';

export interface AdvancedConnectionTokenClaimRequest {
  discoveryId: string;
  regionId?: string;
  gatewayId?: string;
  modelApiIds: string[];
  runtimes: AdvancedConnectionRuntimeId[];
  model?: string;
  wireApi?: 'responses' | 'chat';
}

export interface AdvancedConnectionRuntimeApplyResult {
  runtime: AdvancedConnectionRuntimeId;
  ok: boolean;
  path?: string;
  error?: string;
}

export interface AdvancedConnectionTokenClaimResult {
  ok: true;
  keyId?: string;
  maskedKey: string;
  expiresAt?: string;
  model?: string;
  runtimes: AdvancedConnectionRuntimeApplyResult[];
  appliedAt: string;
  warnings: string[];
}

export interface AdvancedConnectionLocalSnapshot {
  generatedAt: string;
  teams: {
    slug: string;
    displayName: string;
    description?: string;
    harness?: string;
    online: boolean;
  }[];
  tasks: {
    id: string;
    teamSlug: string;
    title: string;
    status: string;
    updatedAt: string;
  }[];
  usage?: Record<string, unknown>;
  capabilities?: { id: string; name: string; description?: string }[];
}

export interface AdvancedConnectionSyncResult {
  ok: boolean;
  sent: { channel: string; endpoint: string }[];
  skipped: { channel: string; reason: string }[];
  syncedAt: string;
}

export interface AdvancedConnectionRemoteTaskPreview {
  remoteId: string;
  title: string;
  description?: string;
  status?: string;
  assignee?: string;
}

export interface AdvancedConnectionPullTasksResult {
  ok: boolean;
  tasks: AdvancedConnectionRemoteTaskPreview[];
  pulledAt: string;
}

export const DATA_PERMISSION_LABELS: Record<
  DataPermissionId,
  { label: string; description: string; risk: 'normal' | 'sensitive' | 'high' }
> = {
  'team.presence': {
    label: '在线状态',
    description: '向团队服务同步本机智能体是否在线。',
    risk: 'normal',
  },
  'team.directory': {
    label: '智能体目录',
    description: '同步智能体名称、角色和可用能力摘要。',
    risk: 'normal',
  },
  'team.tasks.read': {
    label: '接收远程任务',
    description: '允许从团队总线读取分配给本机的任务。',
    risk: 'sensitive',
  },
  'team.tasks.write': {
    label: '上报任务状态',
    description: '向团队总线更新任务进度和交付状态。',
    risk: 'sensitive',
  },
  'usage.aggregates': {
    label: 'Usage 汇总',
    description: '上传 Token 数、会话数和时间维度汇总，不含消息正文。',
    risk: 'normal',
  },
  'usage.project-metadata': {
    label: '项目元数据',
    description: '上传项目标识、运行时和归属信息，不上传代码。',
    risk: 'sensitive',
  },
  'usage.message-metadata': {
    label: '消息元数据',
    description: '上传消息时间、模型、角色和 Token 用量，不含正文。',
    risk: 'sensitive',
  },
  'usage.message-content': {
    label: '消息正文',
    description: '上传用户与智能体的对话内容。默认关闭，可能包含敏感信息。',
    risk: 'high',
  },
  'capabilities.inventory': {
    label: '能力清单',
    description: '上传本机 Skills、工作流、命令和 MCP 的名称与摘要。',
    risk: 'sensitive',
  },
  'credentials.lark.export': {
    label: '飞书凭证委托',
    description: '允许委托飞书授权凭证。高风险，不能由普通上报权限自动开启。',
    risk: 'high',
  },
};

export const ALL_DATA_PERMISSION_IDS = Object.freeze(
  Object.keys(DATA_PERMISSION_LABELS) as DataPermissionId[]
);
