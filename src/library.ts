// Loads everything curation needs, reusing the session cache where possible.
// Genres and keys are enrichment: they load after the core library and failures
// there degrade to "no genre/key playlists" instead of breaking the page. Once a
// lookup returns or its signal aborts, late results are dropped and not cached.

import type { ArtistGenreMatch, ArtistToMatch, LookupProgress, MusicBrainzClient } from './musicbrainz';
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
const MB_ARTISTS_KEY = 'musicbrainz.artists';
const MB_GENRE_NAMES_KEY = 'musicbrainz.genres';
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

/** Saves keys found so far, e.g. after the owner stopped a lookup. */
export function saveKeys(cache: SessionCache, keys: Record<string, TrackKey | null>): void {
  cache.set(KEYS_KEY, keys);
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

/**
 * Artists on liked tracks not yet looked up on MusicBrainz, most-liked first, each with
 * an ISRC from a liked track (preferring one where they are the primary artist).
 */
export function artistsToMatch(liked: LikedTrack[], known: Record<string, unknown>): ArtistToMatch[] {
  const info = new Map<string, { name: string; isrc?: string; primaryIsrc?: string }>();
  for (const t of liked) {
    t.artists.forEach((a, i) => {
      if (a.id in known) return;
      const entry = info.get(a.id) ?? { name: a.name };
      if (t.isrc) {
        entry.isrc ??= t.isrc;
        if (i === 0) entry.primaryIsrc ??= t.isrc;
      }
      info.set(a.id, entry);
    });
  }
  return artistsToLookUp(liked, known).map((id) => {
    const e = info.get(id) as { name: string; isrc?: string; primaryIsrc?: string };
    const isrc = e.primaryIsrc ?? e.isrc;
    return isrc ? { id, name: e.name, isrc } : { id, name: e.name };
  });
}

/** Genres per Spotify artist from MusicBrainz matches. */
export function musicBrainzGenres(matches: Record<string, ArtistGenreMatch>): Record<string, string[]> {
  const genres: Record<string, string[]> = {};
  for (const [id, m] of Object.entries(matches)) if (m.genres.length > 0) genres[id] = m.genres;
  return genres;
}

/** Cached MusicBrainz matches (from an earlier lookup in this browser), or {}. */
export function cachedMusicBrainz(cache: SessionCache): Record<string, ArtistGenreMatch> {
  return cache.get<Record<string, ArtistGenreMatch>>(MB_ARTISTS_KEY) ?? {};
}

export async function loadMusicBrainz(
  mb: MusicBrainzClient,
  liked: LikedTrack[],
  cache: SessionCache,
  onProgress: (progress: LookupProgress, data: Record<string, ArtistGenreMatch>) => void,
  signal?: AbortSignal,
): Promise<EnrichmentResult<ArtistGenreMatch>> {
  const merged = { ...cachedMusicBrainz(cache) };
  const missing = artistsToMatch(liked, merged);
  let stopped = false;
  try {
    let genreNames = cache.get<string[]>(MB_GENRE_NAMES_KEY);
    if (missing.length > 0 && !genreNames) {
      genreNames = await mb.getGenreNames(signal);
      if (!signal?.aborted) cache.set(MB_GENRE_NAMES_KEY, genreNames);
    }
    await mb.findArtistGenres(missing, new Set(genreNames ?? []), (results, progress) => {
      if (stopped || signal?.aborted) return;
      Object.assign(merged, results);
      cache.set(MB_ARTISTS_KEY, merged);
      onProgress(progress, { ...merged });
    }, signal);
    return { data: merged };
  } catch (err) {
    return { data: merged, error: signal?.aborted ? undefined : (err as Error).message };
  } finally {
    stopped = true;
  }
}
