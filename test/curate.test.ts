import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  camelot,
  capPerArtist,
  curate,
  detectAlbumStacks,
  keyName,
  playScores,
  spreadSample,
  thinAlbumStacks,
} from '../src/curate';
import type { CuratedPlaylist, LikedTrack, TrackKey } from '../src/types';
import { NOW, bulkAlbum, history, ref, track } from './fixtures/builders';

const find = (playlists: CuratedPlaylist[], key: string) => playlists.find((p) => p.key === key);
const ids = (tracks: LikedTrack[]) => tracks.map((t) => t.id);

/** `n` singles by distinct artists, liked `daysAgo` days ago, one per day. */
function singles(prefix: string, n: number, opts: { daysAgo?: number; release?: string; artist?: (i: number) => string } = {}) {
  return Array.from({ length: n }, (_, i) =>
    track({
      id: `${prefix}${i}`,
      artist: opts.artist ? opts.artist(i) : `${prefix}-artist${i}`,
      addedDaysAgo: (opts.daysAgo ?? 400) + i,
      release: opts.release,
    }),
  );
}

describe('playScores', () => {
  it('scores only tracks with listening evidence, ranking higher and recent ranges above lower ones', () => {
    const liked = singles('s', 5);
    const scores = playScores(
      liked,
      history({
        top: { short_term: [ref(liked[0]), ref(liked[1])], long_term: [ref(liked[2])] },
        recent: [ref(liked[3])],
      }),
    );
    expect([...scores.keys()].sort()).toEqual(['s0', 's1', 's2', 's3']);
    expect(scores.get('s0')).toBeGreaterThan(scores.get('s1')!);
    expect(scores.get('s1')).toBeGreaterThan(scores.get('s2')!);
    expect(scores.has('s4')).toBe(false);
  });

  it('matches relinked tracks by name and primary artist when IDs differ', () => {
    const liked = [track({ id: 'orig', name: 'Same Song', artist: 'band' })];
    const scores = playScores(liked, history({ recent: [{ id: 'relinked', name: ' same  song ', artistIds: ['band'] }] }));
    expect(scores.has('orig')).toBe(true);
  });

  it('caps the weight of repeated recent plays', () => {
    const liked = singles('s', 2);
    const scores = playScores(
      liked,
      history({ recent: [...Array(10).fill(ref(liked[0])), ...Array(3).fill(ref(liked[1]))] }),
    );
    expect(scores.get('s0')).toBe(scores.get('s1'));
  });
});

describe('detectAlbumStacks', () => {
  it('detects an album liked whole in one sitting and separates tracks liked on their own', () => {
    const bulk = bulkAlbum('lp', 'band', 8, { albumTracks: 10 });
    const early = track({ id: 'lp-single', artist: 'band', album: 'lp', albumTracks: 10, addedDaysAgo: 600, trackNumber: 9 });
    const stacks = detectAlbumStacks([...bulk, early]);
    const stack = stacks.get('lp');
    expect(stack).toBeDefined();
    expect(ids(stack!.bulk).sort()).toEqual(ids(bulk).sort());
    expect(ids(stack!.separate)).toEqual(['lp-single']);
  });

  it('ignores albums whose tracks were liked one by one over time', () => {
    const spread = Array.from({ length: 6 }, (_, i) =>
      track({ id: `a${i}`, album: 'slow', artist: 'band', albumTracks: 8, addedDaysAgo: 100 + i * 10 }),
    );
    expect(detectAlbumStacks(spread).size).toBe(0);
  });

  it('ignores a few bulk likes from a long album', () => {
    expect(detectAlbumStacks(bulkAlbum('long', 'band', 4, { albumTracks: 20 })).size).toBe(0);
  });

  it('ignores albums with fewer liked tracks than the minimum', () => {
    expect(detectAlbumStacks(bulkAlbum('ep', 'band', LIMITS.bulkMinTracks - 1)).size).toBe(0);
  });
});

