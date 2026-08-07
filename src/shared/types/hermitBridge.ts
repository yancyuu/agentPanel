/**
 * hermit-bridge Management API types.
 *
 * These types mirror the JSON shapes returned by hermit-bridge's
 * Management API (default: http://127.0.0.1:9820/api/v1/*).
 */

// =============================================================================
// Common
// =============================================================================

export interface HermitBridgeApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// =============================================================================
// Status
// =============================================================================

export interface HermitBridgeStatus {
  version: string;
  uptime_seconds: number;
  projects_count: number;
  platforms_connected: number;
}

// =============================================================================
// Projects
// =============================================================================

export type HermitBridgeAgentType =
  | 'claudecode'
  | 'codex'
  | 'cursor'
  | 'gemini'
  | 'iflow'
  | 'kimi'
  | 'devin'
  | 'opencode'
  | 'qoder'
  | 'pi'
  | 'acp'
  | 'tmux';

export interface HermitBridgeProjectListItem {
  name: string;
  agent_type: HermitBridgeAgentType;
  platforms: string[];
  sessions_count: number;
  heartbeat_enabled: boolean;
}

export interface HermitBridgeProjectPlatform {
  type: string;
  connected: boolean;
}

export interface HermitBridgeProjectHeartbeat {
  enabled: boolean;
  paused: boolean;
  interval_mins: number;
  session_key?: string;
}

export interface HermitBridgeProjectSettings {
  language?: string;
  admin_from?: string;
  disabled_commands?: string[];
}

export interface HermitBridgeProjectDetail {
  name: string;
  agent_type: HermitBridgeAgentType;
  platforms: HermitBridgeProjectPlatform[];
  sessions_count: number;
  active_session_keys: string[];
  heartbeat: HermitBridgeProjectHeartbeat;
  settings: HermitBridgeProjectSettings;
  work_dir: string;
  agent_mode: string;
}

export interface HermitBridgeProjectSettingsUpdate {
  language?: string;
  admin_from?: string;
  disabled_commands?: string[];
  work_dir?: string;
  mode?: string;
  agent_type?: string;
  show_context_indicator?: boolean;
  reply_footer?: boolean;
  inject_sender?: boolean;
  platform_allow_from?: Record<string, string>;
  /** 群聊允许的 chat ID，* 表示所有群聊 */
  platform_allow_chat?: Record<string, string>;
  /** 会话空闲自动轮转（分钟），0 = 不轮转。TOML-only，不通过 PATCH API。 */
  reset_on_idle_mins?: number;
}

export interface HermitBridgeAddPlatformRequest {
  type: string;
  options: Record<string, string>;
  work_dir?: string;
  agent_type?: string;
}

// =============================================================================
// Sessions
// =============================================================================

export interface HermitBridgeSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface HermitBridgeSessionListItem {
  id: string;
  name: string;
  session_key: string;
  agent_session_id?: string;
  agent_type: HermitBridgeAgentType;
  active: boolean;
  live: boolean;
  history_count: number;
  created_at: string;
  updated_at: string;
  last_message: HermitBridgeSessionMessage | null;
  platform: string;
  user_name?: string;
  chat_name?: string;
}

export interface HermitBridgeSessionDetail {
  id: string;
  name: string;
  session_key: string;
  agent_session_id?: string;
  agent_type: HermitBridgeAgentType;
  active: boolean;
  live: boolean;
  history_count: number;
  created_at: string;
  updated_at: string;
  platform: string;
  history: HermitBridgeSessionMessage[];
}

// =============================================================================
// Heartbeat
// =============================================================================

export interface HermitBridgeHeartbeatStatus {
  enabled: boolean;
  paused?: boolean;
  interval_mins?: number;
  only_when_idle?: boolean;
  session_key?: string;
  silent?: boolean;
  run_count?: number;
  error_count?: number;
  skipped_busy?: number;
  last_run?: string;
  last_error?: string;
}

// =============================================================================
// Providers
// =============================================================================

export interface HermitBridgeProviderModelEntry {
  model: string;
  alias?: string;
}

export interface HermitBridgeGlobalProvider {
  name: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  thinking?: string;
  env?: Record<string, string>;
  agent_types?: string[];
  models?: HermitBridgeProviderModelEntry[];
  endpoints?: Record<string, string>;
  agent_models?: Record<string, string>;
  agent_model_lists?: Record<string, HermitBridgeProviderModelEntry[]>;
  codex?: {
    wire_api?: string;
    http_headers?: Record<string, string>;
  };
}

export interface HermitBridgeProviderPresetAgentConfig {
  base_url: string;
  model: string;
  models?: string[];
  codex_config?: {
    wire_api?: string;
    http_headers?: Record<string, string>;
  };
}

export interface HermitBridgeProviderPreset {
  name: string;
  display_name: string;
  agents: Record<string, HermitBridgeProviderPresetAgentConfig>;
  invite_url?: string;
  description?: string;
  description_zh?: string;
  features?: string[];
  thinking?: string;
  tier: number;
  featured?: boolean;
  website?: string;
}

export interface HermitBridgeProviderPresetsResponse {
  version: number;
  updated_at?: string;
  providers: HermitBridgeProviderPreset[];
}

// =============================================================================
// Models
// =============================================================================

export interface HermitBridgeModelEntry {
  model: string;
  alias?: string;
}

// =============================================================================
// Cron Jobs
// =============================================================================

