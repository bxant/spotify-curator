// Artist genres from MusicBrainz (https://musicbrainz.org), a free, open music database
// with no API key. Spotify's artist `genres` is deprecated for new apps and often empty,
// and Wikidata (src/wikidata.ts) only knows some artists, so this is the fallback for
// artists still without genres.
//
// Artists Wikidata links to MusicBrainz need no matching. The others are matched by ISRC
// first (the recording codes Spotify reports for liked tracks), then by exact name. Anything ambiguous is
// skipped. Genres are the artist's community tags that are on MusicBrainz's official
// genre list. MusicBrainz allows about one request per second per IP and asks every
// client to identify itself, so request starts are spaced out (at most two are open at
// once), and searches are batched (many links, ISRCs or artist IDs per request).
//
// The matching functions at the top are pure and unit tested; the client below them
// takes an injectable fetch, sleep and clock so tests never hit the network.

import { defaultSleep, mapWithConcurrency, retryAfterMs } from './http';

export const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2';
/** MusicBrainz asks for "Application/<version> ( contact-url )". */
export const USER_AGENT = 'spotify-curator/0.2.0 ( https://github.com/bxant/spotify-curator )';
/** Artists per ISRC search (and the tag search after it). */
export const ARTIST_CHUNK = 25;
/** Artists per tag search for known MusicBrainz IDs; one search returns up to 100. */
export const TAG_CHUNK = 100;
/** Spotify artist links per URL search; 100 makes the URL too long for MusicBrainz. */
export const LINK_CHUNK = 50;
/** Name searches (one request each) between two tag searches. */
const NAME_GROUP = 10;
/**
 * A name search costs a request (over a second) per artist. For an artist with a single
 * liked song that buys at most one song's genres, and live runs found few, so those end
 * unmatched instead.
 */
export const NAME_SEARCH_MIN_TRACKS = 2;
/**
 * MusicBrainz limits how often requests start, not how many are open: two chunks are in
 * flight at once, so slow answers do not stretch the pace beyond MIN_INTERVAL_MS.
 */
const IN_FLIGHT = 2;
/** MusicBrainz' published limit is one request per second per IP; stay a little under it. */
export const MIN_INTERVAL_MS = 1100;
/** After a 503 (rate limited), slow down until this many requests in a row have gone through. */
export const SLOW_INTERVAL_MS = 2000;
export const RECOVER_AFTER = 30;
const SEARCH_LIMIT = 100;
const NAME_SEARCH_LIMIT = 10;
const MAX_GENRES = 5;
/** Tags used by fewer than this share of the artist's top tag's votes are dropped as noise. */
const MIN_TAG_SHARE = 0.2;

// ---------------------------------------------------------------------------
// Pure matching

/** A Spotify artist to look up, with an ISRC from one of their liked tracks when known. */
export interface ArtistToMatch {
  id: string;
  name: string;
  isrc?: string;
  /** MusicBrainz artist ID already known (from Wikidata), which skips matching. */
  mbid?: string;
  /** Liked songs by the artist; artists with fewer than NAME_SEARCH_MIN_TRACKS get no name search. */
  tracks?: number;
}

export interface MbArtistCredit {
  /** Name as credited on this recording. */
  name: string;
  artist: { id: string; name: string };
}

export interface MbRecording {
  isrcs?: string[];
  'artist-credit'?: MbArtistCredit[];
}

export interface MbArtist {
  id: string;
  name: string;
  tags?: { name: string; count: number }[];
}

export interface MbUrl {
  resource: string;
  'relation-list'?: { relations?: { artist?: { id: string } }[] }[];
}

export type MatchOutcome = { mbid: string; via: 'spotify' | 'isrc' | 'name' } | 'ambiguous' | 'none';

/** What the lookup learned about one Spotify artist. */
export interface ArtistGenreMatch {
  /** MusicBrainz artist ID, or null when there was no match or the match was ambiguous. */
  mbid: string | null;
  via?: 'wikidata' | 'spotify' | 'isrc' | 'name';
  /** Why there is no mbid. */
  skipped?: 'ambiguous' | 'none';
  genres: string[];
}

/** Case-, accent- and punctuation-insensitive form of an artist name, for exact matching. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Matches an artist through the recordings that carry their track's ISRC: the MusicBrainz
 * artist credited on those recordings under the same name. Different artists with that name
 * across the recordings are ambiguous; no recording or no credited name match is "none".
 */
