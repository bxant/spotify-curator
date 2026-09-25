import { describe, expect, it, vi } from 'vitest';
import { RateLimitError, SpotifyApiError, SpotifyClient, toLikedTrack } from '../src/spotify';
import { fakeFetch, json } from './fixtures/fake-fetch';
import { rawTrack, savedPage } from './fixtures/spotify-objects';

function client(responder: Parameters<typeof fakeFetch>[0], extra: Partial<ConstructorParameters<typeof SpotifyClient>[0]> = {}) {
  const fake = fakeFetch(responder);
  const sleep = vi.fn(async () => {});
  const getToken = vi.fn(async (force?: boolean) => (force ? 'fresh-token' : 'token'));
  const c = new SpotifyClient({ getToken, fetch: fake.fetch, sleep, ...extra });
  return { c, calls: fake.calls, sleep, getToken };
}

describe('SpotifyClient.request', () => {
  it('sends the bearer token and waits out 429 Retry-After before retrying', async () => {
    let n = 0;
    const { c, calls, sleep } = client(() => (n++ === 0 ? json({}, 429, { 'Retry-After': '2' }) : json({ ok: true })));
    await expect(c.request('GET', '/me')).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://api.spotify.com/v1/me');
    expect(calls[0].headers.authorization).toBe('Bearer token');
  });

  it('gives up with RateLimitError when asked to wait too long', async () => {
    const { c, sleep } = client(() => json({}, 429, { 'Retry-After': '3600' }), { maxRetryAfterMs: 60_000 });
    const err = await c.request('GET', '/me').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(3_600_000);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('refreshes the token once after a 401', async () => {
    let n = 0;
    const { c, getToken, calls } = client(() => (n++ === 0 ? json({}, 401) : json({ id: 'me' })));
    await expect(c.request('GET', '/me')).resolves.toEqual({ id: 'me' });
    expect(getToken).toHaveBeenCalledWith(true);
    expect(calls).toHaveLength(2);
  });

  it('retries server errors briefly, then reports Spotify’s error message', async () => {
    const { c, calls } = client(() => json({ error: { status: 503, message: 'Service unavailable' } }, 503));
    const err = (await c.request('GET', '/me').catch((e) => e)) as SpotifyApiError;
    expect(err).toBeInstanceOf(SpotifyApiError);
    expect(err.message).toContain('Service unavailable');
    expect(calls).toHaveLength(3);
  });
});

describe('SpotifyClient.getLikedTracks', () => {
  it('pages through every liked song 50 at a time and reports progress', async () => {
    const total = 4012;
    const { c, calls } = client((call) => {
      const url = new URL(call.url);
      const offset = Number(url.searchParams.get('offset'));
      expect(url.pathname).toBe('/v1/me/tracks');
      expect(url.searchParams.get('limit')).toBe('50');
      return json(savedPage(offset, Math.min(50, total - offset), total));
    });
    const progress: number[] = [];
    const tracks = await c.getLikedTracks((loaded) => progress.push(loaded));
    expect(tracks).toHaveLength(total);
    expect(calls).toHaveLength(Math.ceil(total / 50));
    expect(tracks[0].id).toBe('t0');
    expect(tracks[total - 1].id).toBe(`t${total - 1}`);
    expect(progress.at(-1)).toBe(total);
  });

  it('maps saved tracks and skips local or unavailable ones', () => {
    const liked = toLikedTrack({ added_at: '2024-02-03T04:05:06Z', track: rawTrack('abc') as never });
    expect(liked).toMatchObject({
      id: 'abc',
      uri: 'spotify:track:abc',
      addedAt: '2024-02-03T04:05:06Z',
      trackNumber: 3,
      artists: [{ id: 'artist-abc', name: 'Artist abc' }],
      album: { id: 'album-abc', releaseDate: '2011-06-01', totalTracks: 11, imageUrl: 'https://i.scdn.co/image/abc-64' },
    });
    expect(toLikedTrack({ added_at: '', track: rawTrack('loc', { is_local: true, id: null }) as never })).toBeNull();
    expect(toLikedTrack({ added_at: '', track: null })).toBeNull();
  });
});

describe('SpotifyClient.getListeningHistory', () => {
  it('reads top tracks and artists for every time range plus recent plays', async () => {
    const { c, calls } = client((call) => {
      const url = new URL(call.url);
      if (url.pathname === '/v1/me/top/tracks') {
        return json({ items: [rawTrack(`top-${url.searchParams.get('time_range')}`)], next: null, total: 1 });
      }
      if (url.pathname === '/v1/me/top/artists') {
        return json({ items: [{ id: 'fav', name: 'Fav', genres: ['dream pop'] }], next: null, total: 1 });
      }
      if (url.pathname === '/v1/me/player/recently-played') {
        return json({ items: [{ track: rawTrack('recent') }], next: null, total: 1 });
      }
      throw new Error(`unexpected ${call.url}`);
    });
    const { history, topArtistGenres } = await c.getListeningHistory();
    expect(history.topTracks.short_term.map((t) => t.id)).toEqual(['top-short_term']);
    expect(history.topTracks.long_term.map((t) => t.id)).toEqual(['top-long_term']);
    expect(history.topArtists.medium_term).toEqual(['fav']);
    expect(history.recentlyPlayed.map((t) => t.id)).toEqual(['recent']);
    expect(topArtistGenres).toEqual({ fav: ['dream pop'] });
    expect(calls.map((call) => new URL(call.url).pathname)).not.toContain('/v1/artists');
  });
});

describe('SpotifyClient.getArtistGenres', () => {
  it('looks artists up one at a time (no batch endpoint in development mode)', async () => {
    const { c, calls } = client((call) => {
      const id = call.url.split('/').pop();
      return json({ id, name: id, genres: id === 'a1' ? ['folk'] : [] });
    });
    const genres = await c.getArtistGenres(['a1', 'a2', 'a3']);
    expect(genres).toEqual({ a1: ['folk'], a2: [], a3: [] });
    expect(calls.map((call) => call.url).sort()).toEqual([
      'https://api.spotify.com/v1/artists/a1',
      'https://api.spotify.com/v1/artists/a2',
      'https://api.spotify.com/v1/artists/a3',
    ]);
  });
});

describe('SpotifyClient.createPlaylist', () => {
  it('creates a private playlist via POST /me/playlists and adds tracks in batches of 100', async () => {
    const { c, calls } = client((call) =>
      call.url.endsWith('/me/playlists')
        ? json({ id: 'pl1', uri: 'spotify:playlist:pl1', external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' } }, 201)
        : json({ snapshot_id: 'x' }, 201),
    );
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:t${i}`);
    const progress: number[] = [];
    const created = await c.createPlaylist('Real Favorites', 'Because.', uris, (added) => progress.push(added));

    expect(created).toEqual({ id: 'pl1', uri: 'spotify:playlist:pl1', url: 'https://open.spotify.com/playlist/pl1' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.spotify.com/v1/me/playlists' });
    expect(JSON.parse(calls[0].body!)).toEqual({ name: 'Real Favorites', description: 'Because.', public: false });
    const adds = calls.slice(1);
    expect(adds.map((a) => a.url)).toEqual(Array(3).fill('https://api.spotify.com/v1/playlists/pl1/items'));
    expect(adds.map((a) => JSON.parse(a.body!).uris.length)).toEqual([100, 100, 50]);
    expect(adds.flatMap((a) => JSON.parse(a.body!).uris)).toEqual(uris);
    expect(progress).toEqual([100, 200, 250]);
  });
});
