// Remembers which suggested playlists were created in Spotify this session, and
// which are still being created, independent of page re-renders. A finished entry
// only counts while the suggestion still has the exact tracks it was created from.

import type { SessionCache } from './session-cache';
import type { CreatedPlaylist } from './spotify';

const CREATED_KEY = 'created';

type CreatedEntry = CreatedPlaylist & { signature: string };

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
    const entry = this.finished()[key];
    if (entry?.signature === signature) {
      const { signature: _, ...playlist } = entry;
      return { kind: 'created', playlist };
    }
    return { kind: 'idle', error: this.errors.get(key) };
  }

  /** Starts a creation unless one for `key` is already running. */
  async create(
    key: string,
    signature: string,
    run: (onProgress: (message: string) => void) => Promise<CreatedPlaylist>,
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
      if (epoch === this.epoch) this.cache.set(CREATED_KEY, { ...this.finished(), [key]: { ...playlist, signature } });
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

  private finished(): Record<string, CreatedEntry> {
    return this.cache.get<Record<string, CreatedEntry>>(CREATED_KEY) ?? {};
  }
}