export function matchByIsrc(artist: ArtistToMatch, recordings: MbRecording[]): MatchOutcome {
  if (!artist.isrc) return 'none';
  const isrc = artist.isrc.toUpperCase();
  const name = normalizeName(artist.name);
  if (!name) return 'none';
  const ids = new Set<string>();
  for (const rec of recordings) {
    if (!(rec.isrcs ?? []).some((i) => i.toUpperCase() === isrc)) continue;
    for (const credit of rec['artist-credit'] ?? []) {
      if (normalizeName(credit.name) === name || normalizeName(credit.artist.name) === name) ids.add(credit.artist.id);
    }
  }
  if (ids.size === 1) return { mbid: [...ids][0], via: 'isrc' };
  return ids.size > 1 ? 'ambiguous' : 'none';
}

/** The artist's Spotify page as MusicBrainz stores it in artist links. */
export function spotifyArtistUrl(spotifyId: string): string {
  return `https://open.spotify.com/artist/${spotifyId}`;
}

/**
 * Matches an artist through the link MusicBrainz has to their Spotify page: the one artist
 * linked to it. No link, or a link shared by several artists, is "none" (other matching may
 * still work).
 */
export function matchBySpotifyUrl(spotifyId: string, urls: MbUrl[]): MatchOutcome {
  const wanted = spotifyArtistUrl(spotifyId);
  const ids = new Set<string>();
  for (const url of urls) {
    if (url.resource !== wanted) continue;
    for (const list of url['relation-list'] ?? []) for (const r of list.relations ?? []) if (r.artist?.id) ids.add(r.artist.id);
  }
  return ids.size === 1 ? { mbid: [...ids][0], via: 'spotify' } : 'none';
}

/** Matches an artist by name: exactly one MusicBrainz artist with that exact name, or nothing. */
export function matchByName(name: string, results: MbArtist[]): MatchOutcome {
  const wanted = normalizeName(name);
  if (!wanted) return 'none';
  const ids = new Set(results.filter((a) => normalizeName(a.name) === wanted).map((a) => a.id));
  if (ids.size === 1) return { mbid: [...ids][0], via: 'name' };
  return ids.size > 1 ? 'ambiguous' : 'none';
}

/**
 * The artist's genres: community tags that are on MusicBrainz's genre list, with net
 * positive votes and at least a fifth of the top tag's votes, most voted first.
 */
export function genresFromTags(tags: MbArtist['tags'], genreNames: ReadonlySet<string>): string[] {
  const genres = (tags ?? [])
    .map((t) => ({ name: t.name.trim().toLowerCase(), count: t.count }))
    .filter((t) => t.count > 0 && genreNames.has(t.name))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (genres.length === 0) return [];
  const floor = genres[0].count * MIN_TAG_SHARE;
  return genres.filter((t) => t.count >= floor).slice(0, MAX_GENRES).map((t) => t.name);
}

/** Quotes a value as a Lucene phrase for MusicBrainz search. */
export function phrase(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

// ---------------------------------------------------------------------------
// Client

export class GenreServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenreServiceError';
  }
}

export interface MusicBrainzOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
  /** Longest Retry-After we wait out before giving up. */
  maxRetryAfterMs?: number;
}

export interface LookupProgress {
  done: number;
  total: number;
}

const MAX_ATTEMPTS = 4;