export interface HermitBridgeCronJob {
  id: string;
  project: string;
  session_key: string;
  cron_expr: string;
  prompt: string;
  description?: string;
  enabled: boolean;
  timeout_mins?: number;
  created_at: string;
  last_run?: string;
}

export interface HermitBridgeCreateCronJobRequest {
  project: string;
  session_key: string;
  cron_expr: string;
  prompt: string;
  description?: string;
  enabled?: boolean;
  timeout_mins?: number;
}

// =============================================================================
// Bridge WebSocket Protocol
// =============================================================================

/** First message from adapter to hermit-bridge. */
export interface HermitBridgeRegisterMessage {
  type: 'register';
  platform: string;
  capabilities: string[];
  metadata?: Record<string, string>;
  /**
   * Opt into per-turn token-usage broadcasts. ADDITIVE: a connection that also
   * sets `platform` keeps full send/receive AND receives usage events. With an
   * empty `platform` it is a pure monitoring-only observer (never a reply target).
   */
  observe_usage?: boolean;
}

/** User message from adapter to hermit-bridge. */
export interface HermitBridgeUserMessage {
  type: 'message';
  msg_id: string;
  session_key: string;
  user_id: string;
  user_name: string;
  content: string;
  /**
   * 路由到的 hermit-bridge project 名称。
   * 当 session_key 不足以唯一标识 project(如 hermit 群聊多成员共享同一 sessionKey)时,
   * 必须显式提供 project 让 hermit-bridge 知道发送给哪个 engine。
   */
  project?: string;
  /** 可选 chat 标识,默认 hermit-bridge 由 session_key 解析。 */
  chat_id?: string;
  reply_ctx?: string;
  images?: { mime_type: string; data: string; file_name: string }[];
  files?: { mime_type: string; data: string; file_name: string }[];
}

/** Complete reply from agent. */
export interface HermitBridgeTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
}

export interface HermitBridgeReplyMessage {
  type: 'reply';
  session_key: string;
  reply_ctx?: string;
  content: string;
  format?: string;
  usage?: HermitBridgeTokenUsage;
  token_usage?: HermitBridgeTokenUsage;
}

/** Streaming delta from agent. */
export interface HermitBridgeReplyStreamMessage {
  type: 'reply_stream';
  session_key: string;
  reply_ctx?: string;
  delta: string;
  full_text: string;
  preview_handle?: string;
  done: boolean;
  usage?: HermitBridgeTokenUsage;
  token_usage?: HermitBridgeTokenUsage;
}

/** Card from agent. */
export interface HermitBridgeCardMessage {
  type: 'card';
  session_key: string;
  reply_ctx?: string;
  card: {
    header?: { title: string; color?: string };
    elements: Record<string, unknown>[];
  };
}

/** Buttons from agent. */
export interface HermitBridgeButtonsMessage {
  type: 'buttons';
  session_key: string;
  reply_ctx?: string;
  content: string;
  buttons: { text: string; data: string }[][];
}

/** Typing indicators. */
export interface HermitBridgeTypingMessage {
  type: 'typing_start' | 'typing_stop';
  session_key: string;
}

/** Ping/pong keepalive. */
export interface HermitBridgePingMessage {
  type: 'ping';
  ts: number;
}

export interface HermitBridgePongMessage {
  type: 'pong';
  ts: number;
}

/**
 * Per-turn token usage broadcast, fanned out to every connection that registered
 * with `observe_usage: true`. Carries token counts ONLY — no message content.
 * Hermit treats this as local-session attribution metadata; remote token usage is
 * derived from local Claude JSONL rows, not forwarded directly from this event.
 * Emitted by hermit-bridge at turn-complete for every turn, regardless of which IM platform ran it
 * (the engine broadcasts via the process-wide bridge server).
 */
export interface HermitBridgeUsageMessage {
  type: 'usage';
  session_key: string;
  platform: string;
  agent_type?: string;
  /** Stable per-turn id (the inbound IM message id). Metadata only; token truth comes from local JSONL. */
  turn_id?: string;
  /** Current-turn sender/chat identity from hermit-bridge. No message content is included. */
  user_id?: string;
  chat_id?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  ts: number;
}

/** Card action from adapter. */
export interface HermitBridgeCardActionMessage {
  type: 'card_action';
  session_key: string;
  action: string;
  reply_ctx?: string;
}

export type HermitBridgeIncomingMessage =
  | HermitBridgeReplyMessage
  | HermitBridgeReplyStreamMessage
  | HermitBridgeCardMessage
  | HermitBridgeButtonsMessage
  | HermitBridgeTypingMessage
  | HermitBridgePongMessage
  | HermitBridgeUsageMessage;

export type HermitBridgeOutgoingMessage =
  | HermitBridgeRegisterMessage
  | HermitBridgeUserMessage
  | HermitBridgePingMessage
  | HermitBridgeCardActionMessage;

// =============================================================================
// Hermit-specific: Project Mapping
// =============================================================================

export interface HermitBridgeProjectMapping {
  teamName: string;
  memberName: string;
  ccProjectName: string;
  agentType: HermitBridgeAgentType;
  workDir: string;
  sessionKey?: string;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Hermit-specific: Connection Config
// =============================================================================

export interface HermitBridgeConnectionConfig {
  baseUrl: string;
  bridgeUrl: string;
  token: string;
  bridgeToken?: string;
}

export const HERMIT_BRIDGE_DEFAULTS: HermitBridgeConnectionConfig = {
  baseUrl: 'http://127.0.0.1:9820',
  bridgeUrl: 'ws://127.0.0.1:9810/bridge/ws',
  token: '',
};
