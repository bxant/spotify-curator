// Remembers which suggested playlists were created in Spotify this session, and
// which are still being created, independent of page re-renders. A finished entry
// only counts for a card while the suggestion still has the exact tracks it was
// created from; every creation stays listed (see `all()`), so curating a different
// set never loses the link to a playlist already created.

import type { SessionCache } from './session-cache';
import type { CreatedPlaylist } from './spotify';

const CREATED_KEY = 'created';

type CreatedEntry = CreatedPlaylist & { signature: string; name?: string };

export interface CreatedRecord {
  key: string;
  name: string;
  playlist: CreatedPlaylist;
}

export type CreateStatus =
  | { kind: 'idle'; error?: string }
  | { kind: 'creating'; progress: string }
  | { kind: 'created'; playlist: CreatedPlaylist };

export class CreatedStore {
  private epoch = 0;
  private readonly inFlight = new Map<string, string>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly cache: SessionCache,
    private readonly onChange: (key: string) => void,
  ) {}

  status(key: string, signature: string): CreateStatus {
    const progress = this.inFlight.get(key);
    if (progress !== undefined) return { kind: 'creating', progress };
    const entry = this.entries(key).find((e) => e.signature === signature);
    if (entry) {
      return { kind: 'created', playlist: toPlaylist(entry) };
    }
    return { kind: 'idle', error: this.errors.get(key) };
  }

  /** Starts a creation unless one for `key` is already running. */
  async create(
    key: string,
    signature: string,
    run: (onProgress: (message: string) => void) => Promise<CreatedPlaylist>,
    name?: string,
  ): Promise<void> {
    if (this.inFlight.has(key)) return;
    const epoch = this.epoch;
    this.errors.delete(key);
    this.inFlight.set(key, 'Creating playlist…');
    this.onChange(key);
    try {
      const playlist = await run((message) => {
        this.inFlight.set(key, message);
        this.onChange(key);
      });
      if (epoch === this.epoch) {
        const entry: CreatedEntry = { ...playlist, signature, ...(name ? { name } : {}) };
        this.cache.set(CREATED_KEY, { ...this.finished(), [key]: [...this.entries(key), entry] });
      }
    } catch (err) {
      if (epoch === this.epoch) this.errors.set(key, err instanceof Error ? err.message : String(err));
    } finally {
      this.inFlight.delete(key);
      this.onChange(key);
    }
  }

  /** Forgets finished creations; creations still running will not be recorded. */
  reset(): void {
    this.epoch++;
    this.errors.clear();
    this.cache.set(CREATED_KEY, {});
  }

  /** Every playlist created this session, oldest first per suggestion. */
  all(): CreatedRecord[] {
    return Object.keys(this.finished()).flatMap((key) =>
      this.entries(key).map((e) => ({ key, name: e.name ?? key, playlist: toPlaylist(e) })),
    );
  }

  private entries(key: string): CreatedEntry[] {
    const value = this.finished()[key];
    // Sessions from before a suggestion could be created twice stored a single entry.
    return Array.isArray(value) ? value : value ? [value] : [];
  }

  private finished(): Record<string, CreatedEntry[] | CreatedEntry> {
    return this.cache.get<Record<string, CreatedEntry[] | CreatedEntry>>(CREATED_KEY) ?? {};
  }
}

function toPlaylist(entry: CreatedEntry): CreatedPlaylist {
  return { id: entry.id, uri: entry.uri, url: entry.url };
}
