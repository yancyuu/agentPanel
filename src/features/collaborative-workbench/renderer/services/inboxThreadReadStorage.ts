const STORAGE_KEY = 'hermit:inbox-thread-read-at';
const INITIALIZED_KEY = 'hermit:inbox-thread-read-initialized';
const CHANGE_EVENT = 'hermit:inbox-thread-read-change';

export type InboxThreadReadState = Record<string, number>;

let cachedRaw: string | null | undefined;
let cachedState: InboxThreadReadState = {};

export function getInboxThreadReadState(): InboxThreadReadState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedState;
    cachedRaw = raw;
    if (!raw) {
      cachedState = {};
      return cachedState;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    cachedState = Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0
      )
    );
  } catch {
    cachedState = {};
  }
  return cachedState;
}

export function isInboxThreadReadInitialized(): boolean {
  try {
    return localStorage.getItem(INITIALIZED_KEY) === '1';
  } catch {
    return false;
  }
}

export function initializeInboxThreadReadState(
  threads: readonly { key: string; updatedAt: string }[]
): void {
  if (isInboxThreadReadInitialized()) return;
  const current = getInboxThreadReadState();
  const next = { ...current };
  for (const thread of threads) {
    const readAt = Date.parse(thread.updatedAt);
    if (!thread.key || !Number.isFinite(readAt) || readAt <= 0) continue;
    next[thread.key] = Math.max(next[thread.key] ?? 0, readAt);
  }
  try {
    const raw = JSON.stringify(next);
    localStorage.setItem(STORAGE_KEY, raw);
    localStorage.setItem(INITIALIZED_KEY, '1');
    cachedRaw = raw;
    cachedState = next;
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Initial read migration is best-effort and must never block the inbox.
  }
}

export function markInboxThreadRead(threadKey: string, readAt: number): void {
  if (!threadKey || !Number.isFinite(readAt) || readAt <= 0) return;
  const current = getInboxThreadReadState();
  if ((current[threadKey] ?? 0) >= readAt) return;
  const next = { ...current, [threadKey]: readAt };
  try {
    const raw = JSON.stringify(next);
    localStorage.setItem(STORAGE_KEY, raw);
    cachedRaw = raw;
    cachedState = next;
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Read markers are best-effort and must never block the inbox.
  }
}

export function subscribeInboxThreadRead(listener: () => void): () => void {
  const handleStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY) {
      cachedRaw = undefined;
      listener();
    }
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', handleStorage);
  };
}
