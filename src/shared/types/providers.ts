/**
 * Provider (渠道) types — global AI model provider configuration.
 *
 * Modeled after cc-connect's GlobalProviderInfo. Each provider can support
 * multiple Agent CLIs (claudecode, codex, gemini, opencode, cursor, kimi, qoder, acp)
 * with per-agent overrides for endpoint/model.
 */

export type AgentType =
  | 'claudecode'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'cursor'
  | 'iflow'
  | 'kimi'
  | 'devin'
  | 'qoder'
  | 'pi'
  | 'acp'
  | 'tmux';

export const ALL_AGENT_TYPES: readonly AgentType[] = [
  'claudecode',
  'codex',
  'gemini',
  'opencode',
  'cursor',
  'iflow',
  'kimi',
  'devin',
  'qoder',
  'pi',
  'acp',
  'tmux',
] as const;

export interface ProviderModelEntry {
  model: string;
  alias?: string;
}

export interface CodexProviderConfig {
  wire_api?: string;
  http_headers?: Record<string, string>;
}

export interface GlobalProvider {
  /** Unique provider name, used as the primary key */
  name: string;
  api_key?: string;
  base_url?: string;
  /** Default model used when no per-agent override exists */
  model?: string;
  /** thinking mode override: 'enabled' | 'disabled' | '' (default) */
  thinking?: string;
  env?: Record<string, string>;
  /** Agent CLIs that this provider supports */
  agent_types?: AgentType[];
  /** Default available models (shown as quick-pick chips) */
  models?: ProviderModelEntry[];
  /** Per-agent endpoint overrides */
  endpoints?: Partial<Record<AgentType, string>>;
  /** Per-agent default model overrides */
  agent_models?: Partial<Record<AgentType, string>>;
  /** Per-agent available model lists */
  agent_model_lists?: Partial<Record<AgentType, ProviderModelEntry[]>>;
  /** Codex-specific overrides (wire api, headers) */
  codex?: CodexProviderConfig;
}

export interface ProviderPresetAgentConfig {
  base_url: string;
  model: string;
  models?: string[];
  codex_config?: {
    wire_api?: string;
    http_headers?: Record<string, string>;
  };
}

export interface ProviderPreset {
  name: string;
  display_name: string;
  agents: Record<string, ProviderPresetAgentConfig>;
  invite_url?: string;
  description?: string;
  description_zh?: string;
  features?: string[];
  thinking?: string;
  tier: number;
  featured?: boolean;
  website?: string;
}

export interface ProviderPresetsResponse {
  version: number;
  updated_at?: string;
  providers: ProviderPreset[];
}
