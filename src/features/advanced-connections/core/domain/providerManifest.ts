import {
  ALL_DATA_PERMISSION_IDS,
  type DataPermissionId,
  type PermissionDecision,
  type ProviderAuthMethod,
  type ProviderCapabilityDeclaration,
  type ProviderEndpointMap,
  type ProviderManifestV1,
} from '../../contracts';

const CAPABILITY_IDS = new Set(['identity', 'team-bus', 'reporting', 'token-pool']);
const ENDPOINT_KEYS = new Set<keyof ProviderEndpointMap>([
  'authStart',
  'authPoll',
  'authRefresh',
  'authMe',
  'authLogout',
  'teamConnect',
  'teamDirectory',
  'teamTasks',
  'reportUsage',
  'reportMessages',
  'reportCapabilities',
  'tokenCatalog',
  'tokenProvision',
  'tokenOperation',
  'tokenClaim',
]);

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 格式无效`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`);
  return value.trim();
}

function parseCapabilities(value: unknown): ProviderCapabilityDeclaration[] {
  if (!Array.isArray(value)) throw new Error('Provider capabilities 格式无效');
  const seen = new Set<string>();
  return value.map((entry) => {
    const item = objectValue(entry, 'Provider capability');
    const id = nonEmptyString(item.id, 'Capability id');
    if (!CAPABILITY_IDS.has(id)) throw new Error(`不支持的 Provider capability：${id}`);
    if (seen.has(id)) throw new Error(`Provider capability 重复：${id}`);
    seen.add(id);
    return {
      id: id as ProviderCapabilityDeclaration['id'],
      displayName: nonEmptyString(item.displayName, 'Capability displayName'),
      ...(typeof item.description === 'string' && item.description.trim()
        ? { description: item.description.trim() }
        : {}),
    };
  });
}

function parseAuthMethods(value: unknown): ProviderAuthMethod[] {
  if (!Array.isArray(value)) throw new Error('Provider authMethods 格式无效');
  const seen = new Set<string>();
  return value.map((entry) => {
    const item = objectValue(entry, 'Provider auth method');
    const id = nonEmptyString(item.id, 'Auth method id');
    if (seen.has(id)) throw new Error(`Provider auth method 重复：${id}`);
    seen.add(id);
    const type = nonEmptyString(item.type, 'Auth method type');
    if (type !== 'device_code' && type !== 'oauth_pkce') {
      throw new Error(`不支持的授权方式：${type}`);
    }
    const requestedScopes = Array.isArray(item.requestedScopes)
      ? item.requestedScopes.filter(
          (scope): scope is string => typeof scope === 'string' && Boolean(scope.trim())
        )
      : [];
    return {
      id,
      type,
      displayName: nonEmptyString(item.displayName, 'Auth method displayName'),
      requestedScopes,
    } as ProviderAuthMethod;
  });
}

function parseEndpoints(value: unknown): ProviderEndpointMap {
  const input = objectValue(value, 'Provider endpoints');
  const endpoints: ProviderEndpointMap = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey as keyof ProviderEndpointMap;
    if (!ENDPOINT_KEYS.has(key)) continue;
    const path = nonEmptyString(rawValue, `Endpoint ${rawKey}`);
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new Error(`Endpoint ${rawKey} 必须是同源相对路径`);
    }
    if (path.includes('\\')) throw new Error(`Endpoint ${rawKey} 路径无效`);
    endpoints[key] = path;
  }
  return endpoints;
}

export function parseProviderManifest(value: unknown): ProviderManifestV1 {
  const root = objectValue(value, 'Provider manifest');
  if (root.schemaVersion !== 1) throw new Error('暂不支持该 Provider 协议版本');
  const provider = objectValue(root.provider, 'Provider identity');
  return {
    schemaVersion: 1,
    provider: {
      id: nonEmptyString(provider.id, 'Provider id'),
      displayName: nonEmptyString(provider.displayName, 'Provider displayName'),
      ...(typeof provider.description === 'string' && provider.description.trim()
        ? { description: provider.description.trim() }
        : {}),
    },
    apiVersion: nonEmptyString(root.apiVersion, 'Provider apiVersion'),
    capabilities: parseCapabilities(root.capabilities),
    authMethods: parseAuthMethods(root.authMethods),
    endpoints: parseEndpoints(root.endpoints),
  };
}

export function defaultPermissionDecisions(): Record<DataPermissionId, PermissionDecision> {
  return Object.fromEntries(ALL_DATA_PERMISSION_IDS.map((id) => [id, 'denied'])) as Record<
    DataPermissionId,
    PermissionDecision
  >;
}

export function mergePermissionDecisions(
  current: Record<DataPermissionId, PermissionDecision>,
  patch: Partial<Record<DataPermissionId, PermissionDecision>>
): Record<DataPermissionId, PermissionDecision> {
  const next = { ...current };
  for (const id of ALL_DATA_PERMISSION_IDS) {
    const decision = patch[id];
    if (decision === 'granted' || decision === 'denied') next[id] = decision;
  }
  return next;
}