export class MusicBrainzClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRetryAfterMs: number;
  private readonly baseIntervalMs: number;
  private intervalMs: number;
  private nextAt = 0;
  /** Requests answered since the last 503, while slowed down. */
  private calm = 0;

  constructor(options: MusicBrainzOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.baseIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
    this.intervalMs = this.baseIntervalMs;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
  }

  /** MusicBrainz' official genre names (a single plain-text request). */
  async getGenreNames(signal?: AbortSignal): Promise<string[]> {
    const text = await this.get('/genre/all?fmt=txt', 'text', signal);
    return text
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean);
  }

  /** MusicBrainz' links to these Spotify artists' pages, with the artists they belong to. */
  async searchSpotifyArtistUrls(spotifyIds: string[], signal?: AbortSignal): Promise<MbUrl[]> {
    const ids = spotifyIds.filter((id) => /^[A-Za-z0-9]{22}$/.test(id));
    if (ids.length === 0) return [];
    const query = ids.map((id) => `url:${phrase(spotifyArtistUrl(id))}`).join(' OR ');
    const body = await this.get<{ urls?: MbUrl[] }>(
      `/url?query=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&fmt=json`,
      'json',
      signal,
    );
    return body.urls ?? [];
  }

  /** Recordings carrying any of the ISRCs, with their artist credits. */
  async searchRecordingsByIsrc(isrcs: string[], signal?: AbortSignal): Promise<MbRecording[]> {
    if (isrcs.length === 0) return [];
    const query = isrcs.map((i) => `isrc:${i.replace(/[^A-Za-z0-9]/g, '')}`).join(' OR ');
    const body = await this.get<{ recordings?: MbRecording[] }>(
      `/recording?query=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&fmt=json`,
      'json',
      signal,
    );
    return body.recordings ?? [];
  }

  /** The best-scoring artists for an exact name phrase. */
  async searchArtistsByName(name: string, signal?: AbortSignal): Promise<MbArtist[]> {
    const body = await this.get<{ artists?: MbArtist[] }>(
      `/artist?query=${encodeURIComponent(`artist:${phrase(name)}`)}&limit=${NAME_SEARCH_LIMIT}&fmt=json`,
      'json',
      signal,
    );
    return body.artists ?? [];
  }

  /** Artists (with their tags) by MusicBrainz ID, many per request. */
  async getArtistsWithTags(mbids: string[], signal?: AbortSignal): Promise<MbArtist[]> {
    if (mbids.length === 0) return [];
    const query = mbids.map((id) => `arid:${id.replace(/[^a-f0-9-]/gi, '')}`).join(' OR ');
    const body = await this.get<{ artists?: MbArtist[] }>(
      `/artist?query=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&fmt=json`,
      'json',
      signal,
    );
    return body.artists ?? [];
  }

  /**
   * Matches Spotify artists and reads their genres, in passes so that the cheap, batched
   * requests come first and the list's order (most-liked first) holds within each:
   * 1. artists Wikidata already linked to MusicBrainz: one tag search per `TAG_CHUNK`;
   * 2. the rest, `LINK_CHUNK` at a time: one search for MusicBrainz' links to their
   *    Spotify pages, then one tag search;
   * 3. artists without a link, `ARTIST_CHUNK` at a time: one ISRC search, then one tag search;
   * 4. artists no recording matched and with at least NAME_SEARCH_MIN_TRACKS liked songs:
 *    one name search each, then a tag search per group.
   * `onChunk` receives final results as soon as they are known, so a lookup that stops early
   * (error or abort) keeps everything matched so far. Artists for which `skip` returns true
   * when their turn comes (e.g. another source found their genres) are counted as done
   * without a request or a result.
   */
  async findArtistGenres(
    artists: ArtistToMatch[],
    genreNames: ReadonlySet<string>,
    onChunk: (results: Record<string, ArtistGenreMatch>, progress: LookupProgress) => void,
    signal?: AbortSignal,
    skip: (id: string) => boolean = () => false,
  ): Promise<void> {
    let done = 0;
    const emit = (results: Record<string, ArtistGenreMatch>, count: number) => {
      done += count;
      onChunk(results, { done, total: artists.length });
    };
    const genresOf = async (mbids: string[]) => {
      const tagged = new Map((await this.getArtistsWithTags([...new Set(mbids)], signal)).map((a) => [a.id, a]));
      return (mbid: string) => genresFromTags(tagged.get(mbid)?.tags, genreNames);
    };

    const order = new Map(artists.map((a, i) => [a.id, i]));
    const inOrder = (list: ArtistToMatch[]) => list.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    /** Runs one step per chunk of `list`, a few chunks at a time, most-liked chunks first. */
    const pass = async (list: ArtistToMatch[], size: number, step: (chunk: ArtistToMatch[], live: ArtistToMatch[]) => Promise<void>) => {
      const chunks: ArtistToMatch[][] = [];
      for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
      await mapWithConcurrency(chunks, IN_FLIGHT, (chunk) => step(chunk, chunk.filter((a) => !skip(a.id))), signal);
    };
    /** Emits the matched and ambiguous artists of a chunk and returns those still unmatched. */
    const settle = async (chunk: ArtistToMatch[], live: ArtistToMatch[], outcomes: ReadonlyMap<string, MatchOutcome>) => {
      const unmatched = live.filter((a) => outcomes.get(a.id) === 'none');
      const rest = new Set(unmatched);
      emit(await this.results(live.filter((a) => !rest.has(a)), outcomes, genresOf), chunk.length - unmatched.length);
      return unmatched;
    };

    await pass(artists.filter((a) => a.mbid), TAG_CHUNK, async (chunk, live) => {
      const genres = await genresOf(live.map((a) => a.mbid as string));
      const results: Record<string, ArtistGenreMatch> = {};
      for (const a of live) results[a.id] = { mbid: a.mbid as string, via: 'wikidata', genres: genres(a.mbid as string) };
      emit(results, chunk.length);
    });

    const byIsrc: ArtistToMatch[] = [];
    await pass(artists.filter((a) => !a.mbid), LINK_CHUNK, async (chunk, live) => {
      const urls = await this.searchSpotifyArtistUrls(live.map((a) => a.id), signal);
      byIsrc.push(...(await settle(chunk, live, new Map(live.map((a) => [a.id, matchBySpotifyUrl(a.id, urls)])))));
    });

    const byName: ArtistToMatch[] = [];
    await pass(inOrder(byIsrc), ARTIST_CHUNK, async (chunk, live) => {
      const recordings = await this.searchRecordingsByIsrc(live.flatMap((a) => (a.isrc ? [a.isrc] : [])), signal);
      byName.push(...(await settle(chunk, live, new Map(live.map((a) => [a.id, matchByIsrc(a, recordings)])))));
    });

    const worthSearching = (a: ArtistToMatch) => (a.tracks ?? NAME_SEARCH_MIN_TRACKS) >= NAME_SEARCH_MIN_TRACKS;
    const unsearched: Record<string, ArtistGenreMatch> = {};
    for (const a of byName) if (!worthSearching(a)) unsearched[a.id] = { mbid: null, skipped: 'none', genres: [] };
    if (Object.keys(unsearched).length > 0) emit(unsearched, Object.keys(unsearched).length);
    await pass(inOrder(byName.filter(worthSearching)), NAME_GROUP, async (group, live) => {
      const outcomes = new Map<string, MatchOutcome>();
      for (const a of live) outcomes.set(a.id, matchByName(a.name, await this.searchArtistsByName(a.name, signal)));
      emit(await this.results(live, outcomes, genresOf), group.length);
    });
  }

  private async results(
    artists: ArtistToMatch[],
    outcomes: ReadonlyMap<string, MatchOutcome>,
    genresOf: (mbids: string[]) => Promise<(mbid: string) => string[]>,
  ): Promise<Record<string, ArtistGenreMatch>> {
    const mbids = artists.flatMap((a) => {
      const o = outcomes.get(a.id);
      return typeof o === 'object' ? [o.mbid] : [];
    });
    const genres = await genresOf(mbids);
    const results: Record<string, ArtistGenreMatch> = {};
    for (const a of artists) {
      const o = outcomes.get(a.id) ?? 'none';
      results[a.id] =
        typeof o === 'object' ? { mbid: o.mbid, via: o.via, genres: genres(o.mbid) } : { mbid: null, skipped: o, genres: [] };
    }
    return results;
  }

  private async get(path: string, as: 'text', signal?: AbortSignal): Promise<string>;
  private async get<T>(path: string, as: 'json', signal?: AbortSignal): Promise<T>;
  private async get<T>(path: string, as: 'json' | 'text', signal?: AbortSignal): Promise<T | string> {
    for (let attempt = 1; ; attempt++) {
      await this.throttle(signal);
      let res: Response;
      try {
        res = await this.fetchImpl(`${MUSICBRAINZ_BASE}${path}`, {
          // Browsers that refuse to set User-Agent send their own; MusicBrainz' CORS setup allows the header.
          headers: { Accept: as === 'json' ? 'application/json' : 'text/plain', 'User-Agent': USER_AGENT },
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < 3) {
          await this.sleep(2000 * attempt);
          continue;
        }
        throw new GenreServiceError(`MusicBrainz unreachable: ${(err as Error).message}`);
      }
      if (res.ok) {
        if (this.intervalMs > this.baseIntervalMs && ++this.calm >= RECOVER_AFTER) this.intervalMs = this.baseIntervalMs;
        return as === 'json' ? ((await res.json()) as T) : await res.text();
      }
      // MusicBrainz answers 503 when a client goes over its rate limit (or it is overloaded).
      if ((res.status === 503 || res.status === 429) && attempt < MAX_ATTEMPTS) {
        this.intervalMs = Math.max(this.intervalMs, SLOW_INTERVAL_MS);
        this.calm = 0;
        const header = res.headers.get('Retry-After');
        const waitMs = header ? retryAfterMs(header) : 2000 * attempt;
        if (waitMs > this.maxRetryAfterMs) {
          throw new GenreServiceError(`MusicBrainz rate limit: asked to wait ${Math.ceil(waitMs / 1000)}s`);
        }
        await this.sleep(waitMs);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await this.sleep(2000 * attempt);
        continue;
      }
      throw new GenreServiceError(`MusicBrainz request failed with HTTP ${res.status}`);
    }
  }

  /** Spaces request starts at least `intervalMs` apart, reserving each start before waiting for it. */
  private async throttle(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.intervalMs;
    if (at > now) await this.sleep(at - now);
    signal?.throwIfAborted();
  }
}
