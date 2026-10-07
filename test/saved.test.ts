import { describe, expect, it } from 'vitest';
import { trackKey } from '../src/curate';
import {
  APP_TAG,
  DESCRIPTION_MAX,
  TRACK_OVERLAP_MIN,
  appTag,
  matchSaved,
  normalizeName,
  playlistDescription,
  setAsideSaved,
  trackOverlap,
  type SavedMatch,
} from '../src/saved';
import { splitParts } from '../src/parts';
import type { CuratedPlaylist, LikedTrack, PlaylistKind, SavedTracks } from '../src/types';
import { track } from './fixtures/builders';
import {
  legacyBestOf,
  legacyRediscover,
  ownHuge,
  ownSameName,
  renamedApp,
  savedPlaylists,
  taggedGenre,
} from './fixtures/saved-playlists';

function suggestion(key: string, name: string, tracks: LikedTrack[], kind: PlaylistKind = 'genre'): CuratedPlaylist {
  return { key, kind, name, reason: 'Because.', tracks };
}

function songs(prefix: string, n: number): LikedTrack[] {
  return Array.from({ length: n }, (_, i) => track({ id: `${prefix}${i}` }));
}

function tracksOf(list: LikedTrack[]): SavedTracks {
  return { ids: list.map((t) => t.id), keys: list.map((t) => trackKey(t.name, t.artists[0]?.id)) };
}

const favorites = suggestion('favorites', 'Real Favorites', songs('fav', 10), 'favorites');
const rediscover = suggestion('rediscover', 'Rediscover: Liked, Then Forgotten', songs('re', 50), 'rediscover');
const bestOf = suggestion('best-of-albums', 'Best of Each Album', songs('bo', 31), 'best-of-albums');
const indie = suggestion('genre:indie rock', 'Genre: Indie Rock', songs('ir', 100));
const jazz = suggestion('genre:jazz', 'Genre: Jazz', songs('jz', 10));
const nineties = suggestion('era:1990', 'The 1990s', songs('n', 100), 'era');

describe('the app tag', () => {
  it('ends every description the app writes, within Spotify’s limit', () => {
    expect(playlistDescription('Liked   and\nplayed.')).toBe(`Liked and played. ${APP_TAG}`);
    const long = playlistDescription('x'.repeat(400));
    expect(long).toHaveLength(DESCRIPTION_MAX);
    expect(long.endsWith(`x… ${APP_TAG}`)).toBe(true);
    expect(appTag(long)).toBe('tagged');
  });

  it('recognizes the tag, the older plain ending, and nothing else', () => {
    expect(appTag(taggedGenre.description)).toBe('tagged');
    expect(appTag(legacyRediscover.description)).toBe('legacy');
    expect(appTag('Songs I &quot;love&quot;. CURATED FROM LIKED SONGS.')).toBe('legacy');
    expect(appTag('my picks')).toBeNull();
    expect(appTag('')).toBeNull();
  });

  it('compares names ignoring case, spacing, escapes and compatibility forms', () => {
    expect(normalizeName('  Genre:  Indie\tRock ')).toBe(normalizeName('genre: indie rock'));
    expect(normalizeName('Rock &amp; Roll')).toBe(normalizeName('Rock & Roll'));
    expect(normalizeName('Key of Ｃ major')).toBe(normalizeName('Key of C major'));
    expect(normalizeName('The 1990s')).not.toBe(normalizeName('The 1980s'));
  });
});

describe('trackOverlap', () => {
  it('counts shared tracks against the larger playlist, matching relinked tracks by name and artist', () => {
    const list = songs('t', 10);
    expect(trackOverlap(suggestion('k', 'n', list), tracksOf(list))).toBe(1);
    expect(trackOverlap(suggestion('k', 'n', list.slice(0, 5)), tracksOf(list))).toBe(0.5);
    const relinked = { ids: ['other-id', ...list.slice(1).map((t) => t.id)], keys: tracksOf(list).keys };
    expect(trackOverlap(suggestion('k', 'n', list), relinked)).toBe(1);
    expect(trackOverlap(suggestion('k', 'n', []), { ids: [], keys: [] })).toBe(0);
  });
});

