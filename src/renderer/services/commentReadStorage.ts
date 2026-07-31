import { get, set } from 'idb-keyval';

const IDB_KEY = 'comment-read-state-v2';
const LS_KEY = 'comment-read-state-v2';
const LEGACY_IDB_KEY = 'comment-read-state';
const LEGACY_LS_KEY = 'comment-read-state';
const REMOTE_ENDPOINT = '/api/workbench/comment-read-state';
const SAVE_DEBOUNCE_MS = 300;
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Per-task read state: tracks individual comment IDs that have been seen.
 * `lastUpdated` is used for stale cleanup (prune entries older than 30 days).
 */
interface TaskReadEntry {
  readIds: string[];
  lastUpdated: number;
}

type ReadState = Record<string, TaskReadEntry>; // key = "teamName/taskId"

// Legacy format for migration (v1 stored a single timestamp per task)
type LegacyReadState = Record<string, number>;

// --- localStorage helpers ---
function lsLoad(): ReadState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ReadState;
  } catch {
    return null;
  }
}

function lsSave(state: ReadState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

function lsLoadLegacy(): LegacyReadState | null {
  try {
    const raw = localStorage.getItem(LEGACY_LS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // Verify it's the old format (values are numbers, not objects)
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length > 0 && typeof entries[0][1] === 'number') {
      return parsed as LegacyReadState;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Migrate legacy per-task timestamp to per-comment ID format.
 * Since we don't have comment IDs from the old format, we treat all
 * comments with timestamps <= the old lastRead as "read" by storing
 * a sentinel marker. The actual per-comment tracking starts fresh.
 */
function migrateLegacy(legacy: LegacyReadState): ReadState {
  const migrated: ReadState = {};
  for (const [key, timestamp] of Object.entries(legacy)) {
    if (typeof timestamp === 'number' && timestamp > 0) {
      // Store legacy timestamp as a sentinel — getUnreadCount will use it
      // for comments older than migration, and per-ID for newer ones.
      migrated[key] = {
        readIds: [],
        lastUpdated: timestamp,
      };
    }
  }
  return migrated;
}

// Synchronous init from localStorage — guarantees first render sees read state
let cache: ReadState = {};
const v2Data = lsLoad();
if (v2Data && Object.keys(v2Data).length > 0) {
  cache = v2Data;
} else {
  const legacyData = lsLoadLegacy();
  if (legacyData && Object.keys(legacyData).length > 0) {
    cache = migrateLegacy(legacyData);
  }
}

// Browser storage is scoped to the loopback origin (including its dynamic desktop port),
// so every renderer session also hydrates from the stable workbench-side store.
let loaded = false;
let loadingPromise: Promise<void> | null = null;
let idbAvailable = true; // flips to false on first IndexedDB failure
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const taskListeners = new Map<string, Set<() => void>>();

function buildTaskKey(teamName: string, taskId: string): string {
  return `${teamName}/${taskId}`;
}

function mergeReadState(base: ReadState, incoming: ReadState): ReadState {
  const merged = { ...base };
  for (const [key, entry] of Object.entries(incoming)) {
    if (!entry || !Array.isArray(entry.readIds) || typeof entry.lastUpdated !== 'number') continue;
    const previous = merged[key];
    if (!previous) {
      merged[key] = entry;
      continue;
    }
    merged[key] = {
      readIds: [...new Set([...previous.readIds, ...entry.readIds])],
      lastUpdated: Math.max(previous.lastUpdated, entry.lastUpdated),
    };
  }
  return merged;
}

async function loadRemoteState(): Promise<ReadState | null> {
  if (typeof fetch === 'undefined') return null;
  try {
    const response = await fetch(REMOTE_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const payload = (await response.json()) as { state?: unknown };
    if (!payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state))
      return null;
    return payload.state as ReadState;
  } catch {
    return null;
  }
}

function saveRemoteState(state: ReadState): void {
  if (typeof fetch === 'undefined') return;
  void fetch(REMOTE_ENDPOINT, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
    keepalive: true,
  }).catch(() => undefined);
}

// --- useSyncExternalStore API ---
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!loaded) void load();
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeTask(teamName: string, taskId: string, listener: () => void): () => void {
  const key = buildTaskKey(teamName, taskId);
  let listenersForTask = taskListeners.get(key);
  if (!listenersForTask) {
    listenersForTask = new Set();
    taskListeners.set(key, listenersForTask);
  }
  listenersForTask.add(listener);
  if (!loaded) void load();
  return () => {
    listenersForTask?.delete(listener);
    if (listenersForTask?.size === 0) {
      taskListeners.delete(key);
    }
  };
}

export function getSnapshot(): ReadState {
  return cache;
}

export function getTaskSnapshot(teamName: string, taskId: string): TaskReadEntry | undefined {
  return cache[buildTaskKey(teamName, taskId)];
}

// --- Mutations ---

/**
 * Mark specific comment IDs as read for a given team/task.
 */
export function markCommentsRead(teamName: string, taskId: string, commentIds: string[]): void {
  if (commentIds.length === 0) return;
  const key = buildTaskKey(teamName, taskId);
  const prev = cache[key];
  const prevSet = new Set(prev?.readIds ?? []);
  let changed = false;
  for (const id of commentIds) {
    if (!prevSet.has(id)) {
      prevSet.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  cache = {
    ...cache,
    [key]: {
      readIds: Array.from(prevSet),
      lastUpdated: Date.now(),
    },
  };
  lsSave(cache);
  saveRemoteState(cache);
  notify(key);
  scheduleSave();
}

/**
 * @deprecated Use markCommentsRead() instead. Kept for backward compatibility
 * with code that hasn't migrated yet (e.g. flush fallback).
 */
export function markAsRead(teamName: string, taskId: string, latestTimestamp: number): void {
  const key = buildTaskKey(teamName, taskId);
  const prev = cache[key];
  // Update lastUpdated to at least this timestamp (for legacy migration support)
  const prevLastUpdated = prev?.lastUpdated ?? 0;
  if (latestTimestamp <= prevLastUpdated && prev) return;
  cache = {
    ...cache,
    [key]: {
      readIds: prev?.readIds ?? [],
      lastUpdated: Math.max(prevLastUpdated, latestTimestamp),
    },
  };
  lsSave(cache);
  saveRemoteState(cache);
  notify(key);
  scheduleSave();
}

/**
 * Count unread comments for a task.
 * A comment is unread if its ID is NOT in the readIds set.
 *
 * Legacy migration: when readIds is empty (data migrated from v1 timestamp
 * format), comments created at or before the legacy cutoff are treated as read.
 * Once any per-ID tracking starts (readIds non-empty), the cutoff is ignored
 * — only explicit IDs determine read state. This prevents `lastUpdated`
 * (which is refreshed by markCommentsRead on every save for stale-cleanup
 * purposes) from accidentally marking ALL comments as read.
 */
export function getUnreadCount(
  readState: ReadState,
  teamName: string,
  taskId: string,
  comments: { id?: string; createdAt: string }[]
): number {
  if (!comments || comments.length === 0) return 0;
  const key = buildTaskKey(teamName, taskId);
  const entry = readState[key];
  if (!entry) return comments.length;

  const readSet = new Set(entry.readIds);
  // Only use the timestamp cutoff for pure-legacy entries (no per-ID tracking yet).
  // Once readIds is non-empty, per-ID tracking is authoritative and the timestamp
  // must NOT be used — it gets refreshed to Date.now() on every save.
  const legacyCutoff = readSet.size === 0 ? entry.lastUpdated : 0;

  let count = 0;
  for (const c of comments) {
    // If comment has an ID and it's in the read set → read
    if (c.id && readSet.has(c.id)) continue;
    // Legacy-only: comment created before/at the migration cutoff → read
    if (legacyCutoff > 0) {
      const ts = new Date(c.createdAt).getTime();
      if (ts <= legacyCutoff) continue;
    }
    // Otherwise → unread
    count++;
  }
  return count;
}

/**
 * Get the set of read comment IDs for a team/task pair.
 */
export function getReadCommentIds(teamName: string, taskId: string): Set<string> {
  const key = buildTaskKey(teamName, taskId);
  const entry = cache[key];
  return new Set(entry?.readIds ?? []);
}

/**
 * Get the legacy migration cutoff timestamp for a team/task pair (0 if none).
 * Returns non-zero only for pure-legacy entries where readIds is empty.
 * Once per-ID tracking has started (readIds non-empty), the cutoff is 0
 * because lastUpdated gets refreshed to Date.now() on every save and
 * would incorrectly mark all comments as read.
 */
export function getLegacyCutoff(teamName: string, taskId: string): number {
  const key = buildTaskKey(teamName, taskId);
  const entry = cache[key];
  if (!entry) return 0;
  // Only honour the timestamp when no per-ID tracking exists (pure legacy data).
  if (entry.readIds.length > 0) return 0;
  return entry.lastUpdated;
}

/** @deprecated Use getReadCommentIds() + getLegacyCutoff() instead. */
export function getLastReadTimestamp(teamName: string, taskId: string): number {
  const key = buildTaskKey(teamName, taskId);
  return cache[key]?.lastUpdated ?? 0;
}

// --- Internal ---
function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function notify(taskKey?: string): void {
  listeners.forEach((l) => l());
  if (!taskKey) {
    taskListeners.forEach((listenersForTask) => listenersForTask.forEach((l) => l()));
    return;
  }
  taskListeners.get(taskKey)?.forEach((l) => l());
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save();
  }, SAVE_DEBOUNCE_MS);
}

async function load(): Promise<void> {
  if (loaded) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = loadOnce().finally(() => {
    loadingPromise = null;
  });
  return loadingPromise;
}

async function loadOnce(): Promise<void> {
  const remoteState = await loadRemoteState();
  if (remoteState) {
    cache = mergeReadState(cache, remoteState);
    notify();
  }

  if (hasIndexedDB() && idbAvailable) {
    try {
      // Try v2 format first
      const stored = await get<ReadState>(IDB_KEY);
      if (stored && typeof stored === 'object') {
        cache = mergeReadState(cache, stored);
        notify();
      } else {
        // Try legacy IDB format
        const legacy = await get<LegacyReadState>(LEGACY_IDB_KEY);
        if (legacy && typeof legacy === 'object') {
          const migrated = migrateLegacy(legacy);
          cache = mergeReadState(cache, migrated);
          notify();
        }
      }
    } catch {
      idbAvailable = false;
    }
  }

  loaded = true;
  lsSave(cache);
  if (Object.keys(cache).length > 0) saveRemoteState(cache);
}

async function save(): Promise<void> {
  // Always write to localStorage (sync, reliable)
  lsSave(cache);

  // Also write to IndexedDB (async, primary)
  if (idbAvailable && hasIndexedDB()) {
    try {
      await set(IDB_KEY, cache);
    } catch {
      idbAvailable = false;
    }
  }
}

export async function cleanupStale(): Promise<void> {
  const now = Date.now();
  let changed = false;
  const result: ReadState = {};
  for (const [k, v] of Object.entries(cache)) {
    if (now - v.lastUpdated < STALE_THRESHOLD_MS) {
      result[k] = v;
    } else {
      changed = true;
    }
  }

  if (!changed) return;

  // Update in-memory cache
  cache = result;
  notify();

  // Persist to local browser storage and the stable workbench store.
  lsSave(result);
  saveRemoteState(result);
  if (idbAvailable && hasIndexedDB()) {
    try {
      await set(IDB_KEY, result);
    } catch {
      idbAvailable = false;
    }
  }
}
