import { describe, expect, it } from 'vitest';
import {
  artistsToLookUp,
  artistsToMatch,
  loadGenreNames,
  loadGenres,
  loadKeys,
  loadMusicBrainz,
  loadWikidata,
  musicBrainzGenres,
} from '../src/library';
import type { ArtistGenreMatch, MusicBrainzClient } from '../src/musicbrainz';
import type { ReccoBeatsClient } from '../src/reccobeats';
import { SessionCache } from '../src/session-cache';
import { RateLimitError, SpotifyClient } from '../src/spotify';
import { configuredClientId } from '../src/config';
import type { WikidataArtist, WikidataClient } from '../src/wikidata';
import { MemoryStorage, track } from './fixtures/builders';

describe('artistsToLookUp', () => {
  it('returns unknown artists, the most-liked first', () => {
    const liked = [
      track({ id: '1', artist: 'b' }),
      track({ id: '2', artist: 'a', extraArtists: ['b'] }),
      track({ id: '3', artist: 'c' }),
      track({ id: '4', artist: 'known' }),
    ];
    expect(artistsToLookUp(liked, { known: ['pop'] })).toEqual(['b', 'a', 'c']);
  });
});

describe('loadGenres', () => {
  it('keeps and caches partial results when Spotify rate limits the lookups', async () => {
    const cache = new SessionCache(new MemoryStorage());
    cache.set('genres', { cached: ['jazz'] });
    const liked = [track({ id: '1', artist: 'cached' }), track({ id: '2', artist: 'x' }), track({ id: '3', artist: 'y' })];
    const client = {
      async getArtistGenres(ids: string[], onProgress: (d: number, t: number, g: Record<string, string[]>) => void) {
        expect(ids).toEqual(['x', 'y']);
        onProgress(1, 2, { x: ['folk'] });
        throw new RateLimitError(7_200_000);
      },
    } as unknown as SpotifyClient;

    const result = await loadGenres(client, liked, cache, () => {});
    expect(result.data).toEqual({ cached: ['jazz'], x: ['folk'] });
    expect(result.error).toContain('7200s');
    expect(cache.get('genres')).toEqual({ cached: ['jazz'], x: ['folk'] });
  });
});

describe('loadKeys', () => {
  const liked = [track({ id: 'a' }), track({ id: 'b' })];

  it('ignores results that arrive after the lookup failed', async () => {
    const cache = new SessionCache(new MemoryStorage());
    let late: (() => void) | undefined;
    const recco = {
      async getTrackKeys(_ids: string[], onProgress: (d: number, t: number, k: Record<string, unknown>) => void) {
        late = () => onProgress(2, 2, { b: { key: 1, mode: 1 } });
        throw new Error('ReccoBeats request failed with HTTP 500');
      },
    } as unknown as ReccoBeatsClient;
    const progress: number[] = [];

    const result = await loadKeys(recco, liked, cache, (keys) => progress.push(Object.keys(keys).length));
    late!();
    expect(result.error).toContain('HTTP 500');
    expect(result.data).toEqual({});
    expect(progress).toEqual([]);
    expect(cache.get('keys')).toEqual({});
  });

  it('does not write to the cache once its signal is aborted', async () => {
    const cache = new SessionCache(new MemoryStorage());
    const controller = new AbortController();
    const recco = {
      async getTrackKeys(_ids: string[], onProgress: (d: number, t: number, k: Record<string, unknown>) => void) {
        controller.abort();
        onProgress(1, 2, { a: { key: 1, mode: 1 } });
        throw new DOMException('aborted', 'AbortError');
      },
    } as unknown as ReccoBeatsClient;

    await loadKeys(recco, liked, cache, () => {}, controller.signal);
    expect(cache.get('keys')).toBeNull();
  });
});

describe('configuredClientId', () => {
  it('treats a missing or placeholder Client ID as not configured', () => {
    expect(configuredClientId(undefined)).toBeNull();
    expect(configuredClientId('  ')).toBeNull();
    expect(configuredClientId('your-client-id-here')).toBeNull();
    expect(configuredClientId(' abc123 ')).toBe('abc123');
  });
});

describe('artistsToMatch', () => {
  it('lists unmatched artists most-liked first, preferring an ISRC where they lead the track', () => {
    const liked = [
      { ...track({ id: '1', artist: 'lead', extraArtists: ['guest'] }), isrc: 'ISRC-FEAT' },
      { ...track({ id: '2', artist: 'guest' }), isrc: 'ISRC-OWN' },
      track({ id: '3', artist: 'lead' }),
      track({ id: '4', artist: 'noisrc' }),
      track({ id: '5', artist: 'done' }),
    ];
    expect(artistsToMatch(liked, { done: { mbid: 'mb', via: 'name', genres: [] } })).toEqual([
      { id: 'guest', name: 'GUEST', tracks: 2, isrc: 'ISRC-OWN' },
      { id: 'lead', name: 'LEAD', tracks: 2, isrc: 'ISRC-FEAT' },
      { id: 'noisrc', name: 'NOISRC', tracks: 1 },
    ]);
  });

  it('retries an artist found unmatched once they have more liked songs than at that lookup', () => {
    const liked = [
      { ...track({ id: '1', artist: 'grew' }), isrc: 'ISRC-NEW' },
      { ...track({ id: '2', artist: 'grew' }), isrc: 'ISRC-OLD' },
      track({ id: '3', artist: 'same' }),
      track({ id: '4', artist: 'same' }),
      track({ id: '5', artist: 'ambiguous' }),
      track({ id: '6', artist: 'ambiguous' }),
    ];
    const known: Record<string, ArtistGenreMatch> = {
      grew: { mbid: null, skipped: 'none', tracks: 1, genres: [] },
      same: { mbid: null, skipped: 'none', tracks: 2, genres: [] },
      ambiguous: { mbid: null, skipped: 'ambiguous', genres: [] },
    };
    expect(artistsToMatch(liked, known)).toEqual([{ id: 'grew', name: 'GREW', tracks: 2, isrc: 'ISRC-NEW' }]);
  });
});

