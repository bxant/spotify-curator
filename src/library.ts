// Loads everything curation needs, reusing the session cache where possible.
// Genres and keys are enrichment: they load after the core library and failures
// there degrade to "no genre/key playlists" instead of breaking the page. Once a
// lookup returns or its signal aborts, late results are dropped and not cached.

import type { ReccoBeatsClient } from './reccobeats';
import type { SessionCache } from './session-cache';
import type { SpotifyClient, UserProfile } from './spotify';
import type { LikedTrack, ListeningHistory, TrackKey } from './types';

export interface LibrarySnapshot {
  profile: UserProfile;
  liked: LikedTrack[];
  history: ListeningHistory;
  fetchedAt: string;
}

export interface EnrichmentResult<T> {
  data: Record<string, T>;
  /** Set when the lookup stopped early; `data` then holds what was fetched. */
  error?: string;
}

const LIBRARY_KEY = 'library';
const GENRES_KEY = 'genres';
const KEYS_KEY = 'keys';
/** Persist partial enrichment progress this often so a reload resumes. */
const SAVE_EVERY = 100;

export async function loadLibrary(
  client: SpotifyClient,
  cache: SessionCache,
  onProgress: (message: string) => void,
  force = false,
): Promise<LibrarySnapshot> {
  const cached = force ? null : cache.get<LibrarySnapshot>(LIBRARY_KEY);
  if (cached) return cached;

  onProgress('Loading your Spotify profile…');
  const profile = await client.getCurrentUser();
  onProgress('Loading Liked Songs…');
  const liked = await client.getLikedTracks((loaded, total) =>
    onProgress(`Loading Liked Songs… ${loaded} / ${total}`),
  );
  onProgress('Loading your top tracks, top artists and recent plays…');
  const { history, topArtistGenres } = await client.getListeningHistory();

  // Top artists arrive with genres already, which saves single-artist lookups later.
  cache.set(GENRES_KEY, { ...(cache.get<Record<string, string[]>>(GENRES_KEY) ?? {}), ...topArtistGenres });
  const snapshot: LibrarySnapshot = { profile, liked, history, fetchedAt: new Date().toISOString() };
  cache.set(LIBRARY_KEY, snapshot);
  return snapshot;
}

/** Artists on liked tracks without known genres, most-liked first. */
export function artistsToLookUp(liked: LikedTrack[], known: Record<string, unknown>): string[] {
  const counts = new Map<string, number>();
  for (const t of liked) {
    for (const a of t.artists) if (!(a.id in known)) counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

export async function loadGenres(
  client: SpotifyClient,
  liked: LikedTrack[],
  cache: SessionCache,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<EnrichmentResult<string[]>> {
  const known = cache.get<Record<string, string[]>>(GENRES_KEY) ?? {};
  const missing = artistsToLookUp(liked, known);
  const merged = { ...known };
  let stopped = false;
  try {
    await client.getArtistGenres(missing, (done, total, genres) => {
      if (stopped || signal?.aborted) return;
      Object.assign(merged, genres);
      if (done % SAVE_EVERY === 0) cache.set(GENRES_KEY, merged);
      onProgress(done, total);
    }, signal);
    return { data: merged };
  } catch (err) {
    return { data: merged, error: (err as Error).message };
  } finally {
    stopped = true;
    if (!signal?.aborted) cache.set(GENRES_KEY, merged);
  }
}

export async function loadKeys(
  recco: ReccoBeatsClient,
  liked: LikedTrack[],
  cache: SessionCache,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<EnrichmentResult<TrackKey | null>> {
  const known = cache.get<Record<string, TrackKey | null>>(KEYS_KEY) ?? {};
  const missing = liked.map((t) => t.id).filter((id) => !(id in known));
  const merged = { ...known };
  let stopped = false;
  try {
    await recco.getTrackKeys(missing, (done, total, keys) => {
      if (stopped || signal?.aborted) return;
      Object.assign(merged, keys);
      if (done % (SAVE_EVERY * 4) === 0) cache.set(KEYS_KEY, merged);
      onProgress(done, total);
    }, signal);
    return { data: merged };
  } catch (err) {
    return { data: merged, error: (err as Error).message };
  } finally {
    stopped = true;
    if (!signal?.aborted) cache.set(KEYS_KEY, merged);
  }
}
