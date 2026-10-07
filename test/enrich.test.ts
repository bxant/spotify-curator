import { describe, expect, it } from 'vitest';
import {
  cachedEnrichment,
  enrichmentProgress,
  keysCovered,
  mergeEnrichment,
  openGenres,
  runEnrichment,
  type EnrichmentClients,
  type EnrichmentData,
  type EnrichmentStatus,
} from '../src/enrich';
import type { ArtistGenreMatch, ArtistToMatch, LookupProgress } from '../src/musicbrainz';
import { SessionCache } from '../src/session-cache';
import type { TrackKey } from '../src/types';
import type { WikidataArtist } from '../src/wikidata';
import { MemoryStorage, track } from './fixtures/builders';

const empty = (): EnrichmentData => ({ keys: {}, spotify: {}, wikidata: {}, musicBrainz: {}, genreNames: null });
const status = (keys: 'running' | 'done', genres: 'running' | 'done'): EnrichmentStatus => ({
  keys: { state: keys, errors: [] },
  genres: { state: genres, errors: [] },
});
const key: TrackKey = { key: 9, mode: 0 };

describe('mergeEnrichment', () => {
  it('adds what another tab saved and keeps what this tab already has', () => {
    const mine: EnrichmentData = { ...empty(), keys: { a: key, b: null }, spotify: { x: ['rock'] }, genreNames: undefined };
    const saved: EnrichmentData = {
      ...empty(),
      keys: { b: key, c: key },
      spotify: { x: [], y: ['jazz'] },
      musicBrainz: { y: { mbid: 'm', genres: ['jazz'] } as ArtistGenreMatch },
      genreNames: ['rock', 'jazz'],
    };
    mergeEnrichment(mine, saved);
    expect(mine.keys).toEqual({ a: key, b: null, c: key });
    expect(mine.spotify).toEqual({ x: ['rock'], y: ['jazz'] });
    expect(Object.keys(mine.musicBrainz)).toEqual(['y']);
    expect(mine.genreNames).toEqual(['rock', 'jazz']);
  });
});

describe('keysCovered', () => {
  const liked = [track({ id: 'a' }), track({ id: 'b' })];

  it('is true once every liked song has a key or a null answer', () => {
    expect(keysCovered(liked, { a: key, b: null })).toBe(true);
  });

  it('is false while any liked song is still unanswered', () => {
    expect(keysCovered(liked, { a: key })).toBe(false);
    expect(keysCovered(liked, {})).toBe(false);
  });
});

describe('openGenres', () => {
  it('merges Wikidata genres (as MusicBrainz genre names) with MusicBrainz genres per artist', () => {
    const data: EnrichmentData = {
      ...empty(),
      genreNames: ['rock', 'britpop', 'shoegaze'],
      wikidata: {
        a: { found: true, labels: ['rock music', 'Britpop', 'rapping'] },
        b: { found: true, labels: ['rapping'] },
        c: { found: false, labels: [] },
      },
      musicBrainz: { a: { mbid: 'x', via: 'wikidata', genres: ['shoegaze'] }, d: { mbid: null, skipped: 'none', genres: [] } },
    };
    expect(openGenres(data)).toEqual({ a: ['rock', 'britpop', 'shoegaze'] });
  });

  it('holds Wikidata genres back until the genre list is known, and uses plain labels without it', () => {
    const wikidata = { a: { found: true, labels: ['Hip-Hop music'] } };
    expect(openGenres({ ...empty(), wikidata, genreNames: undefined })).toEqual({});
    expect(openGenres({ ...empty(), wikidata, genreNames: ['hip hop'] })).toEqual({ a: ['hip hop'] });
    expect(openGenres({ ...empty(), wikidata, genreNames: null })).toEqual({ a: ['hip-hop'] });
  });
});

