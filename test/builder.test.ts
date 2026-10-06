import { describe, expect, it } from 'vitest';
import {
  BUILD_LIMITS,
  BUILT_KEY,
  buildChoices,
  buildName,
  buildPlaylist,
  clampCount,
  criteriaId,
  emptyCriteria,
  matchingTracks,
  type BuildCriteria,
  type BuildInputs,
} from '../src/builder';
import type { LikedTrack, TrackKey } from '../src/types';
import { track } from './fixtures/builders';

const ids = (tracks: LikedTrack[]) => tracks.map((t) => t.id);
const criteria = (c: Partial<BuildCriteria>): BuildCriteria => ({ ...emptyCriteria(), ...c });
const inputs = (parts: Partial<BuildInputs> = {}): BuildInputs => ({ artistGenres: {}, trackKeys: {}, scores: new Map(), ...parts });
const overlap = (a: LikedTrack[], b: LikedTrack[]) => a.filter((t) => ids(b).includes(t.id)).length;

/** `n` songs by `artists` distinct artists (round-robin), released in `release`. */
function songs(prefix: string, n: number, opts: { artists?: number; release?: string } = {}): LikedTrack[] {
  const artists = opts.artists ?? n;
  return Array.from({ length: n }, (_, i) => track({ id: `${prefix}${i}`, artist: `${prefix}-a${i % artists}`, release: opts.release }));
}

describe('matchingTracks', () => {
  const rock90 = track({ id: 'rock90', artist: 'rocker', release: '1994-01-01' });
  const rock00 = track({ id: 'rock00', artist: 'rocker', release: '2003' });
  const jazz90 = track({ id: 'jazz90', artist: 'jazzer', release: '1991-06' });
  const feat = track({ id: 'feat', artist: 'jazzer', extraArtists: ['rocker'], release: '1975' });
  const noYear = track({ id: 'noyear', artist: 'rocker', release: '' });
  const liked = [rock90, rock00, jazz90, feat, noYear];
  const known = {
    artistGenres: { rocker: ['rock', 'indie'], jazzer: ['jazz'] },
    trackKeys: { rock90: { key: 9, mode: 0 }, jazz90: { key: 0, mode: 1 }, rock00: null } as Record<string, TrackKey | null>,
  };
  const match = (c: Partial<BuildCriteria>) => ids(matchingTracks(liked, criteria(c), known));

  it('matches everything when nothing is chosen', () => {
    expect(match({})).toEqual(ids(liked));
  });

  it('matches any chosen value within a kind', () => {
    expect(match({ genres: ['jazz', 'indie'] })).toEqual(ids(liked));
    expect(match({ decades: [1990, 1970] })).toEqual(['rock90', 'jazz90', 'feat']);
  });

  it('needs every chosen kind to match', () => {
    expect(match({ genres: ['rock'], decades: [1990] })).toEqual(['rock90']);
    expect(match({ genres: ['jazz'], decades: [1990, 2000] })).toEqual(['jazz90']);
  });

  it('counts a featured artist for artist and genre choices', () => {
    expect(match({ artists: ['rocker'] })).toEqual(['rock90', 'rock00', 'feat', 'noyear']);
    expect(match({ genres: ['rock'], decades: [1970] })).toEqual(['feat']);
  });

  it('leaves out songs whose year or key is unknown when that kind is chosen', () => {
    expect(match({ decades: [2000] })).toEqual(['rock00']);
    expect(match({ keys: ['9:0', '0:1'] })).toEqual(['rock90', 'jazz90']);
    expect(match({ keys: ['9:1'] })).toEqual([]);
  });

  it('lists each liked song once', () => {
    expect(ids(matchingTracks([rock90, rock90], criteria({}), known))).toEqual(['rock90']);
  });
});

