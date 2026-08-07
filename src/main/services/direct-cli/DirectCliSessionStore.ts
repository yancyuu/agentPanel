/**
 * Persists the `DirectCliSessionManager`'s `sessionKey → claude session_id` mapping so
 * a direct-CLI session can `--resume` the same claude conversation across Hermit restarts.
 *
 * Lives behind a small repository interface (CLAUDE.md storage guidance: the manager
 * depends on this abstraction, not on the file format). The default implementation is a
 * single JSON file under `~/.hermit/direct-cli/sessions.json`, mirroring how other Hermit
 * stores (collaboration board, team manifests) persist under `~/.hermit`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const HERMIT_HOME = process.env.HERMIT_HOME ?? path.join(os.homedir(), '.hermit');
export const DEFAULT_DIRECT_CLI_SESSIONS_FILE = path.join(
  HERMIT_HOME,
  'direct-cli',
  'sessions.json'
);

/** Repository interface the {@link DirectCliSessionManager} depends on. */
export interface DirectCliSessionRepository {
  get(sessionKey: string): string | undefined;
  set(sessionKey: string, sessionId: string): void;
  has(sessionKey: string): boolean;
  delete(sessionKey: string): void;
}

export class DirectCliSessionStore implements DirectCliSessionRepository {
  private readonly filePath: string;

  private cache: Record<string, string> | undefined;

  constructor(filePath: string = DEFAULT_DIRECT_CLI_SESSIONS_FILE) {
    this.filePath = filePath;
  }

  get(sessionKey: string): string | undefined {
    return this.load()[sessionKey];
  }

  set(sessionKey: string, sessionId: string): void {
    const trimmedKey = sessionKey.trim();
    const trimmedId = sessionId.trim();
    if (!trimmedKey || !trimmedId) return;
    const data = this.load();
    data[trimmedKey] = trimmedId;
    this.persist(data);
  }

  has(sessionKey: string): boolean {
    return this.get(sessionKey) !== undefined;
  }

  delete(sessionKey: string): void {
    const data = this.load();
    if (delete data[sessionKey.trim()]) {
      this.persist(data);
    }
  }

  /** Test helper: full mapping snapshot. */
  all(): Record<string, string> {
    return { ...this.load() };
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
        this.cache =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, string>)
            : {};
      } else {
        this.cache = {};
      }
    } catch {
      // Corrupt or unreadable file — start fresh rather than crash the manager.
      this.cache = {};
    }
    return this.cache;
  }

  private persist(data: Record<string, string>): void {
    this.cache = data;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Persistence is best-effort: a failed write only costs resume continuity.
    }
  }
}
