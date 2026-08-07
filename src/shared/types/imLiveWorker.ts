/**
 * Live IM worker — one active IM conversation surfaced to the renderer by the
 * hermit-bridge session watcher. Shared across main (watcher/IPC) and renderer
 * (store/projection) so neither side imports the other's process tree.
 */

export type ImWorkerState = 'busy' | 'waiting' | 'idle';

export interface ImLiveWorker {
  /** Sender-keyed composite key — stable identity for one conversation. */
  key: string;
  provider: string;
  chatId?: string;
  chatName?: string;
  senderId?: string;
  senderName?: string;
  /** hermit-bridge project name (which agent is serving this chat). */
  project: string;
  /** Claude session id to resume in a terminal on click. */
  agentSessionId: string;
  state: ImWorkerState;
  lastRole: 'user' | 'assistant' | null;
  lastActivityAt: string;
  lastUserSnippet?: string;
}
