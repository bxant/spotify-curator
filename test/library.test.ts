import { describe, expect, it } from 'vitest';
import { artistsToLookUp, loadGenres } from '../src/library';
import { SessionCache } from '../src/session-cache';
import { RateLimitError, SpotifyClient } from '../src/spotify';
import { configuredClientId } from '../src/config';
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

describe('configuredClientId', () => {
  it('treats a missing or placeholder Client ID as not configured', () => {
    expect(configuredClientId(undefined)).toBeNull();
    expect(configuredClientId('  ')).toBeNull();
    expect(configuredClientId('your-client-id-here')).toBeNull();
    expect(configuredClientId(' abc123 ')).toBe('abc123');
  });
});
