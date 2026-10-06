import { describe, expect, it } from 'vitest';
import type { BrowseCriteria } from '../src/browse';
import { formatRoute, homeHref, isMusiciansRoute, musiciansHref, musiciansPlaylistHref, parentRoute, parseRoute, playlistHref } from '../src/route';

describe('parseRoute', () => {
  it('treats an empty or unknown hash as the recommendations with default sort', () => {
    for (const hash of ['', '#', '#/', '#/nowhere', '#/playlist/']) {
      expect(parseRoute(hash)).toEqual({ name: 'home', criteria: { sort: 'recommended' } });
    }
  });

  it('opens a playlist page by its key', () => {
    expect(parseRoute('#/playlist/favorites')).toEqual({ name: 'playlist', key: 'favorites' });
  });

  it('ignores malformed sort and filter values instead of trusting them', () => {
    expect(parseRoute('#/?sort=loudest&type=mixtape&decade=90s&key=C&size=-5&genre=&artist=')).toEqual({
      name: 'home',
      criteria: { sort: 'recommended' },
    });
    expect(parseRoute('#/playlist/%E0%A4%A')).toEqual({ name: 'home', criteria: { sort: 'recommended' } });
  });
});

describe('formatRoute', () => {
  it('round-trips playlist keys with colons, spaces, slashes and accents', () => {
    for (const key of ['favorites', 'artist:4Z8W4fKeB5YxbusRsdQVPb', 'genre:drum & bass', 'key:9:0', 'genre:r/b ?#', 'genre:música']) {
      const href = playlistHref(key);
      expect(href.startsWith('#/playlist/')).toBe(true);
      expect(parseRoute(href)).toEqual({ name: 'playlist', key });
    }
  });

  it('keeps the default recommendations at a bare #/', () => {
    expect(homeHref({ sort: 'recommended' })).toBe('#/');
    expect(homeHref({ sort: 'recommended', kind: '', decade: null, genre: '', key: '', artist: '', minTracks: 0 })).toBe('#/');
  });
});

describe('browse state in the address', () => {
  it('survives leaving for a playlist page and coming back (or reloading)', () => {
    const criteria: BrowseCriteria = {
      sort: 'decade',
      kind: 'genre',
      decade: 1990,
      genre: 'indie rock',
      key: '9:0',
      artist: '4Z8W4fKeB5YxbusRsdQVPb',
      minTracks: 50,
    };
    const home = homeHref(criteria);
    expect(home).toBe('#/?sort=decade&type=genre&decade=1990&genre=indie+rock&key=9%3A0&artist=4Z8W4fKeB5YxbusRsdQVPb&size=50');

    // Opening a playlist and going back lands on the same address, so the same view.
    const page = parseRoute(playlistHref('genre:indie rock'));
    expect(page.name).toBe('playlist');
    expect(parseRoute(home)).toEqual({ name: 'home', criteria });
    expect(formatRoute(parseRoute(home))).toBe(home);
  });

  it('keeps each criterion on its own', () => {
    const cases: BrowseCriteria[] = [
      { sort: 'tracks' },
      { sort: 'recommended', kind: 'best-of-albums' },
      { sort: 'recommended', decade: 1960 },
      { sort: 'key', key: '11:1' },
      { sort: 'recommended', genre: 'drum & bass' },
      { sort: 'artist', minTracks: 25 },
    ];
    for (const criteria of cases) expect(parseRoute(homeHref(criteria))).toEqual({ name: 'home', criteria });
  });
});

describe('Musicians Corner routes', () => {
  it('opens the corner, with or without the easy-keys filter', () => {
    expect(parseRoute('#/musicians')).toEqual({ name: 'musicians', easy: false });
    expect(parseRoute('#/musicians?easy=1')).toEqual({ name: 'musicians', easy: true });
    expect(parseRoute('#/musicians?easy=yes')).toEqual({ name: 'musicians', easy: false });
    expect(musiciansHref(false)).toBe('#/musicians');
    expect(musiciansHref(true)).toBe('#/musicians?easy=1');
    // Not a prefix match: other paths stay the recommendations.
    expect(parseRoute('#/musiciansx').name).toBe('home');
  });

  it('round-trips corner playlist pages, keeping the filter for the way back', () => {
    for (const key of ['key:9:0', 'key:10:1', 'genre:r/b ?#']) {
      for (const easy of [false, true]) {
        const href = musiciansPlaylistHref(key, easy);
        expect(parseRoute(href)).toEqual({ name: 'musicians-playlist', key, easy });
        expect(formatRoute(parseRoute(href))).toBe(href);
      }
    }
    expect(parseRoute('#/musicians/playlist/').name).toBe('home');
  });

  it('sends Back from a playlist page to the page it belongs to', () => {
    const criteria = { sort: 'decade' as const };
    expect(parentRoute(parseRoute('#/playlist/key:9:0'), criteria)).toEqual({ name: 'home', criteria });
    expect(parentRoute(parseRoute('#/musicians/playlist/key:9:0?easy=1'), criteria)).toEqual({ name: 'musicians', easy: true });
    expect(parentRoute(parseRoute('#/musicians'), criteria)).toBeNull();
    expect(isMusiciansRoute(parseRoute('#/musicians/playlist/key:9:0'))).toBe(true);
    expect(isMusiciansRoute(parseRoute('#/playlist/key:9:0'))).toBe(false);
  });
});
