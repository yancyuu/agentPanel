/**
 * Pure parser for hermit-bridge's on-disk session store.
 *
 * hermit-bridge (the cc-connect fork) persists one JSON file per project at
 * `<hermitHome>/cc-connect/data/sessions/<project>_<hash>.json`. This module
 * is the single place that knows that raw shape; live worker detection
 * (detectImWorkers / the IM live watcher) consumes its output instead of
 * re-parsing the files.
 *
 * Top-level keys (verified against real files):
 *   sessions        — Record<internalId, SessionObject> keyed by ids like "s1"
 *   active_session  — Record<composite, agent_session_id>  (current session)
 *   user_sessions   — Record<composite, agent_session_id[]> (all sessions)
 *   user_meta       — Record<composite, { chat_name?, user_name? }>
 *   counter / past_id_tracking / version — auxiliary
 *
 * A composite key is `provider:chatId:<senderId|messageId>` where the third
 * segment is disambiguated by Feishu id prefix: `ou_` → sender, `on_`/`om_` →
 * the triggering IM message. A chat is indexed under BOTH, so one conversation
 * typically yields two composite entries (sender + message).
 */

import type { HermitBridgeSessionMessage } from '@shared/types/hermitBridge';

/**
 * IM attribution envelope for a Claude session. `provider` is always present;
 * the rest is decoded from the composite key + user_meta when available.
 */
export interface ImEnvelope {
  provider: string;
  chatId?: string;
  chatName?: string;
  chatType?: string;
  senderId?: string;
  senderName?: string;
  /** Feishu message id of the IM turn that drove this session (om_/on_). */
  messageId?: string;
}

export interface ParsedHermitBridgeSession {
  agentSessionId: string;
  history: HermitBridgeSessionMessage[];
  updatedAt?: string;
  createdAt?: string;
  agentType?: string;
  name?: string;
  /** Earlier Claude sessions this conversation rolled over from. */
  pastAgentSessionIds: string[];
}

export interface ParsedHermitBridgeComposite {
  envelope: ImEnvelope;
  agentSessionIds: Set<string>;
}

export interface ParsedHermitBridgeStore {
  project: string;
  composites: Map<string, ParsedHermitBridgeComposite>;
  sessions: Map<string, ParsedHermitBridgeSession>;
}

const KNOWN_PROVIDERS = new Set(['feishu', 'weixin', 'wecom', 'dingtalk']);
const SENDER_PREFIX = 'ou_';
const MESSAGE_PREFIXES = ['on_', 'om_'];

interface DecodedComposite {
  provider: string;
  chatId?: string;
  senderId?: string;
  messageId?: string;
}

function parseComposite(key: string): DecodedComposite | null {
  const parts = key.split(':');
  if (parts.length < 3 || !KNOWN_PROVIDERS.has(parts[0])) return null;
  const provider = parts[0];
  const chatId = parts[1] || undefined;
  const third = parts.slice(2).join(':') || undefined;
  let senderId: string | undefined;
  let messageId: string | undefined;
  if (third) {
    if (third.startsWith(SENDER_PREFIX)) senderId = third;
    else if (MESSAGE_PREFIXES.some((p) => third.startsWith(p))) messageId = third;
  }
  return { provider, chatId, senderId, messageId };
}

function chatTypeFromId(chatId?: string): string | undefined {
  if (!chatId) return undefined;
  if (chatId.startsWith('oc_')) return 'group';
  if (chatId.startsWith('ou_')) return 'p2p';
  return undefined;
}

/**
 * Derive the project name from the session-store file name. Files are
 * `<project>_<8+hex>.json`; strip the trailing `_<hash>` when it looks like a
 * hash, otherwise keep the whole stem (project names may contain `_`).
 */
export function projectFromFileName(fileName: string): string {
  const stem = fileName.endsWith('.json') ? fileName.slice(0, -'.json'.length) : fileName;
  return stem.replace(/_[0-9a-fA-F]{6,}$/, '') || stem;
}

function coerceHistory(raw: unknown): HermitBridgeSessionMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: HermitBridgeSessionMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { role?: unknown; content?: unknown; timestamp?: unknown };
    if (typeof e.role !== 'string' || typeof e.content !== 'string') continue;
    out.push({
      role: e.role === 'assistant' ? 'assistant' : 'user',
      content: e.content,
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : '',
    });
  }
  return out;
}

/**
 * Parse one hermit-bridge session-store file into a structured store, or null
 * when the input is not an object. Pure: no IO, deterministic, trivially
 * testable.
 */