describe('matchSaved', () => {
  it('recognizes app playlists from earlier sessions by name, without reading their tracks', () => {
    const { matches, needTracks } = matchSaved([rediscover, bestOf, indie, jazz], savedPlaylists, {
      [renamedApp.id]: tracksOf(songs('unrelated', 10)),
    });
    expect(matches.get('rediscover')).toEqual({ playlist: legacyRediscover, by: 'name' });
    expect(matches.get('best-of-albums')).toEqual({ playlist: legacyBestOf, by: 'name' });
    expect(matches.get('genre:indie rock')).toEqual({ playlist: taggedGenre, by: 'name' });
    expect(matches.has('genre:jazz')).toBe(false);
    expect(needTracks).toEqual([]);
  });

  it('matches an app playlist by name even when the suggestion’s tracks have moved on', () => {
    const changed = { ...rediscover, tracks: songs('new', 50) };
    expect(matchSaved([changed], [legacyRediscover], {}).matches.get('rediscover')?.by).toBe('name');
  });

  it('prefers a tagged playlist over an older one with the same name', () => {
    const older = { ...legacyRediscover, id: 'older' };
    const tagged = { ...legacyRediscover, id: 'tagged', description: `Picked. ${APP_TAG}` };
    expect(matchSaved([rediscover], [older, tagged], {}).matches.get('rediscover')?.playlist.id).toBe('tagged');
  });

  it('asks for the tracks of a same-named playlist the app did not tag, then matches only a high overlap', () => {
    const first = matchSaved([favorites], [ownSameName], {});
    expect(first.matches.size).toBe(0);
    expect(first.needTracks).toEqual([ownSameName.id]);

    const same = matchSaved([favorites], [ownSameName], { [ownSameName.id]: tracksOf(favorites.tracks.slice(0, 8)) });
    expect(same.matches.get('favorites')).toEqual({ playlist: ownSameName, by: 'tracks' });
    expect(same.needTracks).toEqual([]);

    const different = matchSaved([favorites], [ownSameName], { [ownSameName.id]: tracksOf(favorites.tracks.slice(0, 5)) });
    expect(TRACK_OVERLAP_MIN).toBeGreaterThan(0.5);
    expect(different.matches.size).toBe(0);
  });

  it('does not read a playlist whose size alone rules out a match', () => {
    const { matches, needTracks } = matchSaved([nineties], [ownHuge], {});
    expect(matches.size).toBe(0);
    expect(needTracks).toEqual([]);
  });

  it('recognizes a renamed app playlist by its tracks', () => {
    const jazzTracks = tracksOf(jazz.tracks.slice(0, 9));
    const asked = matchSaved([jazz], [renamedApp], {});
    expect(asked.needTracks).toEqual([renamedApp.id]);
    expect(matchSaved([jazz], [renamedApp], { [renamedApp.id]: jazzTracks }).matches.get('genre:jazz')).toEqual({
      playlist: renamedApp,
      by: 'tracks',
    });
  });

  it('lets an app playlist saved whole, before parts, account for the later parts it holds', () => {
    const all = songs('indie', 100);
    const parts = splitParts(suggestion('genre:indie rock', 'Genre: Indie Rock', all));
    const other = { ...parts[3], tracks: songs('other', 25) };
    const asked = matchSaved([...parts.slice(0, 3), other], [taggedGenre], {});
    expect(asked.needTracks).toEqual([taggedGenre.id]);
    expect([...asked.matches.keys()]).toEqual(['genre:indie rock']);

    const { matches } = matchSaved([...parts.slice(0, 3), other], [taggedGenre], { [taggedGenre.id]: tracksOf(all) });
    expect([...matches.entries()].map(([key, m]) => [key, m.by])).toEqual([
      ['genre:indie rock', 'name'],
      ['genre:indie rock|part:2', 'tracks'],
      ['genre:indie rock|part:3', 'tracks'],
    ]);
  });

  it('never needs tracks for untagged playlists whose names match no suggestion', () => {
    expect(matchSaved([jazz], [savedPlaylists[6]], {}).needTracks).toEqual([]);
  });
});

describe('setAsideSaved', () => {
  // Candidates in rank order; two slots, like a capped list of genre playlists.
  const candidates = [indie, jazz, suggestion('genre:folk', 'Genre: Folk', songs('fk', 10)), suggestion('genre:soul', 'Genre: Soul', songs('sl', 10))];
  const curateExcluding = (exclude: ReadonlySet<string>) => candidates.filter((p) => !exclude.has(p.key)).slice(0, 2);
  const savedAs = (names: Record<string, string>) => (playlists: CuratedPlaylist[], matched: ReadonlySet<string>) => {
    const matches = new Map<string, SavedMatch>();
    for (const p of playlists) {
      const id = names[p.key];
      if (id && !matched.has(id)) matches.set(p.key, { playlist: { ...taggedGenre, id, name: p.name }, by: 'name' });
    }
    return matches;
  };

  it('replaces saved suggestions with the next candidates, round after round', () => {
    const { fresh, saved } = setAsideSaved(curateExcluding, savedAs({ 'genre:indie rock': 'a', 'genre:folk': 'b' }));
    expect(fresh.map((p) => p.key)).toEqual(['genre:jazz', 'genre:soul']);
    expect(saved.map((s) => [s.playlist.key, s.match.playlist.id])).toEqual([
      ['genre:indie rock', 'a'],
      ['genre:folk', 'b'],
    ]);
  });

  it('does not let one saved playlist account for two suggestions', () => {
    const { fresh, saved } = setAsideSaved(curateExcluding, savedAs({ 'genre:indie rock': 'same', 'genre:folk': 'same' }));
    expect(saved.map((s) => s.playlist.key)).toEqual(['genre:indie rock']);
    expect(fresh.map((p) => p.key)).toEqual(['genre:jazz', 'genre:folk']);
  });

  it('curates once when nothing is saved, and stops after the last round', () => {
    let calls = 0;
    const counting = (exclude: ReadonlySet<string>) => (calls++, curateExcluding(exclude));
    expect(setAsideSaved(counting, () => new Map()).fresh).toEqual([indie, jazz]);
    expect(calls).toBe(1);

    const everything = savedAs(Object.fromEntries(candidates.map((p, i) => [p.key, `id${i}`])));
    const { fresh, saved } = setAsideSaved(curateExcluding, everything, 2);
    expect(saved).toHaveLength(4);
    expect(fresh).toEqual([]);
  });
});
