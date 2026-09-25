// Session-scoped cache for fetched library data, so a page reload does not refetch
// ~4000 liked songs. Lives in sessionStorage only: cleared when the tab closes,
// never written to disk by the app. Every access tolerates a missing or full store.
// The same class over localStorage (`browserCache()`) keeps the slow MusicBrainz
// genre lookups across tabs; signing out clears both.

const PREFIX = 'curator.cache.v1.';

export class SessionCache {
  constructor(private readonly storage: Storage | null = safeSessionStorage()) {}

  get<T>(key: string): T | null {
    try {
      const raw = this.storage?.getItem(PREFIX + key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    try {
      this.storage?.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage disabled: the data just is not cached.
    }
  }

  clear(): void {
    try {
      if (!this.storage) return;
      const keys: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(PREFIX)) keys.push(key);
      }
      for (const key of keys) this.storage.removeItem(key);
    } catch {
      // Nothing cached to clear.
    }
  }
}

/** A cache that outlives the tab, for public lookups that are slow to redo. */
export function browserCache(): SessionCache {
  let storage: Storage | null = null;
  try {
    storage = typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage disabled: nothing is cached.
  }
  return new SessionCache(storage);
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
