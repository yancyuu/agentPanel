export declare const AGENTBUS_PROVIDER_ID: string;

export interface AgentbusCompatibilityManifest {
  schemaVersion: 1;
  provider: { id: string; displayName: string; description?: string };
  apiVersion: string;
  capabilities: { id: string; displayName: string; description?: string }[];
  authMethods: {
    id: string;
    type: string;
    displayName: string;
    requestedScopes: string[];
  }[];
  endpoints: Record<string, string>;
}

export declare function agentbusCompatibilityManifest(): AgentbusCompatibilityManifest;