describe('enrichmentProgress', () => {
  const liked = [
    track({ id: 't1', artist: 'a' }),
    track({ id: 't2', artist: 'b', extraArtists: ['a'] }),
    track({ id: 't3', artist: 'c' }),
    track({ id: 't1', artist: 'a' }),
  ];

  it('counts a song once its key and every artist are settled', () => {
    const data: EnrichmentData = {
      ...empty(),
      keys: { t1: key, t2: null },
      // a has genres; b has none but every source answered; c is still waiting on Spotify.
      spotify: { a: ['pop'], b: [] },
      wikidata: { b: { found: false, labels: [] }, c: { found: false, labels: [] } },
      musicBrainz: { b: { mbid: null, skipped: 'none', genres: [] }, c: { mbid: null, skipped: 'none', genres: [] } },
    };
    expect(enrichmentProgress(liked, data, status('running', 'running'))).toEqual({ songs: 3, settled: 2, withKey: 1, withGenres: 2 });
    // Once a lane is over, whatever it did not find is settled too.
    expect(enrichmentProgress(liked, data, status('done', 'done')).settled).toBe(3);
    // A stopped lane has not answered for the rest.
    const stopped: EnrichmentStatus = { keys: { state: 'stopped', errors: [] }, genres: { state: 'stopped', errors: [] } };
    expect(enrichmentProgress(liked, data, stopped).settled).toBe(2);
  });
});

/** Scripted clients that record what each service was asked for. */
function clients(over: { keys?: Record<string, TrackKey | null>; wikidata?: Record<string, WikidataArtist>; mbGenres?: Record<string, string[]>; spotify?: Record<string, string[]> }) {
  const asked = { keys: [] as string[], wikidata: [] as string[], musicBrainz: [] as ArtistToMatch[], spotify: [] as string[] };
  const c = {
    reccoBeats: {
      async getTrackKeys(ids: string[], onProgress: (d: number, t: number, k: Record<string, TrackKey | null>) => void) {
        asked.keys.push(...ids);
        const keys = Object.fromEntries(ids.map((id) => [id, over.keys?.[id] ?? null]));
        onProgress(ids.length, ids.length, keys);
        return keys;
      },
    },
    wikidata: {
      async findArtists(ids: string[], onBatch: (r: Record<string, WikidataArtist>, d: number, t: number) => void) {
        asked.wikidata.push(...ids);
        onBatch(Object.fromEntries(ids.map((id) => [id, over.wikidata?.[id] ?? { found: false, labels: [] }])), ids.length, ids.length);
      },
    },
    musicBrainz: {
      async getGenreNames() {
        return ['rock', 'folk', 'jazz'];
      },
      async findArtistGenres(
        artists: ArtistToMatch[],
        _names: Set<string>,
        onChunk: (r: Record<string, ArtistGenreMatch>, p: LookupProgress) => void,
        _signal: AbortSignal,
        skip: (id: string) => boolean,
      ) {
        // Let Spotify answer first, so the skip check sees its genres.
        await new Promise((r) => setTimeout(r, 5));
        const live = artists.filter((a) => !skip(a.id));
        asked.musicBrainz.push(...live);
        const results: Record<string, ArtistGenreMatch> = {};
        for (const a of live) results[a.id] = { mbid: a.mbid ?? null, genres: over.mbGenres?.[a.id] ?? [] };
        onChunk(results, { done: artists.length, total: artists.length });
      },
    },
    spotify: {
      async getArtistGenres(ids: string[], onProgress: (d: number, t: number, g: Record<string, string[]>) => void, _s: AbortSignal, _c: number, skip: (id: string) => boolean) {
        const genres: Record<string, string[]> = {};
        for (const id of ids) {
          if (skip(id)) continue;
          asked.spotify.push(id);
          genres[id] = over.spotify?.[id] ?? [];
        }
        onProgress(ids.length, ids.length, genres);
        return genres;
      },
    },
  } as unknown as EnrichmentClients;
  return { clients: c, asked };
}

