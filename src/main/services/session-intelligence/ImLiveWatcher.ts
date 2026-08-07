/**
 * Live IM worker watcher — turns hermit-bridge's on-disk session store into a
 * push signal the renderer can render.
 *
 * hermit-bridge writes one JSON file per project at
 * `<hermitHome>/cc-connect/data/sessions/<project>_<hash>.json` whenever an
 * IM-driven agent turn happens. This watcher observes that directory and, on
 * any change (debounced) plus a 5s watchdog, reparses every file into live
 * workers via {@link parseHermitBridgeSessions} → {@link detectImWorkers} and
 * pushes the result through the injected `emit` callback (wired to
 * `broadcastSse('im-live-workers', …)` in server.ts).
 *
 * The IO/timer surface lives here; all of the meaning (what a "worker" is, what
 * state it is in) is owned by the pure modules this calls, which is where the
 * tests are. `emit` is injected so this module never imports server.ts.
 */

import { type FSWatcher, watch } from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

import { detectImWorkers } from './detectImWorkers';
import {
  type ParsedHermitBridgeStore,
  parseHermitBridgeSessions,
} from './hermitBridgeSessionStore';

import type { ImLiveWorker } from '@shared/types/imLiveWorker';

export const IM_LIVE_WATCH_DEBOUNCE_MS = 200;
export const IM_LIVE_WATCH_INTERVAL_MS = 5_000;

/**
 * hermit-bridge sessions dir. Mirrors the canonical `hermitHome()` used across
 * the codebase (`HERMIT_HOME || ~/.hermit`) — already `os.homedir()` based, so
 * it is Windows-safe.
 */
export function defaultImSessionsDir(
  hermitHome: string = process.env.HERMIT_HOME ?? path.join(os.homedir(), '.hermit')
): string {
  return path.join(hermitHome, 'cc-connect', 'data', 'sessions');
}

export interface ImLiveWatcherOptions {
  sessionsDir: string;
  /** Push callback — wired to `broadcastSse('im-live-workers', workers)`. */
  emit: (workers: ImLiveWorker[]) => void;
  now?: () => number;
  debounceMs?: number;
  intervalMs?: number;
}

interface SessionFileCacheEntry {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  store: ParsedHermitBridgeStore | null;
}

function isIgnorableFsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class ImLiveWatcher {
  private readonly sessionsDir: string;
  private readonly emit: (workers: ImLiveWorker[]) => void;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly intervalMs: number;

  private fsWatcher: FSWatcher | null = null;
  private interval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly fileCache = new Map<string, SessionFileCacheEntry>();
  private scanInFlight: Promise<void> | null = null;
  private scanQueued = false;

  constructor(opts: ImLiveWatcherOptions) {
    this.sessionsDir = opts.sessionsDir;
    this.emit = opts.emit;
    this.now = opts.now ?? Date.now;
    this.debounceMs = opts.debounceMs ?? IM_LIVE_WATCH_DEBOUNCE_MS;
    this.intervalMs = opts.intervalMs ?? IM_LIVE_WATCH_INTERVAL_MS;
  }

  /** Begin watching: an immediate scan, a debounced fs.watch, and a watchdog interval. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.scan();
    this.attachFsWatch();
    this.interval = setInterval(() => void this.scan(), this.intervalMs);
  }

  private attachFsWatch(): void {
    if (this.fsWatcher) return;
    try {
      this.fsWatcher = watch(this.sessionsDir, (_eventType, filename) => {
        if (typeof filename === 'string' && filename.endsWith('.json')) {
          this.fileCache.delete(filename);
        }
        this.scheduleScan();
      });
      // fs.watch() is an EventEmitter: an unhandled 'error' event (ENOSPC when
      // the inotify watcher limit is hit, EBADF when the watched dir is
      // deleted/renamed — both common when hermit-bridge rebuilds sessions)
      // would crash the whole server as an uncaughtException. Drop the handle
      // and let the watchdog interval re-attach on the next scan.
      this.fsWatcher.on('error', (error) => {
        if (!isIgnorableFsError(error)) {
          console.error('[ImLiveWatcher] fs.watch error', error);
        }
        try {
          this.fsWatcher?.close();
        } catch {
          /* best effort */
        }
        this.fsWatcher = null;
      });
    } catch (error) {
      // Dir not present yet — the watchdog interval will re-scan and re-attach
      // once hermit-bridge creates it (see the self-heal branch in scan()).
      if (!isIgnorableFsError(error)) {
        console.error('[ImLiveWatcher] Failed to attach filesystem watcher', error);
      }
      this.fsWatcher = null;
    }
  }

  private scheduleScan(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.scan();
    }, this.debounceMs);
  }

  /** Read every `*.json` in the dir, detect live workers, emit them. */
  async scan(): Promise<void> {
    this.scanQueued = true;
    if (this.scanInFlight) {
      return this.scanInFlight;
    }

    this.scanInFlight = (async () => {
      while (this.scanQueued) {
        this.scanQueued = false;
        await this.scanOnce();
      }
    })().finally(() => {
      this.scanInFlight = null;
    });

    return this.scanInFlight;
  }

  private async scanOnce(): Promise<void> {
    let files: string[];
    try {
      files = await fsp.readdir(this.sessionsDir);
    } catch (error) {
      // Dir missing/unreadable → no IM workers exist right now.
      this.fileCache.clear();
      if (!isIgnorableFsError(error)) {
        console.error('[ImLiveWatcher] Failed to read sessions directory', error);
      }
      this.emit([]);
      return;
    }

    // Self-heal: if the dir (re)appeared after we failed to attach fs.watch,
    // attach now so changes are picked up instantly instead of on the watchdog.
    if (this.running && !this.fsWatcher) this.attachFsWatch();

    const jsonFiles = files.filter((file) => file.endsWith('.json'));
    const liveFiles = new Set(jsonFiles);
    for (const cachedFile of this.fileCache.keys()) {
      if (!liveFiles.has(cachedFile)) this.fileCache.delete(cachedFile);
    }

    const stores: ParsedHermitBridgeStore[] = [];
    for (const file of jsonFiles) {
      const store = await this.readStoreFromCache(file);
      if (store) stores.push(store);
    }

    this.emit(detectImWorkers(stores, this.now()));
  }

  private async readStoreFromCache(file: string): Promise<ParsedHermitBridgeStore | null> {
    const filePath = path.join(this.sessionsDir, file);

    let stats;
    try {
      stats = await fsp.stat(filePath);
    } catch (error) {
      console.error('[ImLiveWatcher] Failed to stat session store', filePath, error);
      this.fileCache.delete(file);
      return null;
    }

    const cached = this.fileCache.get(file);
    if (
      cached?.mtimeMs === stats.mtimeMs &&
      cached.ctimeMs === stats.ctimeMs &&
      cached.size === stats.size
    ) {
      return cached.store;
    }

    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      const parsed = parseHermitBridgeSessions(JSON.parse(raw), file);
      const postReadStats = await fsp.stat(filePath);
      if (
        postReadStats.mtimeMs === stats.mtimeMs &&
        postReadStats.ctimeMs === stats.ctimeMs &&
        postReadStats.size === stats.size
      ) {
        this.fileCache.set(file, {
          mtimeMs: postReadStats.mtimeMs,
          ctimeMs: postReadStats.ctimeMs,
          size: postReadStats.size,
          store: parsed,
        });
        return parsed;
      }

      this.fileCache.delete(file);
      this.scanQueued = true;
      return null;
    } catch {
      // Skip unreadable / corrupt / partially-written files — next scan retries.
      this.fileCache.delete(file);
      return null;
    }
  }

  stop(): void {
    this.running = false;
    this.fsWatcher?.close();
    this.fsWatcher = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
