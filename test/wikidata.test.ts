import { describe, expect, it } from 'vitest';
import {
  API_USER_AGENT,
  WIKIDATA_BATCH,
  WIKIDATA_SPARQL,
  WikidataClient,
  WikidataError,
  artistQuery,
  genreIndex,
  parseArtists,
  wikidataGenres,
  type WikidataArtist,
} from '../src/wikidata';
import { isSpotifyId } from '../src/musicbrainz';
import { fakeFetch, json } from './fixtures/fake-fetch';

const id = (n: number) => `artist${String(n).padStart(16, '0')}`;
const row = (sid: string, extra: { mbid?: string; label?: string } = {}) => ({
  sid: { value: sid },
  ...(extra.mbid ? { mbid: { value: extra.mbid } } : {}),
  ...(extra.label ? { label: { value: extra.label } } : {}),
});

describe('artistQuery', () => {
  it('asks for the MusicBrainz ID and English genre labels of valid Spotify IDs only', () => {
    const query = artistQuery(['4Z8W4fKeB5YxbusRsdQVPb', 'x" } DROP {', 'short']);
    expect(query).toContain('VALUES ?sid { "4Z8W4fKeB5YxbusRsdQVPb" }');
    expect(query).toContain('wdt:P1902 ?sid');
    expect(query).toContain('wdt:P434 ?mbid');
    expect(query).toContain('wdt:P136 ?genre');
    expect(query).not.toContain('DROP');
    expect(isSpotifyId('4Z8W4fKeB5YxbusRsdQVPb')).toBe(true);
    expect(isSpotifyId('4Z8W4fKeB5YxbusRsdQVP"')).toBe(false);
  });
});

describe('parseArtists', () => {
  it('answers for every artist asked, found or not, merging rows per artist', () => {
    const result = parseArtists(
      ['a', 'b', 'c', 'd'],
      [
        row('a', { mbid: 'MB-A', label: 'rock music' }),
        row('a', { mbid: 'MB-A', label: 'Britpop' }),
        row('b'),
        row('c', { mbid: 'mb-c1', label: 'jazz' }),
        row('c', { mbid: 'mb-c2', label: 'jazz' }),
      ],
    );
    expect(result).toEqual<Record<string, WikidataArtist>>({
      a: { found: true, mbid: 'mb-a', labels: ['Britpop', 'rock music'] },
      b: { found: true, labels: [] },
      // Two MusicBrainz IDs: keep the genres, leave the match to MusicBrainz' own matching.
      c: { found: true, labels: ['jazz'] },
      d: { found: false, labels: [] },
    });
  });
});

describe('wikidataGenres', () => {
  const index = genreIndex(['rock', 'britpop', 'hip hop', 'electronic dance music', 'k-pop']);

  it('maps labels onto MusicBrainz genre names, with or without a trailing "music"', () => {
    expect(wikidataGenres(['rock music', 'Britpop', 'Hip-Hop', 'electronic dance music', 'K-pop'], index)).toEqual([
      'rock',
      'britpop',
      'hip hop',
      'electronic dance music',
      'k-pop',
    ]);
  });

  it('drops labels that are not genres there, and keeps at most five', () => {
    expect(wikidataGenres(['rapping', 'rock'], index)).toEqual(['rock']);
    const many = genreIndex(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
    expect(wikidataGenres(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], many)).toHaveLength(5);
  });

  it('only lowercases and trims "music" without the genre list', () => {
    expect(wikidataGenres(['Rock music', 'Britpop'], null)).toEqual(['rock', 'britpop']);
  });
});

describe('WikidataClient', () => {
  const noSleep = async () => {};

  it('posts one query per batch and identifies itself with Api-User-Agent', async () => {
    const ids = Array.from({ length: WIKIDATA_BATCH + 1 }, (_, i) => id(i));
    const { fetch, calls } = fakeFetch((call) => {
      const query = new URLSearchParams(call.body).get('query') ?? '';
      return json({ results: { bindings: query.includes(id(0)) ? [row(id(0), { label: 'rock' })] : [] } });
    });
    const batches: [number, number][] = [];
    const found: Record<string, WikidataArtist> = {};
    await new WikidataClient({ fetch, sleep: noSleep }).findArtists(ids, (results, done, total) => {
      Object.assign(found, results);
      batches.push([done, total]);
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(WIKIDATA_SPARQL);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['api-user-agent']).toBe(API_USER_AGENT);
    expect(calls[0].headers['user-agent']).toBe(API_USER_AGENT);
    expect(calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(batches).toEqual([
      [WIKIDATA_BATCH, WIKIDATA_BATCH + 1],
      [WIKIDATA_BATCH + 1, WIKIDATA_BATCH + 1],
    ]);
    expect(found[id(0)]).toEqual({ found: true, labels: ['rock'] });
    expect(found[id(WIKIDATA_BATCH)]).toEqual({ found: false, labels: [] });
  });

  it('waits out 429 Retry-After, and gives up on long waits or repeated failures', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    let first = true;
    const { fetch } = fakeFetch(() => {
      if (first) {
        first = false;
        return json({}, 429, { 'Retry-After': '3' });
      }
      return json({ results: { bindings: [] } });
    });
    await new WikidataClient({ fetch, sleep }).findArtists([id(1)], () => {});
    expect(sleeps).toEqual([3000]);

    const limited = fakeFetch(() => json({}, 429, { 'Retry-After': '600' }));
    await expect(new WikidataClient({ fetch: limited.fetch, sleep }).findArtists([id(1)], () => {})).rejects.toThrow(
      WikidataError,
    );

    const broken = fakeFetch(() => json({}, 500));
    await expect(new WikidataClient({ fetch: broken.fetch, sleep }).findArtists([id(1)], () => {})).rejects.toThrow('HTTP 500');
  });

  it('sends nothing for IDs that are not Spotify IDs', async () => {
    const { fetch, calls } = fakeFetch(() => json({ results: { bindings: [] } }));
    const found: Record<string, WikidataArtist> = {};
    await new WikidataClient({ fetch, sleep: noSleep }).findArtists(['not-an-id'], (results) => Object.assign(found, results));
    expect(calls).toHaveLength(0);
    expect(found).toEqual({ 'not-an-id': { found: false, labels: [] } });
  });
});