describe('thinAlbumStacks', () => {
  it('keeps played or separately liked tracks, or one stable pick when nothing was played', () => {
    const played = bulkAlbum('p', 'band', 6);
    const unplayed = bulkAlbum('u', 'other', 6);
    const loose = singles('s', 3);
    const liked = [...played, ...unplayed, ...loose];
    const scores = playScores(liked, history({ recent: [ref(played[2])] }));
    const thinned = thinAlbumStacks(liked, detectAlbumStacks(liked), scores);

    expect(ids(thinned.filter((t) => t.album.id === 'p'))).toEqual(['p-t3']);
    const fromUnplayed = thinned.filter((t) => t.album.id === 'u');
    expect(fromUnplayed).toHaveLength(1);
    expect(ids(thinned).filter((id) => id.startsWith('s'))).toEqual(['s0', 's1', 's2']);

    // Stable across calls and input order.
    const again = thinAlbumStacks([...liked].reverse(), detectAlbumStacks(liked), scores);
    expect(again.filter((t) => t.album.id === 'u')[0].id).toBe(fromUnplayed[0].id);
  });
});

describe('curate: favorites', () => {
  it('lists played liked songs, most played first', () => {
    const liked = singles('s', 10);
    const top = [liked[3], liked[7], liked[1], liked[5], liked[9], liked[0]];
    const { playlists } = curate(liked, history({ top: { short_term: top.map(ref) } }), { now: NOW });
    const favorites = find(playlists, 'favorites');
    expect(favorites?.name).toBe('Real Favorites');
    expect(ids(favorites!.tracks)).toEqual(ids(top));
  });

  it('is omitted without enough listening evidence', () => {
    const liked = singles('s', 10);
    const { playlists } = curate(liked, history({ recent: [ref(liked[0])] }), { now: NOW });
    expect(find(playlists, 'favorites')).toBeUndefined();
  });
});

describe('curate: rediscover', () => {
  it('picks old, unplayed songs liked one by one, capped per artist and in total', () => {
    const many = singles('old', 120, { artist: (i) => `artist${i % 40}` });
    const played = singles('played', 5);
    const recent = singles('new', 5, { daysAgo: 10 });
    const bulk = bulkAlbum('lp', 'bulkband', 10);
    const liked = [...many, ...played, ...recent, ...bulk];
    const { playlists } = curate(liked, history({ top: { medium_term: played.map(ref) } }), { now: NOW });
    const rediscover = find(playlists, 'rediscover')!;

    expect(rediscover.tracks).toHaveLength(LIMITS.rediscoverTracks);
    const chosen = ids(rediscover.tracks);
    expect(chosen.every((id) => id.startsWith('old'))).toBe(true);
    const perArtist = new Map<string, number>();
    for (const t of rediscover.tracks) perArtist.set(t.artists[0].id, (perArtist.get(t.artists[0].id) ?? 0) + 1);
    expect(Math.max(...perArtist.values())).toBeLessThanOrEqual(LIMITS.perArtistRediscover);
    expect(rediscover.reason).toContain('120 songs');
  });

  it('spreads picks across the whole liked-at timeline', () => {
    const liked = singles('old', 200);
    const { playlists } = curate(liked, history(), { now: NOW });
    const tracks = find(playlists, 'rediscover')!.tracks;
    const times = tracks.map((t) => Date.parse(t.addedAt));
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(150 * 24 * 60 * 60 * 1000);
  });
});