describe('buildPlaylist', () => {
  it('returns null when nothing matches', () => {
    expect(buildPlaylist(songs('s', 10), criteria({ genres: ['polka'] }), inputs(), { seed: 0 })).toBeNull();
  });

  it('picks exactly the requested number of songs when more match', () => {
    const liked = songs('s', 80, { artists: 40 });
    for (const count of [5, 10, 25, 50]) {
      const result = buildPlaylist(liked, criteria({ count }), inputs(), { seed: 1 });
      expect(result?.playlist.tracks).toHaveLength(count);
      expect(new Set(ids(result!.playlist.tracks)).size).toBe(count);
      expect(result).toMatchObject({ matched: 80, requested: count });
    }
  });

  it('keeps the count within the allowed range', () => {
    const liked = songs('s', 200);
    expect(buildPlaylist(liked, criteria({ count: 1 }), inputs(), { seed: 0 })?.playlist.tracks).toHaveLength(BUILD_LIMITS.minCount);
    expect(buildPlaylist(liked, criteria({ count: 500 }), inputs(), { seed: 0 })?.playlist.tracks).toHaveLength(BUILD_LIMITS.maxCount);
  });

  it('includes every match and says so when fewer songs match than requested', () => {
    const liked = [...songs('old', 7, { release: '1985' }), ...songs('new', 30, { release: '2015' })];
    const result = buildPlaylist(liked, criteria({ decades: [1980], count: 25 }), inputs(), { seed: 0 });
    expect(result).toMatchObject({ matched: 7, requested: 25 });
    expect(ids(result!.playlist.tracks).sort()).toEqual(ids(liked.slice(0, 7)).sort());
    expect(result!.playlist.reason).toContain('7 of your liked songs are from the 1980s, fewer than the 25 you asked for');
  });

  it('is reproducible for the same seed and differs for another', () => {
    const liked = songs('s', 300, { artists: 100 });
    const pick = (seed: number) => ids(buildPlaylist(liked, criteria({ count: 20 }), inputs(), { seed })!.playlist.tracks);
    expect(pick(3)).toEqual(pick(3));
    expect(pick(4)).not.toEqual(pick(3));
  });

  it('tries songs not picked before when retrying with the same choices', () => {
    const liked = songs('s', 30, { artists: 15 });
    const c = criteria({ count: 10 });
    const first = buildPlaylist(liked, c, inputs(), { seed: 1 })!.playlist.tracks;
    const second = buildPlaylist(liked, c, inputs(), { seed: 2, previous: [ids(first)] })!.playlist.tracks;
    const third = buildPlaylist(liked, c, inputs(), { seed: 3, previous: [ids(first), ids(second)] })!.playlist.tracks;
    expect(overlap(first, second)).toBe(0);
    expect(overlap(first, third) + overlap(second, third)).toBe(0);
    expect(new Set([...ids(first), ...ids(second), ...ids(third)]).size).toBe(30);
  });

  it('fills up with the songs picked longest ago once the unpicked ones run out', () => {
    const liked = songs('s', 15);
    const c = criteria({ count: 10 });
    const first = buildPlaylist(liked, c, inputs(), { seed: 1 })!.playlist.tracks;
    const unpicked = liked.filter((t) => !ids(first).includes(t.id));
    const second = buildPlaylist(liked, c, inputs(), { seed: 2, previous: [ids(first)] })!.playlist.tracks;
    expect(second).toHaveLength(10);
    expect(ids(second)).toEqual(expect.arrayContaining(ids(unpicked)));

    // Third try: the five songs only the first try had come before the ones the second try had.
    const onlyFirst = ids(first).filter((id) => !ids(second).includes(id));
    const third = buildPlaylist(liked, c, inputs(), { seed: 3, previous: [ids(first), ids(second)] })!.playlist.tracks;
    expect(ids(third)).toEqual(expect.arrayContaining(onlyFirst));
  });

  it('spreads picks across artists before taking a second song by anyone', () => {
    // 3 artists with 20 songs each and 10 artists with 1 song each.
    const liked = [...songs('big', 60, { artists: 3 }), ...songs('one', 10)];
    for (const seed of [1, 2, 3]) {
      const tracks = buildPlaylist(liked, criteria({ count: 13 }), inputs(), { seed })!.playlist.tracks;
      expect(new Set(tracks.map((t) => t.artists[0].id)).size).toBe(13);
    }
    const counts = new Map<string, number>();
    for (const t of buildPlaylist(liked, criteria({ count: 40 }), inputs(), { seed: 1 })!.playlist.tracks) {
      counts.set(t.artists[0].id, (counts.get(t.artists[0].id) ?? 0) + 1);
    }
    // 10 singles, then the 30 left split evenly over the three big artists.
    expect([...counts.values()].sort((a, b) => b - a).slice(0, 3)).toEqual([10, 10, 10]);
  });

  it('still fills the count from one artist when only one artist matches', () => {
    const liked = songs('solo', 30, { artists: 1 });
    const result = buildPlaylist(liked, criteria({ artists: ['solo-a0'], count: 10 }), inputs(), { seed: 1 });
    expect(result?.playlist.tracks).toHaveLength(10);
    expect(result?.playlist.reason).toContain('all by one artist');
  });

  it('favors played songs without always picking the same ones', () => {
    const liked = songs('s', 200);
    const played = new Map(liked.slice(0, 100).map((t) => [t.id, 10]));
    let playedPicks = 0;
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const tracks = buildPlaylist(liked, criteria({ count: 10 }), inputs({ scores: played }), { seed })!.playlist.tracks;
      playedPicks += tracks.filter((t) => played.has(t.id)).length;
      for (const t of tracks) seen.add(t.id);
    }
    expect(playedPicks).toBeGreaterThan(120);
    expect(playedPicks).toBeLessThan(200);
    expect(seen.size).toBeGreaterThan(100);
  });

  it('names and describes the playlist after the choices', () => {
    const liked = [
      ...songs('r', 20, { release: '1995' }).map((t) => ({ ...t, artists: [{ id: 'rocker', name: 'The Rockers' }] })),
      ...songs('x', 5, { release: '1995' }),
    ];
    const known = { artistGenres: { rocker: ['indie rock', 'grunge'] }, trackKeys: {} };
    const result = buildPlaylist(liked, criteria({ genres: ['grunge', 'indie rock'], decades: [1990], count: 10 }), inputs(known), { seed: 0 })!;
    expect(result.playlist).toMatchObject({ key: BUILT_KEY, kind: 'custom', name: 'Your Mix: Grunge + Indie Rock · 1990s' });
    expect(result.playlist.reason).toBe(
      '20 of your liked songs are tagged grunge or indie rock and from the 1990s; 10 picked at random, played favorites more likely, all by one artist.',
    );
  });
});

