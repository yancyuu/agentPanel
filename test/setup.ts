// vitest setup
//
// happy-dom 20.x does not expose a functional `localStorage`/`sessionStorage`
// global (the bare global is an empty object without Storage methods), so we
// provide an in-memory Web Storage implementation here. A large number of
// renderer tests rely on these globals being present and functional.
import { beforeEach } from 'vitest';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

function installStorage(name: 'localStorage' | 'sessionStorage'): void {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: storage,
  });
  if (typeof globalThis.window !== 'undefined') {
    Object.defineProperty(globalThis.window, name, {
      configurable: true,
      value: storage,
    });
  }
}

installStorage('localStorage');
installStorage('sessionStorage');

// Reset storage between tests so state does not leak across cases.
beforeEach(() => {
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
});
