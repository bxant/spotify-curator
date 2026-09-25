import { describe, expect, it } from 'vitest';
import { trackSignature } from '../src/curate';
import { RemovedStore } from '../src/removed-store';
import { SessionCache } from '../src/session-cache';
import type { CuratedPlaylist } from '../src/types';
import { MemoryStorage, track } from './fixtures/builders';

const playlist = (key: string, ids: string[]): CuratedPlaylist => ({
  key,
  kind: 'favorites',
  name: key,
  reason: '',
  tracks: ids.map((id) => track({ id })),
});
const ids = (p: CuratedPlaylist) => p.tracks.map((t) => t.id);

describe('RemovedStore', () => {
  it('drops removed tracks from that playlist only', () => {
    const store = new RemovedStore(new SessionCache(new MemoryStorage()));
    store.remove('favorites', 'b');
    expect(ids(store.apply(playlist('favorites', ['a', 'b', 'c'])))).toEqual(['a', 'c']);
    expect(ids(store.apply(playlist('rediscover', ['a', 'b'])))).toEqual(['a', 'b']);
  });

  it('undoes a removal, one track or all of them', () => {
    const store = new RemovedStore(new SessionCache(new MemoryStorage()));
    const p = playlist('favorites', ['a', 'b', 'c']);
    store.remove('favorites', 'a');
    store.remove('favorites', 'c');
    store.remove('favorites', 'c');
    expect(store.removed('favorites')).toEqual(['a', 'c']);
    store.restore('favorites', 'c');
    expect(ids(store.apply(p))).toEqual(['b', 'c']);
    store.restoreAll('favorites');
    expect(store.removed('favorites')).toEqual([]);
    expect(store.apply(p)).toBe(p);
  });

  it('keeps removals for the session, across page loads', () => {
    const storage = new MemoryStorage();
    new RemovedStore(new SessionCache(storage)).remove('genre:jazz', 'x');
    expect(new RemovedStore(new SessionCache(storage)).removed('genre:jazz')).toEqual(['x']);
  });

  it('changes the track signature, so a playlist created before the edit can be created again', () => {
    const store = new RemovedStore(new SessionCache(new MemoryStorage()));
    const p = playlist('favorites', ['a', 'b']);
    const before = trackSignature(store.apply(p));
    store.remove('favorites', 'a');
    expect(trackSignature(store.apply(p))).not.toBe(before);
    store.restore('favorites', 'a');
    expect(trackSignature(store.apply(p))).toBe(before);
  });
});
