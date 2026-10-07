import { describe, expect, it } from 'vitest';
import type { BrowseCriteria } from '../src/browse';
import { formatRoute, homeHref, parentRoute, parseRoute, playlistHref } from '../src/route';

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

describe('playlist pages', () => {
  it('round-trips part keys', () => {
    for (const key of ['genre:rock|part:2', 'artist:abc|part:4']) {
      expect(parseRoute(playlistHref(key))).toEqual({ name: 'playlist', key });
      expect(formatRoute(parseRoute(playlistHref(key)))).toBe(playlistHref(key));
    }
  });

  it('sends Back from a playlist page to the recommendations, keeping their criteria', () => {
    const criteria = { sort: 'decade' as const };
    expect(parentRoute(parseRoute('#/playlist/key:9:0'), criteria)).toEqual({ name: 'home', criteria });
    expect(parentRoute(parseRoute('#/'), criteria)).toBeNull();
  });

  it('opens the recommendations for links to the removed Musicians Corner', () => {
    for (const hash of ['#/musicians', '#/musicians?easy=1', '#/musicians/playlist/key:9:0']) {
      expect(parseRoute(hash)).toEqual({ name: 'home', criteria: { sort: 'recommended' } });
    }
  });
});