describe('loadGenreNames', () => {
  it('fetches the genre list once per browser and tolerates MusicBrainz being down', async () => {
    const cache = new SessionCache(new MemoryStorage());
    let calls = 0;
    const mb = {
      async getGenreNames() {
        calls++;
        return ['folk'];
      },
    } as unknown as MusicBrainzClient;
    expect(await loadGenreNames(mb, cache)).toEqual(['folk']);
    expect(await loadGenreNames(mb, cache)).toEqual(['folk']);
    expect(calls).toBe(1);

    const down = {
      async getGenreNames() {
        throw new Error('MusicBrainz unreachable');
      },
    } as unknown as MusicBrainzClient;
    expect(await loadGenreNames(down, new SessionCache(new MemoryStorage()))).toBeNull();
  });
});

describe('loadMusicBrainz', () => {
  const match = (genres: string[]): ArtistGenreMatch => ({ mbid: 'mb', via: 'name', genres });
  const liked = [track({ id: '1', artist: 'x' }), track({ id: '2', artist: 'y' }), track({ id: '3', artist: 'cached' }), track({ id: '4', artist: 'covered' })];

  it('looks up only new artists not covered elsewhere, with Wikidata\'s MusicBrainz IDs, and caches each chunk', async () => {
    const cache = new SessionCache(new MemoryStorage());
    cache.set('musicbrainz.artists', { cached: match(['jazz']) });
    const mb = {
      async findArtistGenres(
        artists: { id: string; mbid?: string }[],
        genres: Set<string>,
        onChunk: (r: Record<string, ArtistGenreMatch>, p: { done: number; total: number }) => void,
      ) {
        expect(artists).toEqual([
          { id: 'x', name: 'X', tracks: 1, mbid: 'mb-x' },
          { id: 'y', name: 'Y', tracks: 1 },
        ]);
        expect([...genres]).toEqual(['folk']);
        onChunk({ x: match(['folk']) }, { done: 1, total: 2 });
        throw new Error('MusicBrainz request failed with HTTP 500');
      },
    } as unknown as MusicBrainzClient;

    const result = await loadMusicBrainz(mb, liked, cache, ['folk'], () => {}, undefined, {
      mbids: { x: 'mb-x' },
      skip: (id) => id === 'covered',
    });
    expect(result.error).toContain('HTTP 500');
    expect(result.data).toEqual({ cached: match(['jazz']), x: match(['folk']) });
    expect(cache.get('musicbrainz.artists')).toEqual(result.data);
    expect(musicBrainzGenres(result.data)).toEqual({ cached: ['jazz'], x: ['folk'] });
  });

  it('reports no error when the owner stops the lookup', async () => {
    const cache = new SessionCache(new MemoryStorage());
    const controller = new AbortController();
    const mb = {
      async findArtistGenres() {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    } as unknown as MusicBrainzClient;
    const result = await loadMusicBrainz(mb, liked, cache, ['folk'], () => {}, controller.signal);
    expect(result.error).toBeUndefined();
  });
});

describe('loadWikidata', () => {
  it('looks up only artists it has not answered for, and caches every batch', async () => {
    const cache = new SessionCache(new MemoryStorage());
    cache.set('wikidata.artists', { known: { found: false, labels: [] } });
    const liked = [track({ id: '1', artist: 'known' }), track({ id: '2', artist: 'a' }), track({ id: '3', artist: 'a' }), track({ id: '4', artist: 'b' })];
    const wd = {
      async findArtists(ids: string[], onBatch: (r: Record<string, WikidataArtist>) => void) {
        expect(ids).toEqual(['a', 'b']);
        onBatch({ a: { found: true, mbid: 'mb-a', labels: ['rock music'] } });
        throw new Error('Wikidata request failed with HTTP 500');
      },
    } as unknown as WikidataClient;
    const seen: string[][] = [];
    const result = await loadWikidata(wd, liked, cache, (data) => seen.push(Object.keys(data)));
    expect(result.error).toContain('HTTP 500');
    expect(seen).toEqual([['known', 'a']]);
    expect(cache.get('wikidata.artists')).toEqual(result.data);
  });
});
