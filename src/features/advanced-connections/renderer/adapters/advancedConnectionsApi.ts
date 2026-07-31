import {
  ADVANCED_CONNECTIONS_API_BASE,
  type AdvancedConnectionPullTasksResult,
  type AdvancedConnectionSummary,
  type AdvancedConnectionSyncResult,
  type AdvancedConnectionTokenCatalogResponse,
  type CreateAdvancedConnectionRequest,
  type DiscoverAdvancedConnectionRequest,
  type DiscoverAdvancedConnectionResponse,
  type StartAdvancedConnectionAuthResponse,
  type UpdateAdvancedConnectionPermissionsRequest,
} from '../../contracts';

function responseError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const error = (payload as Record<string, unknown>).error;
  return typeof error === 'string' && error.trim() ? error : undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ADVANCED_CONNECTIONS_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => null)) as
    | T
    | { ok?: boolean; error?: string }
    | null;
  if (!response.ok) {
    const message = responseError(payload) ?? `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

export const advancedConnectionsApi = {
  list: (): Promise<AdvancedConnectionSummary[]> => request(''),
  discover: (
    body: DiscoverAdvancedConnectionRequest
  ): Promise<DiscoverAdvancedConnectionResponse> =>
    request('/discover', { method: 'POST', body: JSON.stringify(body) }),
  create: (body: CreateAdvancedConnectionRequest): Promise<AdvancedConnectionSummary> =>
    request('', { method: 'POST', body: JSON.stringify(body) }),
  remove: (connectionId: string): Promise<{ ok: true }> =>
    request(`/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),
  updatePermissions: (
    connectionId: string,
    body: UpdateAdvancedConnectionPermissionsRequest
  ): Promise<AdvancedConnectionSummary> =>
    request(`/${encodeURIComponent(connectionId)}/permissions`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  startAuth: (
    connectionId: string,
    methodId: string
  ): Promise<StartAdvancedConnectionAuthResponse> =>
    request(`/${encodeURIComponent(connectionId)}/auth/start`, {
      method: 'POST',
      body: JSON.stringify({ methodId }),
    }),
  logout: (connectionId: string): Promise<AdvancedConnectionSummary> =>
    request(`/${encodeURIComponent(connectionId)}/logout`, { method: 'POST' }),
  sync: (connectionId: string): Promise<AdvancedConnectionSyncResult> =>
    request(`/${encodeURIComponent(connectionId)}/sync`, { method: 'POST' }),
  pullTasks: (connectionId: string): Promise<AdvancedConnectionPullTasksResult> =>
    request(`/${encodeURIComponent(connectionId)}/team-bus/pull-tasks`, { method: 'POST' }),
  tokenCatalog: (connectionId: string): Promise<AdvancedConnectionTokenCatalogResponse> =>
    request(`/${encodeURIComponent(connectionId)}/token-pool/catalog`),
};
