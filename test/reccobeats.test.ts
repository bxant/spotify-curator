import { describe, expect, it, vi } from 'vitest';
import { KEY_BATCH, KeyServiceError, ReccoBeatsClient, spotifyIdFromHref } from '../src/reccobeats';
import { fakeFetch, json } from './fixtures/fake-fetch';

const feature = (id: string, key: number, mode: number) => ({
  id: `recco-${id}`,
  href: `https://open.spotify.com/track/${id}`,
  key,
  mode,
  tempo: 120,
});

describe('ReccoBeatsClient.getTrackKeys', () => {
  it('requests at most 40 Spotify IDs per call and maps results back by Spotify ID', async () => {
    const ids = Array.from({ length: 90 }, (_, i) => `sp${i}`);
    const { fetch, calls } = fakeFetch((call) => {
      const requested = new URL(call.url).searchParams.get('ids')!.split(',');
      // ReccoBeats omits tracks it does not know and uses key -1 when undetected.
      return json({
        content: requested
          .filter((id) => id !== 'sp5')
          .map((id) => (id === 'sp6' ? feature(id, -1, 1) : feature(id, 9, 0))),
      });
    });
    const client = new ReccoBeatsClient({ fetch, sleep: async () => {} });
    const keys = await client.getTrackKeys(ids);

    expect(calls.map((c) => new URL(c.url).searchParams.get('ids')!.split(',').length)).toEqual([KEY_BATCH, KEY_BATCH, 10]);
    expect(calls[0].url.startsWith('https://api.reccobeats.com/v1/audio-features?ids=')).toBe(true);
    expect(keys.sp0).toEqual({ key: 9, mode: 0 });
    expect(keys.sp5).toBeNull();
    expect(keys.sp6).toBeNull();
    expect(Object.keys(keys)).toHaveLength(90);
  });

  it('waits out 429 Retry-After and retries', async () => {
    let n = 0;
    const { fetch } = fakeFetch(() => (n++ === 0 ? json({}, 429, { 'Retry-After': '3' }) : json({ content: [feature('a', 2, 1)] })));
    const sleep = vi.fn(async () => {});
    const keys = await new ReccoBeatsClient({ fetch, sleep }).getTrackKeys(['a']);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(keys).toEqual({ a: { key: 2, mode: 1 } });
  });

  it('fails with KeyServiceError when the service is down so callers can degrade', async () => {
    const { fetch } = fakeFetch(() => json({}, 500));
    const err = await new ReccoBeatsClient({ fetch, sleep: async () => {} }).getTrackKeys(['a']).catch((e) => e);
    expect(err).toBeInstanceOf(KeyServiceError);
  });

  it('fails with KeyServiceError when the network is unreachable', async () => {
    const fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof globalThis.fetch;
    const err = await new ReccoBeatsClient({ fetch, sleep: async () => {} }).getTrackKeys(['a']).catch((e) => e);
    expect(err).toBeInstanceOf(KeyServiceError);
    expect(err.message).toContain('unreachable');
  });
});

describe('spotifyIdFromHref', () => {
  it('extracts the Spotify track ID', () => {
    expect(spotifyIdFromHref('https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh')).toBe('4iV5W9uYEdYUVa79Axb7Rh');
    expect(spotifyIdFromHref(undefined)).toBeNull();
    expect(spotifyIdFromHref('https://example.com')).toBeNull();
  });
});