describe('runEnrichment', () => {
  const liked = [
    track({ id: 't1', artist: 'wd' }),
    track({ id: 't2', artist: 'wd' }),
    track({ id: 't3', artist: 'sp' }),
    track({ id: 't4', artist: 'mb' }),
  ];

  it('looks up keys, then genres from Wikidata first and the other sources only for artists still without', async () => {
    const cache = new SessionCache(new MemoryStorage());
    const { clients: c, asked } = clients({
      keys: { t1: key },
      wikidata: { wd: { found: true, mbid: 'mb-wd', labels: ['rock music'] }, mb: { found: true, mbid: 'mb-mb', labels: [] } },
      spotify: { sp: ['Folk'] },
      mbGenres: { mb: ['jazz'] },
    });
    const data = cachedEnrichment(cache);
    const st = status('running', 'running');
    let changes = 0;
    await runEnrichment(liked, cache, c, data, st, () => changes++, { teardown: new AbortController().signal, stop: new AbortController().signal });

    expect(asked.keys).toEqual(['t1', 't2', 't3', 't4']);
    expect(asked.wikidata.sort()).toEqual(['mb', 'sp', 'wd']);
    // Wikidata's genres cover "wd"; Spotify answers for "sp" before MusicBrainz gets to it.
    expect(asked.spotify.sort()).toEqual(['mb', 'sp']);
    expect(asked.musicBrainz).toEqual([{ id: 'mb', name: 'MB', tracks: 1, mbid: 'mb-mb' }]);
    expect(openGenres(data)).toEqual({ wd: ['rock'], mb: ['jazz'] });
    expect(st).toEqual(status('done', 'done'));
    expect(changes).toBeGreaterThan(0);
    expect(enrichmentProgress(liked, data, st)).toMatchObject({ settled: 4, withKey: 1, withGenres: 4 });

    // A later run asks nothing again: every result is cached.
    const again = clients({});
    await runEnrichment(liked, cache, again.clients, cachedEnrichment(cache), status('running', 'running'), () => {}, {
      teardown: new AbortController().signal,
      stop: new AbortController().signal,
    });
    expect(again.asked).toEqual({ keys: [], wikidata: [], musicBrainz: [], spotify: [] });
  });

  it('ends as stopped and keeps what it found when stopped, but writes nothing after a teardown', async () => {
    const stop = new AbortController();
    stop.abort();
    const cache = new SessionCache(new MemoryStorage());
    const st = status('running', 'running');
    await runEnrichment(liked, cache, clients({}).clients, cachedEnrichment(cache), st, () => {}, { teardown: new AbortController().signal, stop: stop.signal });
    expect(st.keys.state).toBe('stopped');
    expect(st.genres.state).toBe('stopped');
    expect(cache.get('keys')).toEqual({});

    const teardown = new AbortController();
    teardown.abort();
    const untouched = new SessionCache(new MemoryStorage());
    await runEnrichment(liked, untouched, clients({}).clients, cachedEnrichment(untouched), status('running', 'running'), () => {}, {
      teardown: teardown.signal,
      stop: new AbortController().signal,
    });
    expect(untouched.get('keys')).toBeNull();
    expect(untouched.get('genres')).toBeNull();
  });

  it('reports which source failed and still uses the others', async () => {
    const cache = new SessionCache(new MemoryStorage());
    const { clients: c } = clients({ spotify: { sp: ['folk'] } });
    (c.wikidata as unknown as { findArtists: () => Promise<void> }).findArtists = async () => {
      throw new Error('Wikidata request failed with HTTP 503');
    };
    const data = cachedEnrichment(cache);
    const st = status('running', 'running');
    await runEnrichment(liked, cache, c, data, st, () => {}, { teardown: new AbortController().signal, stop: new AbortController().signal });
    expect(st.genres).toEqual({ state: 'done', errors: ['Genres (Wikidata): Wikidata request failed with HTTP 503'] });
    expect(data.spotify.sp).toEqual(['folk']);
  });
});