describe('curate: best of each album', () => {
  it('thins albums liked whole to the tracks played or liked on their own', () => {
    const a = bulkAlbum('a', 'band-a', 10, { daysAgo: 200 });
    const b = bulkAlbum('b', 'band-b', 8, { daysAgo: 100 });
    const bSingle = track({ id: 'b-single', artist: 'band-b', album: 'b', albumTracks: 8, addedDaysAgo: 500, trackNumber: 2 });
    const c = bulkAlbum('c', 'band-c', 6);
    const liked = [...a, ...b, bSingle, ...c, ...singles('s', 5)];
    const h = history({ top: { long_term: [ref(a[4]), ref(a[1]), ref(b[6])] }, recent: [ref(a[7])] });
    const { playlists, stats } = curate(liked, h, { now: NOW });
    const best = find(playlists, 'best-of-albums')!;

    // Most recently bulk-liked album first; album order within each album.
    expect(ids(best.tracks)).toEqual(['b-single', 'b-t7', 'a-t2', 'a-t5', 'a-t8']);
    expect(stats.stackedAlbums).toBe(3);
    expect(stats.stackedTracks).toBe(24);
    expect(best.reason).toContain('3 albums');
  });
});

describe('curate: genres', () => {
  const rock = singles('r', 20, { artist: (i) => `rock${i % 10}` });
  const jazz = singles('j', 16, { artist: (i) => `jazz${i % 8}` });
  const rare = singles('x', 5, { artist: () => 'rare' });
  const liked = [...rock, ...jazz, ...rare];
  const artistGenres: Record<string, string[]> = { rare: ['polka'] };
  for (let i = 0; i < 10; i++) artistGenres[`rock${i}`] = ['indie rock', 'rock'];
  for (let i = 0; i < 8; i++) artistGenres[`jazz${i}`] = ['jazz'];

  it('builds a playlist per sizable genre, dropping near-duplicate genres', () => {
    const { playlists, stats } = curate(liked, history(), { now: NOW, artistGenres });
    const genres = playlists.filter((p) => p.kind === 'genre');
    expect(genres.map((p) => p.name)).toEqual(['Genre: Indie Rock', 'Genre: Jazz']);
    expect(genres[0].tracks).toHaveLength(20);
    expect(stats.tracksWithGenres).toBe(41);
  });

  it('caps tracks per artist inside a genre playlist', () => {
    const heavy = singles('h', 30, { artist: (i) => (i < 20 ? 'one' : `other${i}`) });
    const { playlists } = curate(heavy, history(), {
      now: NOW,
      artistGenres: Object.fromEntries(heavy.map((t) => [t.artists[0].id, ['shoegaze']])),
    });
    const shoegaze = find(playlists, 'genre:shoegaze')!;
    expect(shoegaze.tracks.filter((t) => t.artists[0].id === 'one')).toHaveLength(LIMITS.perArtistBucket);
  });

  it('degrades to no genre playlists when genres are unavailable', () => {
    const { playlists, stats } = curate(liked, history(), { now: NOW });
    expect(playlists.some((p) => p.kind === 'genre')).toBe(false);
    expect(stats.tracksWithGenres).toBe(0);
  });
});

describe('curate: musical keys', () => {
  it('groups songs by key and mode, largest groups first', () => {
    const liked = singles('k', 40);
    const trackKeys: Record<string, TrackKey | null> = {};
    liked.forEach((t, i) => {
      if (i < 20) trackKeys[t.id] = { key: 9, mode: 0 }; // A minor
      else if (i < 36) trackKeys[t.id] = { key: 0, mode: 1 }; // C major
      else if (i < 38) trackKeys[t.id] = { key: 2, mode: 1 }; // too few
      else trackKeys[t.id] = null; // unknown
    });
    const { playlists, stats } = curate(liked, history(), { now: NOW, trackKeys });
    const keys = playlists.filter((p) => p.kind === 'key');
    expect(keys.map((p) => [p.key, p.name, p.tracks.length])).toEqual([
      ['key:9:0', 'Key of A Minor', 20],
      ['key:0:1', 'Key of C Major', 16],
    ]);
    expect(keys[0].reason).toContain('Camelot 8A');
    expect(stats.tracksWithKey).toBe(38);
  });

  it('degrades to no key playlists when keys are unavailable', () => {
    const { playlists } = curate(singles('k', 40), history(), { now: NOW, trackKeys: {} });
    expect(playlists.some((p) => p.kind === 'key')).toBe(false);
  });

  it('names keys and maps them onto the Camelot wheel', () => {
    expect(keyName({ key: 3, mode: 1 })).toBe('E♭ major');
    expect(camelot({ key: 0, mode: 1 })).toBe('8B');
    expect(camelot({ key: 9, mode: 0 })).toBe('8A');
    expect(camelot({ key: 11, mode: 1 })).toBe('1B');
    expect(camelot({ key: 8, mode: 0 })).toBe('1A');
    expect(camelot({ key: 4, mode: 1 })).toBe('12B');
  });
});

