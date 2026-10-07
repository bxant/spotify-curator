import { describe, expect, it } from 'vitest';
import { browse, filterOptions, playlistFacets, type Browsable } from '../src/browse';
import { splitParts } from '../src/parts';
import type { CuratedPlaylist, LikedTrack, PlaylistKind, TrackKey } from '../src/types';
import { track } from './fixtures/builders';

function playlist(key: string, kind: PlaylistKind, tracks: LikedTrack[]): CuratedPlaylist {
  return { key, kind, name: key, reason: '', tracks };
}

/** `n` tracks released in `year`, by `artist`, with ids prefixed by `prefix`. */
function tracks(prefix: string, n: number, year: number, artist = `${prefix}-artist`): LikedTrack[] {
  return Array.from({ length: n }, (_, i) => track({ id: `${prefix}${i}`, artist, release: `${year}-06-01` }));
}

const artistGenres: Record<string, string[]> = { rockband: ['rock'], jazzman: ['jazz'], popstar: ['pop', 'dance pop'] };
const trackKeys: Record<string, TrackKey | null> = {};
const inputs = { artistGenres, trackKeys };

describe('playlistFacets', () => {
  it('describes a playlist by its dominant decade, genres, keys and featured artists', () => {
    const list = [...tracks('r', 6, 1994, 'rockband'), ...tracks('j', 3, 1961, 'jazzman'), ...tracks('x', 1, 2020, 'solo')];
    for (const t of list.slice(0, 4)) trackKeys[t.id] = { key: 9, mode: 0 };
    const f = playlistFacets(playlist('favorites', 'favorites', list), inputs);
    expect(f.decade).toBe(1990);
    expect(f.decades).toEqual([1990, 1960]);
    expect(f.genres).toEqual(['rock', 'jazz']);
    expect(f.keys).toEqual([{ id: '9:0', label: 'A minor (8A)' }]);
    expect(f.artists.map((a) => a.id)).toEqual(['rockband', 'jazzman']);
    expect(f.trackCount).toBe(10);
  });

  it('puts the defining value of a bucket playlist first', () => {
    const list = [...tracks('p', 8, 2012, 'popstar'), ...tracks('r', 2, 2012, 'rockband')];
    expect(playlistFacets(playlist('genre:dance pop', 'genre', list), inputs).genres[0]).toBe('dance pop');
    expect(playlistFacets(playlist('artist:rockband', 'artist', list), inputs).artists[0].id).toBe('rockband');
    expect(playlistFacets(playlist('era:2010', 'era', list), inputs).decade).toBe(2010);
    expect(playlistFacets(playlist('key:0:1', 'key', list), inputs).keys[0]).toEqual({ id: '0:1', label: 'C major (8B)' });
  });

  it('describes a later part by the suggestion it was split from', () => {
    const list = [...tracks('p', 25, 2012, 'popstar'), ...tracks('r', 25, 2012, 'rockband')];
    const [, part2] = splitParts(playlist('genre:dance pop', 'genre', list));
    expect(part2.key).toBe('genre:dance pop|part:2');
    // Part 2 holds only rock songs, yet the suggestion's own genre still comes first.
    expect(playlistFacets(part2, inputs).genres).toEqual(['dance pop', 'rock']);
    expect(playlistFacets(part2, inputs).trackCount).toBe(25);
  });
});

describe('browse', () => {
  const items: Browsable[] = [
    playlist('favorites', 'favorites', [...tracks('f', 40, 2015, 'popstar'), ...tracks('g', 10, 1994, 'rockband')]),
    playlist('era:1990', 'era', tracks('n', 20, 1995, 'rockband')),
    playlist('era:1960', 'era', tracks('s', 16, 1964, 'jazzman')),
    playlist('genre:jazz', 'genre', tracks('jz', 30, 1961, 'jazzman')),
    playlist('rediscover', 'rediscover', tracks('rd', 12, 2003)),
  ].map((p) => ({ playlist: p, facets: playlistFacets(p, inputs) }));
  const keys = (list: Browsable[]) => list.map((i) => i.playlist.key);

  it('keeps the curated order by default', () => {
    expect(keys(browse(items, { sort: 'recommended' }))).toEqual(keys(items));
  });

  it('sorts by decade, genre, type and track count, with unknown values last', () => {
    expect(keys(browse(items, { sort: 'decade' }))).toEqual(['era:1960', 'genre:jazz', 'era:1990', 'rediscover', 'favorites']);
    expect(keys(browse(items, { sort: 'genre' }))).toEqual(['favorites', 'era:1960', 'genre:jazz', 'era:1990', 'rediscover']);
    expect(keys(browse(items, { sort: 'type' }))).toEqual(['favorites', 'rediscover', 'genre:jazz', 'era:1990', 'era:1960']);
    expect(keys(browse(items, { sort: 'tracks' }))).toEqual(['favorites', 'genre:jazz', 'era:1990', 'era:1960', 'rediscover']);
  });

  it('filters by type, decade, genre, artist and size', () => {
    expect(keys(browse(items, { sort: 'recommended', kind: 'era' }))).toEqual(['era:1990', 'era:1960']);
    expect(keys(browse(items, { sort: 'recommended', decade: 1990 }))).toEqual(['favorites', 'era:1990']);
    expect(keys(browse(items, { sort: 'recommended', genre: 'jazz' }))).toEqual(['era:1960', 'genre:jazz']);
    expect(keys(browse(items, { sort: 'recommended', artist: 'rockband' }))).toEqual(['favorites', 'era:1990']);
    expect(keys(browse(items, { sort: 'tracks', minTracks: 25 }))).toEqual(['favorites', 'genre:jazz']);
    expect(browse(items, { sort: 'recommended', genre: 'jazz', decade: 1990 })).toEqual([]);
  });

  it('offers only filter values that match a suggestion, with counts', () => {
    const o = filterOptions(items);
    expect(o.kinds).toEqual([
      { id: 'favorites', count: 1 },
      { id: 'rediscover', count: 1 },
      { id: 'genre', count: 1 },
      { id: 'era', count: 2 },
    ]);
    expect(o.decades.map((d) => d.id)).toEqual([1960, 1990, 2000, 2010]);
    expect(o.genres).toEqual([
      { id: 'dance pop', count: 1 },
      { id: 'jazz', count: 2 },
      { id: 'pop', count: 1 },
      { id: 'rock', count: 2 },
    ]);
    expect(o.keys).toEqual([]);
  });

  it('sorts key playlists around the Camelot wheel', () => {
    const keyed = ['key:0:1', 'key:9:0', 'key:7:1'].map((k) => {
      const p = playlist(k, 'key', tracks(k, 3, 2000));
      return { playlist: p, facets: playlistFacets(p, inputs) };
    });
    // C major 8B, A minor 8A, G major 9B.
    expect(keys(browse(keyed, { sort: 'key' }))).toEqual(['key:9:0', 'key:0:1', 'key:7:1']);
  });
});
