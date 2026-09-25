// Extra artist genres from MusicBrainz (https://musicbrainz.org), a free, open music
// database with no API key. Spotify's artist `genres` is deprecated for new apps and
// often empty, so this is an optional cross-reference.
//
// Spotify artists are matched to MusicBrainz artists by ISRC first (the recording
// codes Spotify reports for liked tracks), then by exact name. Anything ambiguous is
// skipped. Genres are the artist's community tags that are on MusicBrainz's official
// genre list. MusicBrainz allows about one request per second per IP and asks every
// client to identify itself, so requests are serialized and spaced out, and searches
// are batched (many ISRCs or artist IDs per request) to keep the lookup short.
//
// The matching functions at the top are pure and unit tested; the client below them
// takes an injectable fetch, sleep and clock so tests never hit the network.

import { defaultSleep, retryAfterMs } from './http';

export const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2';
/** MusicBrainz asks for "Application/<version> ( contact-url )". */
export const USER_AGENT = 'spotify-curator/0.2.0 ( https://github.com/bxant/spotify-curator )';
/** Artists handled per step: one ISRC search, name searches for the rest, one tag search. */
export const ARTIST_CHUNK = 25;
/** MusicBrainz' published limit is one request per second per IP; stay a little under it. */
export const MIN_INTERVAL_MS = 1100;
/** After a 503 (rate limited), slow down for the rest of the lookup. */
export const SLOW_INTERVAL_MS = 2000;
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

export type MatchOutcome = { mbid: string; via: 'isrc' | 'name' } | 'ambiguous' | 'none';

/** What the lookup learned about one Spotify artist. */
export interface ArtistGenreMatch {
  /** MusicBrainz artist ID, or null when there was no match or the match was ambiguous. */
  mbid: string | null;
  via?: 'isrc' | 'name';
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
  /** Rough seconds left, from the requests still expected and the current pace. */
  etaSeconds: number;
}

const MAX_ATTEMPTS = 4;

export class MusicBrainzClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRetryAfterMs: number;
  private intervalMs: number;
  private nextAt = 0;
  private requests = 0;

  constructor(options: MusicBrainzOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
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
   * Matches Spotify artists and reads their genres, `ARTIST_CHUNK` artists at a time.
   * `onChunk` receives each chunk's results as soon as they are known, so a lookup
   * that stops early (error or abort) keeps everything matched so far.
   */
  async findArtistGenres(
    artists: ArtistToMatch[],
    genreNames: ReadonlySet<string>,
    onChunk: (results: Record<string, ArtistGenreMatch>, progress: LookupProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let done = 0;
    const startRequests = this.requests;
    for (let i = 0; i < artists.length; i += ARTIST_CHUNK) {
      signal?.throwIfAborted();
      const chunk = artists.slice(i, i + ARTIST_CHUNK);
      const outcomes = new Map<string, MatchOutcome>();

      const withIsrc = chunk.filter((a) => a.isrc);
      const recordings = await this.searchRecordingsByIsrc(withIsrc.map((a) => a.isrc as string), signal);
      for (const a of chunk) outcomes.set(a.id, matchByIsrc(a, recordings));

      for (const a of chunk) {
        if (outcomes.get(a.id) !== 'none') continue;
        outcomes.set(a.id, matchByName(a.name, await this.searchArtistsByName(a.name, signal)));
      }

      const mbids = [...new Set([...outcomes.values()].flatMap((o) => (typeof o === 'object' ? [o.mbid] : [])))];
      const tagged = new Map((await this.getArtistsWithTags(mbids, signal)).map((a) => [a.id, a]));

      const results: Record<string, ArtistGenreMatch> = {};
      for (const a of chunk) {
        const o = outcomes.get(a.id) ?? 'none';
        results[a.id] =
          typeof o === 'object'
            ? { mbid: o.mbid, via: o.via, genres: genresFromTags(tagged.get(o.mbid)?.tags, genreNames) }
            : { mbid: null, skipped: o, genres: [] };
      }
      done += chunk.length;
      const requestsPerArtist = (this.requests - startRequests) / done;
      const etaSeconds = Math.round(((artists.length - done) * requestsPerArtist * this.intervalMs) / 1000);
      onChunk(results, { done, total: artists.length, etaSeconds });
    }
  }

  private async get(path: string, as: 'text', signal?: AbortSignal): Promise<string>;
  private async get<T>(path: string, as: 'json', signal?: AbortSignal): Promise<T>;
  private async get<T>(path: string, as: 'json' | 'text', signal?: AbortSignal): Promise<T | string> {
    for (let attempt = 1; ; attempt++) {
      await this.throttle(signal);
      this.requests++;
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
      if (res.ok) return as === 'json' ? ((await res.json()) as T) : await res.text();
      // MusicBrainz answers 503 when a client goes over its rate limit.
      if ((res.status === 503 || res.status === 429) && attempt < MAX_ATTEMPTS) {
        this.intervalMs = Math.max(this.intervalMs, SLOW_INTERVAL_MS);
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

  /** Spaces request starts at least `intervalMs` apart. */
  private async throttle(signal?: AbortSignal): Promise<void> {
    const wait = this.nextAt - this.now();
    if (wait > 0) await this.sleep(wait);
    signal?.throwIfAborted();
    this.nextAt = this.now() + this.intervalMs;
  }
}
