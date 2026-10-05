// Loads everything curation needs. The library (profile, likes, listening history) lives
// in the session cache. Keys and genres are enrichment from outside lookups that start on
// their own once the library is in (see src/enrich.ts); their results are kept in a
// persistent browser cache, so later visits only look up new songs and artists. Failures
// there degrade to "fewer genre/key playlists" instead of breaking the page. Once a lookup
// returns or its signal aborts, late results are dropped and not cached.

import type { ArtistGenreMatch, ArtistToMatch, MusicBrainzClient } from './musicbrainz';
import type { ReccoBeatsClient } from './reccobeats';
import type { SessionCache } from './session-cache';
import type { SpotifyClient, UserProfile } from './spotify';
import type { LikedTrack, ListeningHistory, TrackKey } from './types';
import type { WikidataArtist, WikidataClient } from './wikidata';

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

/** Cache keys of the enrichment results (in the persistent lookup cache). */
export const GENRES_KEY = 'genres';
export const KEYS_KEY = 'keys';
export const WIKIDATA_KEY = 'wikidata.artists';
export const MB_ARTISTS_KEY = 'musicbrainz.artists';
export const MB_GENRE_NAMES_KEY = 'musicbrainz.genres';
const LIBRARY_KEY = 'library';
/** Persist partial enrichment progress this often so a reload resumes. */
const SAVE_EVERY = 100;

