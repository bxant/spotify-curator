// Artist genres from Wikidata (https://www.wikidata.org), the free, CC0 knowledge base
// behind Wikipedia. Many Wikidata artists carry their Spotify artist ID (property P1902),
// their genres (P136) and their MusicBrainz artist ID (P434), so one SPARQL query looks up
// hundreds of Spotify artists at once. That makes it the first genre source: seconds for a
// whole library, where MusicBrainz' one request per second takes minutes. Artists Wikidata
// does not know (or knows without genres) fall back to MusicBrainz, which can skip its own
// matching for the ones Wikidata already linked to a MusicBrainz ID.
//
// The query service allows each client 60 seconds of query time per minute and 5 parallel
// queries, and answers 429 with Retry-After beyond that. Lookups here run one query at a
// time and each takes about a second. Wikimedia requires an identifying User-Agent, which
// browsers may not let a page set, so the client also sends Api-User-Agent, which the
// service accepts for that purpose (and allows through CORS).
//
// The pure helpers at the top are unit tested; the client takes an injectable fetch and
// sleep so tests never hit the network.

import { defaultSleep, retryAfterMs } from './http';
import { USER_AGENT, isSpotifyId, normalizeName } from './musicbrainz';

export const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
/** The same identity the MusicBrainz client uses. */
export const API_USER_AGENT = USER_AGENT;
/** Spotify artists per query; a query this size takes about a second. */
export const WIKIDATA_BATCH = 250;
/** Genres kept per artist, like MusicBrainz' tags. */
const MAX_GENRES = 5;
const MAX_ATTEMPTS = 4;

/** What Wikidata knows about one Spotify artist. */
export interface WikidataArtist {
  /** Some Wikidata item carries this Spotify artist ID. */
  found: boolean;
  /** MusicBrainz artist ID from the same item, when there is exactly one. */
  mbid?: string;
  /** English genre labels as Wikidata has them, e.g. "rock music" or "Britpop". */
  labels: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers

/** SPARQL for the Spotify artists' MusicBrainz IDs and English genre labels. */
export function artistQuery(spotifyIds: string[]): string {
  const values = spotifyIds.filter(isSpotifyId).map((id) => `"${id}"`).join(' ');
  return (
    'SELECT ?sid ?mbid ?label WHERE { ' +
    `VALUES ?sid { ${values} } ` +
    '?artist wdt:P1902 ?sid. ' +
    'OPTIONAL { ?artist wdt:P434 ?mbid. } ' +
    'OPTIONAL { ?artist wdt:P136 ?genre. ?genre rdfs:label ?label. FILTER(LANG(?label) = "en") } ' +
    '}'
  );
}

interface Binding {
  sid?: { value: string };
  mbid?: { value: string };
  label?: { value: string };
}

/** Every asked-for artist, found or not, from the query's result rows. */
export function parseArtists(spotifyIds: string[], bindings: Binding[]): Record<string, WikidataArtist> {
  const rows = new Map<string, { mbids: Set<string>; labels: Set<string> }>();
  for (const b of bindings) {
    const sid = b.sid?.value;
    if (!sid) continue;
    const row = rows.get(sid) ?? { mbids: new Set(), labels: new Set() };
    if (b.mbid?.value) row.mbids.add(b.mbid.value.toLowerCase());
    if (b.label?.value) row.labels.add(b.label.value);
    rows.set(sid, row);
  }
  const result: Record<string, WikidataArtist> = {};
  for (const id of spotifyIds) {
    const row = rows.get(id);
    if (!row) {
      result[id] = { found: false, labels: [] };
      continue;
    }
    const labels = [...row.labels].sort((a, b) => a.localeCompare(b));
    // Two MusicBrainz IDs on one artist would be a guess; leave those to name matching.
    result[id] = row.mbids.size === 1 ? { found: true, mbid: [...row.mbids][0], labels } : { found: true, labels };
  }
  return result;
}

/** Looks up genre names in their normalized form, so "Hip-Hop" finds "hip hop". */
export type GenreIndex = ReadonlyMap<string, string>;

export function genreIndex(genreNames: Iterable<string>): GenreIndex {
  const index = new Map<string, string>();
  for (const name of genreNames) index.set(normalizeName(name), name);
  return index;
}

/**
 * Wikidata genre labels as genre names the other sources share. With MusicBrainz' genre
 * list, a label counts when it (or the label without a trailing "music", as in "rock
 * music") is on the list, and anything else (e.g. "rapping") is dropped. Without the list,
 * labels are only lowercased and lose that trailing "music".
 */
export function wikidataGenres(labels: string[], index: GenreIndex | null): string[] {
  const genres = new Set<string>();
  for (const label of labels) {
    const lower = label.trim().toLowerCase();
    const bare = lower.replace(/\s+music$/, '');
    if (!index) {
      if (bare) genres.add(bare);
      continue;
    }
    const name = index.get(normalizeName(lower)) ?? index.get(normalizeName(bare));
    if (name) genres.add(name);
  }
  return [...genres].slice(0, MAX_GENRES);
}

// ---------------------------------------------------------------------------
// Client

export class WikidataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikidataError';
  }
}

export interface WikidataOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Longest Retry-After we wait out before giving up. */
  maxRetryAfterMs?: number;
}

export class WikidataClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetryAfterMs: number;

  constructor(options: WikidataOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
  }

  /**
   * Looks up Spotify artists `WIKIDATA_BATCH` at a time, one query after another.
   * `onBatch` receives each batch's results as soon as they are known.
   */
  async findArtists(
    spotifyIds: string[],
    onBatch: (results: Record<string, WikidataArtist>, done: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    for (let i = 0; i < spotifyIds.length; i += WIKIDATA_BATCH) {
      signal?.throwIfAborted();
      const batch = spotifyIds.slice(i, i + WIKIDATA_BATCH);
      const valid = batch.filter(isSpotifyId);
      const bindings = valid.length > 0 ? await this.query(artistQuery(valid), signal) : [];
      onBatch(parseArtists(batch, bindings), i + batch.length, spotifyIds.length);
    }
  }

  private async query(sparql: string, signal?: AbortSignal): Promise<Binding[]> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        // A form POST keeps long queries out of the URL; the service's CORS setup allows Api-User-Agent.
        res = await this.fetchImpl(WIKIDATA_SPARQL, {
          method: 'POST',
          headers: {
            Accept: 'application/sparql-results+json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Api-User-Agent': API_USER_AGENT,
            // Browsers that refuse to set User-Agent send their own; Wikimedia blocks generic ones like Node's.
            'User-Agent': API_USER_AGENT,
          },
          body: new URLSearchParams({ query: sparql }).toString(),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < 3) {
          await this.sleep(2000 * attempt);
          continue;
        }
        throw new WikidataError(`Wikidata unreachable: ${(err as Error).message}`);
      }
      if (res.ok) {
        const body = (await res.json()) as { results?: { bindings?: Binding[] } };
        return body.results?.bindings ?? [];
      }
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const waitMs = retryAfterMs(res.headers.get('Retry-After'));
        if (waitMs > this.maxRetryAfterMs) {
          throw new WikidataError(`Wikidata rate limit: asked to wait ${Math.ceil(waitMs / 1000)}s`);
        }
        await this.sleep(waitMs);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await this.sleep(2000 * attempt);
        continue;
      }
      throw new WikidataError(`Wikidata request failed with HTTP ${res.status}`);
    }
  }
}