export function parseHermitBridgeSessions(
  raw: unknown,
  fileName: string
): ParsedHermitBridgeStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as {
    sessions?: Record<string, unknown>;
    active_session?: Record<string, unknown>;
    user_sessions?: Record<string, unknown>;
    user_meta?: Record<string, unknown>;
  };

  const project = projectFromFileName(fileName);
  const composites = new Map<string, ParsedHermitBridgeComposite>();
  const sessions = new Map<string, ParsedHermitBridgeSession>();

  // Map bridge internal ids (the top-level keys of `sessions`, e.g. "s12") to the
  // Claude agent session ids they drove (current + past). The composite maps
  // (`user_sessions` / `active_session`) index conversations by these internal
  // ids, but IM-origin attribution and live-worker detection look sessions up by
  // `agent_session_id` (the Claude .jsonl filename). Without this resolution the
  // two keys never match and every composite envelope is silently dropped.
  const agentIdsByBridgeId = new Map<string, Set<string>>();
  for (const [bridgeId, entry] of Object.entries(root.sessions ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as { agent_session_id?: unknown; past_agent_session_ids?: unknown };
    const ids = agentIdsByBridgeId.get(bridgeId) ?? new Set<string>();
    if (typeof s.agent_session_id === 'string' && s.agent_session_id) ids.add(s.agent_session_id);
    if (Array.isArray(s.past_agent_session_ids))
      for (const v of s.past_agent_session_ids) if (typeof v === 'string' && v) ids.add(v);
    if (ids.size) agentIdsByBridgeId.set(bridgeId, ids);
  }

  // Resolve a composite map value (string or array of bridge internal ids) to the
  // underlying Claude agent session ids. Legacy builds that already stored
  // `agent_session_id` directly (not internal ids) pass through unchanged.
  const resolveAgentIds = (value: unknown, into: Set<string>): void => {
    const visit = (v: unknown): void => {
      if (typeof v !== 'string' || !v) return;
      const resolved = agentIdsByBridgeId.get(v);
      if (resolved) for (const id of resolved) into.add(id);
      else into.add(v);
    };
    if (Array.isArray(value)) for (const v of value) visit(v);
    else visit(value);
  };

  const ensureComposite = (key: string): ParsedHermitBridgeComposite => {
    let existing = composites.get(key);
    if (!existing) {
      existing = { envelope: buildEnvelope(root, key), agentSessionIds: new Set() };
      composites.set(key, existing);
    }
    return existing;
  };

  for (const [composite, value] of Object.entries(root.user_sessions ?? {})) {
    if (!parseComposite(composite)) continue;
    resolveAgentIds(value, ensureComposite(composite).agentSessionIds);
  }
  for (const [composite, value] of Object.entries(root.active_session ?? {})) {
    if (!parseComposite(composite)) continue;
    resolveAgentIds(value, ensureComposite(composite).agentSessionIds);
  }

  for (const entry of Object.values(root.sessions ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as {
      agent_session_id?: unknown;
      agent_type?: unknown;
      name?: unknown;
      history?: unknown;
      created_at?: unknown;
      updated_at?: unknown;
      past_agent_session_ids?: unknown;
    };
    if (typeof s.agent_session_id !== 'string' || !s.agent_session_id) continue;
    const past = Array.isArray(s.past_agent_session_ids)
      ? s.past_agent_session_ids.filter((v): v is string => typeof v === 'string' && !!v)
      : [];
    sessions.set(s.agent_session_id, {
      agentSessionId: s.agent_session_id,
      history: coerceHistory(s.history),
      updatedAt: typeof s.updated_at === 'string' ? s.updated_at : undefined,
      createdAt: typeof s.created_at === 'string' ? s.created_at : undefined,
      agentType: typeof s.agent_type === 'string' ? s.agent_type : undefined,
      name: typeof s.name === 'string' ? s.name : undefined,
      pastAgentSessionIds: past,
    });
  }

  return { project, composites, sessions };
}

function buildEnvelope(
  root: { user_meta?: Record<string, unknown> },
  composite: string
): ImEnvelope {
  const decoded = parseComposite(composite)!;
  const meta = root.user_meta?.[composite] as
    | { chat_name?: unknown; user_name?: unknown }
    | undefined;
  return {
    provider: decoded.provider,
    chatId: decoded.chatId,
    chatType: chatTypeFromId(decoded.chatId),
    senderId: decoded.senderId,
    senderName: typeof meta?.user_name === 'string' ? meta.user_name : undefined,
    chatName: typeof meta?.chat_name === 'string' ? meta.chat_name : undefined,
    messageId: decoded.messageId,
  };
}

/**
 * Most-recent activity timestamp for a session. Prefers the last history entry's
 * timestamp (the truest "something just happened" signal — history is appended
 * on every turn), then falls back to `updated_at`, then `created_at`.
 *
 * NOTE: `last_user_activity` is intentionally NOT used — in real files it is the
 * Go zero value `0001-01-01T00:00:00Z` (unreliable).
 */
export function sessionLastActivityAt(sess: ParsedHermitBridgeSession): string | undefined {
  for (let i = sess.history.length - 1; i >= 0; i -= 1) {
    const ts = sess.history[i].timestamp;
    if (ts) return ts;
  }
  return sess.updatedAt ?? sess.createdAt;
}

/** Most recent user-role message in a session's history (the inbound request). */
export function lastUserMessage(
  sess: ParsedHermitBridgeSession
): HermitBridgeSessionMessage | null {
  for (let i = sess.history.length - 1; i >= 0; i -= 1) {
    if (sess.history[i].role === 'user') return sess.history[i];
  }
  return null;
}