describe('curate: decades', () => {
  it('groups by release decade in chronological order, with album stacks thinned', () => {
    const nineties = singles('n', 15, { release: '1994-03-02' });
    const eighties = singles('e', 16, { release: '1987' });
    const bulk = bulkAlbum('lp', 'band', 12, { release: '1999-10-10' });
    const odd = [track({ id: 'nodate', release: '' })];
    const { playlists } = curate([...nineties, ...eighties, ...bulk, ...odd], history(), { now: NOW });
    const eras = playlists.filter((p) => p.kind === 'era');
    expect(eras.map((p) => p.name)).toEqual(['The 1980s', 'The 1990s']);
    const nineties90s = eras[1].tracks;
    expect(nineties90s).toHaveLength(16); // 15 singles + 1 representative of the unplayed album
    expect(nineties90s.at(-1)?.album.id).toBe('lp'); // release order
  });

  it('prefers played tracks when a decade exceeds the playlist size', () => {
    const liked = singles('d', 150, { release: '2005-01-01' });
    const played = [liked[140], liked[141]];
    const { playlists } = curate(liked, history({ recent: played.map(ref) }), { now: NOW });
    const era = find(playlists, 'era:2000')!;
    expect(era.tracks).toHaveLength(LIMITS.maxTracks);
    expect(ids(era.tracks)).toEqual(expect.arrayContaining(['d140', 'd141']));
  });
});

describe('curate: overall', () => {
  it('is deterministic and never repeats a track within a playlist', () => {
    const liked = [
      ...singles('s', 200, { artist: (i) => `a${i % 30}` }).map((t, i) => ({
        ...t,
        album: { ...t.album, releaseDate: `${1970 + (i % 50)}-01-01` },
      })),
      ...bulkAlbum('lp1', 'x', 12),
      ...bulkAlbum('lp2', 'y', 9),
    ];
    const h = history({ top: { short_term: liked.slice(0, 30).map(ref) }, recent: liked.slice(200, 205).map(ref) });
    const genres = Object.fromEntries(liked.map((t) => [t.artists[0].id, [t.artists[0].id < 'a2' ? 'pop' : 'folk']]));
    const first = curate(liked, h, { now: NOW, artistGenres: genres });
    const second = curate(liked, h, { now: NOW, artistGenres: genres });
    expect(second).toEqual(first);
    for (const p of first.playlists) expect(new Set(ids(p.tracks)).size).toBe(p.tracks.length);
    expect(first.playlists.map((p) => p.kind)).toEqual(
      expect.arrayContaining(['favorites', 'rediscover', 'best-of-albums', 'genre', 'era']),
    );
  });

  it('ignores duplicate liked entries and handles an empty library', () => {
    const t = track({ id: 'dup' });
    expect(curate([t, t], history(), { now: NOW }).stats.likedCount).toBe(1);
    expect(curate([], history(), { now: NOW }).playlists).toEqual([]);
  });
});

describe('helpers', () => {
  it('spreadSample picks evenly and returns short lists whole', () => {
    expect(spreadSample([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(spreadSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)).toEqual([0, 2, 4, 6, 8]);
    expect(spreadSample([1, 2], 0)).toEqual([]);
  });

  it('capPerArtist keeps the first N per primary artist', () => {
    const tracks = singles('c', 6, { artist: (i) => (i % 2 ? 'odd' : 'even') });
    expect(ids(capPerArtist(tracks, 2))).toEqual(['c0', 'c1', 'c2', 'c3']);
  });
});
