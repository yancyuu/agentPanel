import { get, set } from 'idb-keyval';

const IDB_KEY = 'task-activity-read-state-v1';
const LS_KEY = 'task-activity-read-state-v1';
const REMOTE_ENDPOINT = '/api/workbench/comment-read-state';
const SAVE_DEBOUNCE_MS = 300;
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * 任务动态（deliveries/feedbackItems）的已读位置：按任务记录已见的动态条目 id。
 * 未读是投影（未读 = 已读位置），不落任何任务数据。
 */
interface TaskReadEntry {
  readIds: string[];
  lastUpdated: number;
}

type ReadState = Record<string, TaskReadEntry>; // key = "teamName/taskId"

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

// Synchronous init from localStorage — guarantees first render sees read state
let cache: ReadState = lsLoad() ?? {};

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

/** Mark specific activity item IDs as read for a given team/task. */
export function markActivityRead(teamName: string, taskId: string, activityIds: string[]): void {
  if (activityIds.length === 0) return;
  const key = buildTaskKey(teamName, taskId);
  const prev = cache[key];
  const prevSet = new Set(prev?.readIds ?? []);
  let changed = false;
  for (const id of activityIds) {
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

/** Count unread activity items for a task (an item is unread when its id is not in readIds). */
export function getUnreadCount(
  readState: ReadState,
  teamName: string,
  taskId: string,
  items: { id?: string; createdAt: string }[]
): number {
  if (!items || items.length === 0) return 0;
  const key = buildTaskKey(teamName, taskId);
  const entry = readState[key];
  if (!entry) return items.length;
  const readSet = new Set(entry.readIds);
  let count = 0;
  for (const item of items) {
    if (item.id && readSet.has(item.id)) continue;
    count++;
  }
  return count;
}

/** Get the set of read activity IDs for a team/task pair. */
export function getReadActivityIds(teamName: string, taskId: string): Set<string> {
  const key = buildTaskKey(teamName, taskId);
  const entry = cache[key];
  return new Set(entry?.readIds ?? []);
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
      const stored = await get<ReadState>(IDB_KEY);
      if (stored && typeof stored === 'object') {
        cache = mergeReadState(cache, stored);
        notify();
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
  lsSave(cache);
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

  cache = result;
  notify();

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
