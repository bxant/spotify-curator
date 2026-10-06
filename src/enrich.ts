// Background enrichment: musical keys and artist genres, looked up on their own as soon as
// the library is loaded. Playlists that need neither are ready right away; key and genre
// playlists appear and fill in as results arrive.
//
// Two lanes run side by side, each walking the library until every song is covered:
// - keys: ReccoBeats, 40 track IDs per request (src/reccobeats.ts);
// - genres: Wikidata first (hundreds of artists per query, src/wikidata.ts), then, for
//   artists still without genres and most-liked first, MusicBrainz (src/musicbrainz.ts) and
//   Spotify's single-artist lookups at the same time. Each skips an artist another source
//   has found genres for by the time its turn comes.
// Results are cached per track or artist (see src/library.ts), so a later run only looks up
// new songs and artists.
//
// The functions at the top are pure (merging the sources, counting progress) and unit
// tested; `runEnrichment` drives the clients.

import {
  GENRES_KEY,
  KEYS_KEY,
  MB_GENRE_NAMES_KEY,
  cachedMusicBrainz,
  cachedWikidata,
  loadGenreNames,
  loadGenres,
  loadKeys,
  loadMusicBrainz,
  loadWikidata,
  type EnrichmentResult,
} from './library';
import type { ArtistGenreMatch, MusicBrainzClient } from './musicbrainz';
import type { ReccoBeatsClient } from './reccobeats';
import type { SessionCache } from './session-cache';
import type { SpotifyClient } from './spotify';
import type { LikedTrack, TrackKey } from './types';
import { genreIndex, wikidataGenres, type GenreIndex, type WikidataArtist, type WikidataClient } from './wikidata';

export interface EnrichmentData {
  keys: Record<string, TrackKey | null>;
  /** Genres Spotify returned per artist ([] when none). */
  spotify: Record<string, string[]>;
  wikidata: Record<string, WikidataArtist>;
  musicBrainz: Record<string, ArtistGenreMatch>;
  /**
   * MusicBrainz' genre list, which Wikidata labels are matched against. Until it is known
   * (undefined) Wikidata genres are held back, so a genre is not first shown under a
   * different name; null when MusicBrainz is unreachable, and labels are used as they are.
   */
  genreNames?: string[] | null;
}

/** running → done; `errors` lists lookups that stopped early, so the lane is partial. */
export interface Lane {
  state: 'running' | 'done' | 'stopped';
  errors: string[];
}

export interface EnrichmentStatus {
  keys: Lane;
  genres: Lane;
}

export interface EnrichmentProgress {
  /** Distinct liked songs. */
  songs: number;
  /** Songs whose key and genres every source has answered for (or, once a lane is done, will not). */
  settled: number;
  withKey: number;
  withGenres: number;
}

export function cachedEnrichment(cache: SessionCache): EnrichmentData {
  return {
    keys: cache.get<Record<string, TrackKey | null>>(KEYS_KEY) ?? {},
    spotify: cache.get<Record<string, string[]>>(GENRES_KEY) ?? {},
    wikidata: cachedWikidata(cache),
    musicBrainz: cachedMusicBrainz(cache),
    genreNames: cache.get<string[]>(MB_GENRE_NAMES_KEY) ?? undefined,
  };
}

const indexes = new WeakMap<string[], GenreIndex>();

/** The genre list's index, built once per list since progress and curation ask for it often. */
function indexOf(names: string[] | null): GenreIndex | null {
  if (names === null) return null;
  let index = indexes.get(names);
  if (!index) indexes.set(names, (index = genreIndex(names)));
  return index;
}

/** Wikidata and MusicBrainz genres per artist, in MusicBrainz' genre names. */
export function openGenres(data: EnrichmentData): Record<string, string[]> {
  const genres: Record<string, string[]> = {};
  const wikidata = data.genreNames === undefined ? {} : data.wikidata;
  const index = data.genreNames === undefined ? null : indexOf(data.genreNames);
  for (const [id, artist] of Object.entries(wikidata)) {
    const names = wikidataGenres(artist.labels, index);
    if (names.length > 0) genres[id] = names;
  }
  for (const [id, match] of Object.entries(data.musicBrainz)) {
    if (match.genres.length > 0) genres[id] = [...new Set([...(genres[id] ?? []), ...match.genres])];
  }
  return genres;
}

/**
 * Adds results another tab saved to the shared lookup cache while this tab waited for its
 * turn (see src/musicians-corner/shared-lookups.ts); what this tab already has is kept.
 */
export function mergeEnrichment(data: EnrichmentData, saved: EnrichmentData): void {
  data.keys = { ...saved.keys, ...data.keys };
  data.spotify = { ...saved.spotify, ...data.spotify };
  data.wikidata = { ...saved.wikidata, ...data.wikidata };
  data.musicBrainz = { ...saved.musicBrainz, ...data.musicBrainz };
  data.genreNames ??= saved.genreNames;
}

/** Whether the key lookup has answered (with a key or null) for every liked song. */
export function keysCovered(liked: LikedTrack[], keys: Record<string, TrackKey | null>): boolean {
  return liked.every((t) => t.id in keys);
}

