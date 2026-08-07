export interface AuthSyncAccount {
  id?: string | null;
  email?: string | null;
  displayName?: string | null;
  tenantName?: string;
}

export interface ConnectionSecretShape {
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

export interface ConnectionRecordShape {
  id: string;
  baseUrl: string;
  managedDefault?: boolean;
  state: string;
  account?: AuthSyncAccount;
  grantedScopes: string[];
  manifest: { provider: { id: string } } & Record<string, unknown>;
  permissions: Record<string, string>;
  lastError?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface OpenHermitAuthStoreShape {
  schemaVersion: number;
  provider: string;
  issuer?: string | null;
  baseUrl?: string | null;
  clientId?: string;
  account?: Record<string, unknown> | null;
  token: {
    accessToken: string;
    refreshToken?: string | null;
    tokenType?: string;
    scope?: string;
    scopes?: string[];
    expiresAt?: string | null;
    updatedAt?: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

export declare const DEFAULT_PERMISSION_DECISIONS: Record<string, 'granted' | 'denied'>;

export declare function isDefaultAgentbusRecord(record: {
  managedDefault?: boolean;
  manifest?: { provider?: { id?: string } };
} | null | undefined): boolean;

export declare function buildAuthStoreFromConnection(input: {
  record: ConnectionRecordShape;
  secret: ConnectionSecretShape;
  now?: string;
}): OpenHermitAuthStoreShape;

export declare function buildConnectionSecretFromAuthStore(input: {
  store: OpenHermitAuthStoreShape;
  connectionId: string;
  now?: string;
  providerId?: string;
}): ConnectionSecretShape;

export declare function readJsonIfExists(file: string): Promise<unknown>;
export declare function writeJsonAtomic(file: string, value: unknown): Promise<void>;
export declare function deleteFileIfExists(file: string): Promise<void>;

export declare function shouldSkipWriteThrough(
  existingTokenUpdatedAt: string | undefined,
  incomingUpdatedAt: string | undefined
): boolean;

export declare function writeAuthStoreThrough(input: {
  authStorePath: string;
  record: ConnectionRecordShape;
  secret: ConnectionSecretShape;
  now?: string;
}): Promise<'written' | 'skipped-newer'>;

export declare function removeAuthStore(input: { authStorePath: string }): Promise<void>;

export declare function writeConnectionThrough(input: {
  connectionsDir: string;
  store: OpenHermitAuthStoreShape;
  issuerOrigin?: string;
  now?: string;
}): Promise<{ outcome: 'written' | 'skipped-newer'; connectionId: string }>;

export declare function clearConnectionAuth(input: {
  connectionsDir: string;
  connectionId?: string;
  now?: string;
}): Promise<string | null>;