export async function loadLibrary(
  client: SpotifyClient,
  cache: SessionCache,
  onProgress: (message: string) => void,
  force = false,
  /** Where Spotify artist genres are kept (the persistent lookup cache in the page). */
  genreCache: SessionCache = cache,
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
  genreCache.set(GENRES_KEY, { ...(genreCache.get<Record<string, string[]>>(GENRES_KEY) ?? {}), ...topArtistGenres });
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

/**
 * Spotify genres for artists not looked up yet, most-liked first. Artists for which `skip`
 * returns true when their turn comes (another source found their genres) are not requested.
 */
export async function loadGenres(
  client: SpotifyClient,
  liked: LikedTrack[],
  cache: SessionCache,
  onData: (genres: Record<string, string[]>) => void,
  signal?: AbortSignal,
  skip?: (artistId: string) => boolean,
): Promise<EnrichmentResult<string[]>> {
  const known = cache.get<Record<string, string[]>>(GENRES_KEY) ?? {};
  const missing = artistsToLookUp(liked, known);
  const merged = { ...known };
  let stopped = false;
  try {
    await client.getArtistGenres(missing, (done, _total, genres) => {
      if (stopped || signal?.aborted) return;
      Object.assign(merged, genres);
      if (done % SAVE_EVERY === 0) cache.set(GENRES_KEY, merged);
      onData(merged);
    }, signal, undefined, skip);
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
  onData: (keys: Record<string, TrackKey | null>) => void,
  signal?: AbortSignal,
): Promise<EnrichmentResult<TrackKey | null>> {
  const known = cache.get<Record<string, TrackKey | null>>(KEYS_KEY) ?? {};
  const missing = liked.map((t) => t.id).filter((id) => !(id in known));
  const merged = { ...known };
  let stopped = false;
  try {
    await recco.getTrackKeys(missing, (done, _total, keys) => {
      if (stopped || signal?.aborted) return;
      Object.assign(merged, keys);
      if (done % (SAVE_EVERY * 4) === 0) cache.set(KEYS_KEY, merged);
      onData(merged);
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
 * Artists on liked tracks not yet looked up on MusicBrainz, or found unmatched when they had
 * fewer liked songs than now, most-liked first, each with their liked-song count, an ISRC
 * from a liked track (preferring one where they are the primary artist) and the MusicBrainz
 * ID Wikidata has for them, if any.
 */
export function artistsToMatch(
  liked: LikedTrack[],
  known: Record<string, ArtistGenreMatch>,
  mbids: Record<string, string> = {},
): ArtistToMatch[] {
  const info = new Map<string, { name: string; tracks: number; isrc?: string; primaryIsrc?: string }>();
  for (const t of liked) {
    t.artists.forEach((a, i) => {
      const entry = info.get(a.id) ?? { name: a.name, tracks: 0 };
      entry.tracks++;
      if (t.isrc) {
        entry.isrc ??= t.isrc;
        if (i === 0) entry.primaryIsrc ??= t.isrc;
      }
      info.set(a.id, entry);
    });
  }
  const settled = Object.fromEntries(
    Object.entries(known).filter(([id, m]) => m.tracks === undefined || (info.get(id)?.tracks ?? 0) <= m.tracks),
  );
  return artistsToLookUp(liked, settled).map((id) => {
    const e = info.get(id) as { name: string; tracks: number; isrc?: string; primaryIsrc?: string };
    const isrc = e.primaryIsrc ?? e.isrc;
    return { id, name: e.name, tracks: e.tracks, ...(isrc ? { isrc } : {}), ...(mbids[id] ? { mbid: mbids[id] } : {}) };
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

/** MusicBrainz' genre names, fetched once per browser; null when MusicBrainz is unreachable. */
export async function loadGenreNames(mb: MusicBrainzClient, cache: SessionCache, signal?: AbortSignal): Promise<string[] | null> {
  const cached = cache.get<string[]>(MB_GENRE_NAMES_KEY);
  if (cached) return cached;
  try {
    const names = await mb.getGenreNames(signal);
    if (!signal?.aborted) cache.set(MB_GENRE_NAMES_KEY, names);
    return names;
  } catch {
    return null;
  }
}

/**
 * MusicBrainz genres for artists not looked up there yet, most-liked first. Artists for
 * which `skip` returns true are left out (see `MusicBrainzClient.findArtistGenres`).
 */
export async function loadMusicBrainz(
  mb: MusicBrainzClient,
  liked: LikedTrack[],
  cache: SessionCache,
  genreNames: string[],
  onData: (data: Record<string, ArtistGenreMatch>) => void,
  signal?: AbortSignal,
  options: { mbids?: Record<string, string>; skip?: (artistId: string) => boolean } = {},
): Promise<EnrichmentResult<ArtistGenreMatch>> {
  const merged = { ...cachedMusicBrainz(cache) };
  const skip = options.skip ?? (() => false);
  const missing = artistsToMatch(liked, merged, options.mbids).filter((a) => !skip(a.id));
  let stopped = false;
  try {
    await mb.findArtistGenres(missing, new Set(genreNames), (results) => {
      if (stopped || signal?.aborted) return;
      Object.assign(merged, results);
      cache.set(MB_ARTISTS_KEY, merged);
      onData(merged);
    }, signal, skip);
    return { data: merged };
  } catch (err) {
    return { data: merged, error: signal?.aborted ? undefined : (err as Error).message };
  } finally {
    stopped = true;
  }
}

/** Cached Wikidata answers (from an earlier lookup in this browser), or {}. */
export function cachedWikidata(cache: SessionCache): Record<string, WikidataArtist> {
  return cache.get<Record<string, WikidataArtist>>(WIKIDATA_KEY) ?? {};
}

/** Wikidata answers for artists not looked up there yet, a few hundred per query. */
export async function loadWikidata(
  wikidata: WikidataClient,
  liked: LikedTrack[],
  cache: SessionCache,
  onData: (data: Record<string, WikidataArtist>) => void,
  signal?: AbortSignal,
): Promise<EnrichmentResult<WikidataArtist>> {
  const merged = { ...cachedWikidata(cache) };
  const missing = artistsToLookUp(liked, merged);
  let stopped = false;
  try {
    await wikidata.findArtists(missing, (results) => {
      if (stopped || signal?.aborted) return;
      Object.assign(merged, results);
      cache.set(WIKIDATA_KEY, merged);
      onData(merged);
    }, signal);
    return { data: merged };
  } catch (err) {
    return { data: merged, error: signal?.aborted ? undefined : (err as Error).message };
  } finally {
    stopped = true;
  }
}