describe('buildName', () => {
  it('shortens long lists and names keys and artists', () => {
    const names = new Map([['a1', 'Björk']]);
    expect(buildName(criteria({}), names)).toBe('Your Mix');
    expect(buildName(criteria({ decades: [1970, 1980, 1990, 2000] }), names)).toBe('Your Mix: 1970s, 1980s + 2 more');
    expect(buildName(criteria({ keys: ['9:0'], artists: ['a1'] }), names)).toBe('Your Mix: A minor · Björk');
  });
});

describe('criteriaId and clampCount', () => {
  it('ignores choice order and duplicates', () => {
    expect(criteriaId(criteria({ genres: ['b', 'a', 'a'], decades: [2000, 1990] }))).toBe(criteriaId(criteria({ genres: ['a', 'b'], decades: [1990, 2000] })));
    expect(criteriaId(criteria({ count: 10 }))).not.toBe(criteriaId(criteria({ count: 20 })));
  });

  it('rounds and clamps the count', () => {
    expect(clampCount(12.4)).toBe(12);
    expect(clampCount(0)).toBe(BUILD_LIMITS.minCount);
    expect(clampCount(1000)).toBe(BUILD_LIMITS.maxCount);
    expect(clampCount(Number.NaN)).toBe(BUILD_LIMITS.defaultCount);
  });
});

describe('buildChoices', () => {
  it('lists every genre, decade, key and artist in the library with song counts', () => {
    const liked = [
      track({ id: 'a', artist: 'x', release: '1994' }),
      track({ id: 'b', artist: 'x', release: '1999', extraArtists: ['y'] }),
      track({ id: 'c', artist: 'y', release: '2001' }),
      track({ id: 'c', artist: 'y', release: '2001' }),
    ];
    const choices = buildChoices(liked, {
      artistGenres: { x: ['rock'], y: ['rock', 'jazz'] },
      trackKeys: { a: { key: 9, mode: 0 }, b: { key: 0, mode: 1 }, c: null },
    });
    expect(choices.genres).toEqual([
      { id: 'rock', count: 3 },
      { id: 'jazz', count: 2 },
    ]);
    expect(choices.decades).toEqual([
      { id: 1990, count: 2 },
      { id: 2000, count: 1 },
    ]);
    expect(choices.keys.map((k) => k.label)).toEqual(['A minor (8A)', 'C major (8B)']);
    expect(choices.artists).toEqual([
      { id: 'x', label: 'X', count: 2 },
      { id: 'y', label: 'Y', count: 2 },
    ]);
  });
});
