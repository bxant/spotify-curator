// Tracks the owner removed from recommended playlists, per playlist key, for the
// session (sessionStorage via SessionCache), so removals survive Back and reload.
// Every view of a playlist (card, page, Create in Spotify) uses the edited list;
// removing or restoring a track changes its signature, so a created playlist whose
// tracks changed offers Create again.

import type { SessionCache } from './session-cache';
import type { CuratedPlaylist } from './types';

const REMOVED_KEY = 'removed';

export class RemovedStore {
  constructor(private readonly cache: SessionCache) {}

  /** Removed track IDs of a playlist, in the order they were removed. */
  removed(key: string): string[] {
    const ids = this.all()[key];
    return Array.isArray(ids) ? ids : [];
  }

  remove(key: string, trackId: string): void {
    const ids = this.removed(key);
    if (!ids.includes(trackId)) this.save(key, [...ids, trackId]);
  }

  restore(key: string, trackId: string): void {
    this.save(key, this.removed(key).filter((id) => id !== trackId));
  }

  restoreAll(key: string): void {
    this.save(key, []);
  }

  /** The playlist without its removed tracks (the same object when nothing was removed). */
  apply(p: CuratedPlaylist): CuratedPlaylist {
    const ids = new Set(this.removed(p.key));
    if (!p.tracks.some((t) => ids.has(t.id))) return p;
    return { ...p, tracks: p.tracks.filter((t) => !ids.has(t.id)) };
  }

  private all(): Record<string, string[]> {
    return this.cache.get<Record<string, string[]>>(REMOVED_KEY) ?? {};
  }

  private save(key: string, ids: string[]): void {
    const { [key]: _, ...rest } = this.all();
    this.cache.set(REMOVED_KEY, ids.length > 0 ? { ...rest, [key]: ids } : rest);
  }
}
