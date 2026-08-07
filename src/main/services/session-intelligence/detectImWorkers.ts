/**
 * Pure live-worker detection over parsed hermit-bridge session stores.
 *
 * One worker = one IM conversation = one sender-keyed composite
 * (`provider:chatId:ou_sender`). Message-keyed composites (`on_`/`om_`) are
 * transient per-IM-turn and are NOT turned into workers.
 *
 * State is derived from recency + the last history entry's role. hermit-bridge's
 * `history[]` is clean human↔agent text (no tool_use / thinking), so IM workers
 * are intentionally coarser than team agents: `busy` (assistant just replied),
 * `waiting` (user just spoke, agent should reply), `idle` (recently active, now
 * quiet). Activity is timed from the last history timestamp — `last_user_activity`
 * is the Go zero value in real files and must not be trusted (see
 * {@link sessionLastActivityAt}).
 */

import {
  lastUserMessage,
  type ParsedHermitBridgeSession,
  type ParsedHermitBridgeStore,
  sessionLastActivityAt,
} from './hermitBridgeSessionStore';

import type { ImLiveWorker, ImWorkerState } from '@shared/types/imLiveWorker';

export type { ImLiveWorker, ImWorkerState };

export const BUSY_WINDOW_MS = 60_000;
export const IDLE_WINDOW_MS = 10 * 60_000;

function snippet(text: string | undefined, max = 80): string | undefined {
  if (!text) return undefined;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function detectImWorkers(stores: ParsedHermitBridgeStore[], now: number): ImLiveWorker[] {
  // Keep the freshest worker per composite key across all stores.
  const bestByKey = new Map<string, { worker: ImLiveWorker; atMs: number }>();

  for (const store of stores) {
    for (const [key, composite] of store.composites) {
      if (!composite.envelope.senderId) continue; // message-keyed → not a worker

      // Pick the freshest Claude session this conversation drove.
      let picked: { sess: ParsedHermitBridgeSession; at: string; atMs: number } | null = null;
      for (const id of composite.agentSessionIds) {
        const sess = store.sessions.get(id);
        if (!sess) continue;
        const at = sessionLastActivityAt(sess);
        if (!at) continue;
        const atMs = Date.parse(at);
        if (!Number.isFinite(atMs)) continue;
        if (!picked || atMs > picked.atMs) picked = { sess, at, atMs };
      }
      if (!picked) continue;

      const recency = now - picked.atMs;
      if (recency > IDLE_WINDOW_MS) continue; // left the office

      const lastEntry = picked.sess.history[picked.sess.history.length - 1];
      const lastRole = lastEntry ? (lastEntry.role === 'assistant' ? 'assistant' : 'user') : null;

      let state: ImWorkerState;
      if (recency <= BUSY_WINDOW_MS && lastRole === 'assistant') state = 'busy';
      else if (recency <= BUSY_WINDOW_MS && lastRole === 'user') state = 'waiting';
      else state = 'idle';

      const lastUser = lastUserMessage(picked.sess);
      const worker: ImLiveWorker = {
        key,
        provider: composite.envelope.provider,
        chatId: composite.envelope.chatId,
        chatName: composite.envelope.chatName,
        senderId: composite.envelope.senderId,
        senderName: composite.envelope.senderName,
        project: store.project,
        agentSessionId: picked.sess.agentSessionId,
        state,
        lastRole,
        lastActivityAt: picked.at,
        lastUserSnippet: snippet(lastUser?.content),
      };

      const prev = bestByKey.get(key);
      if (!prev || picked.atMs > prev.atMs) bestByKey.set(key, { worker, atMs: picked.atMs });
    }
  }

  return [...bestByKey.values()].sort((a, b) => b.atMs - a.atMs).map((e) => e.worker);
}