/** Whether any source has genres for the artist. */
export function genresFound(data: EnrichmentData, index: GenreIndex | null, artistId: string): boolean {
  if ((data.spotify[artistId]?.length ?? 0) > 0) return true;
  if ((data.musicBrainz[artistId]?.genres.length ?? 0) > 0) return true;
  const wd = data.wikidata[artistId];
  return !!wd && data.genreNames !== undefined && wikidataGenres(wd.labels, index).length > 0;
}

export function enrichmentProgress(liked: LikedTrack[], data: EnrichmentData, status: EnrichmentStatus): EnrichmentProgress {
  const index = data.genreNames === undefined ? null : indexOf(data.genreNames);
  // A stopped lane still owes answers; a finished one (even with errors) has given all it will.
  const keysOpen = status.keys.state !== 'done';
  const genresOpen = status.genres.state !== 'done';
  const artistInfo = new Map<string, { found: boolean; settled: boolean }>();
  const artist = (id: string) => {
    let info = artistInfo.get(id);
    if (!info) {
      const found = genresFound(data, index, id);
      // Without genres yet, an artist is settled once every source has answered for it.
      const settled = found || !genresOpen || (id in data.wikidata && id in data.musicBrainz && id in data.spotify);
      info = { found, settled };
      artistInfo.set(id, info);
    }
    return info;
  };

  const seen = new Set<string>();
  let settled = 0;
  let withKey = 0;
  let withGenres = 0;
  for (const t of liked) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const infos = t.artists.map((a) => artist(a.id));
    if (data.keys[t.id]) withKey++;
    if (infos.some((i) => i.found)) withGenres++;
    if ((!keysOpen || t.id in data.keys) && infos.every((i) => i.settled)) settled++;
  }
  return { songs: seen.size, settled, withKey, withGenres };
}

// ---------------------------------------------------------------------------
// Runner

export interface EnrichmentClients {
  spotify: SpotifyClient;
  reccoBeats: ReccoBeatsClient;
  wikidata: WikidataClient;
  musicBrainz: MusicBrainzClient;
}

/**
 * Runs both lanes until every song is covered or a signal aborts. `stop` (the owner's
 * Stop) ends the lanes as "stopped" and keeps what they found in `cache`; `teardown` (a
 * reload or sign-out) also stops them but writes nothing more to `cache`. `data` and
 * `status` are updated in place and `onChange` is called after every update, so callers
 * should coalesce redraws.
 */
export async function runEnrichment(
  liked: LikedTrack[],
  cache: SessionCache,
  clients: EnrichmentClients,
  data: EnrichmentData,
  status: EnrichmentStatus,
  onChange: () => void,
  signals: { teardown: AbortSignal; stop: AbortSignal },
): Promise<void> {
  const signal = AbortSignal.any([signals.teardown, signals.stop]);
  /** Saves results of a stopped lookup too, so the next run continues from there. */
  const save = (key: string, value: unknown) => {
    if (!signals.teardown.aborted) cache.set(key, value);
  };
  const finish = (lane: Lane, results: EnrichmentResult<unknown>[]) => {
    lane.state = signal.aborted ? 'stopped' : 'done';
    lane.errors = results.flatMap((r) => (r.error ? [r.error] : []));
    onChange();
  };

  const keys = async () => {
    const result = await loadKeys(clients.reccoBeats, liked, cache, (keys) => {
      data.keys = keys;
      onChange();
    }, signal);
    data.keys = result.data;
    save(KEYS_KEY, result.data);
    finish(status.keys, [{ ...result, error: result.error && `Musical keys (ReccoBeats): ${result.error}` }]);
  };

  const genres = async () => {
    const [names, wikidata] = await Promise.all([
      loadGenreNames(clients.musicBrainz, cache, signal).then((names) => {
        // A stopped lookup leaves the list unknown rather than "unavailable".
        if (!signal.aborted) data.genreNames = names;
        onChange();
        return names;
      }),
      loadWikidata(clients.wikidata, liked, cache, (wd) => {
        data.wikidata = wd;
        onChange();
      }, signal),
    ]);
    data.wikidata = wikidata.data;
    onChange();
    const wdError = wikidata.error && `Genres (Wikidata): ${wikidata.error}`;
    if (signal.aborted) return finish(status.genres, [{ data: {}, error: wdError }]);

    const index = indexOf(names);
    const skip = (id: string) => genresFound(data, index, id);
    const mbids: Record<string, string> = {};
    for (const [id, a] of Object.entries(data.wikidata)) if (a.mbid) mbids[id] = a.mbid;

    const musicBrainz: Promise<EnrichmentResult<unknown>> = names
      ? loadMusicBrainz(clients.musicBrainz, liked, cache, names, (mb) => {
          data.musicBrainz = mb;
          onChange();
        }, signal, { mbids, skip }).then((r) => {
          data.musicBrainz = r.data;
          return { ...r, error: r.error && `Genres (MusicBrainz): ${r.error}` };
        })
      : Promise.resolve({ data: {}, error: 'Genres (MusicBrainz): MusicBrainz is unreachable' });
    const spotify = loadGenres(clients.spotify, liked, cache, (genres) => {
      data.spotify = genres;
      onChange();
    }, signal, skip).then((r) => {
      data.spotify = r.data;
      save(GENRES_KEY, r.data);
      return { ...r, error: r.error && `Genres (Spotify): ${r.error}` };
    });
    finish(status.genres, [{ data: {}, error: wdError }, ...(await Promise.all([musicBrainz, spotify]))]);
  };

  await Promise.all([keys(), genres()]);
}
