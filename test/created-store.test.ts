import { describe, expect, it } from 'vitest';
import { CreatedStore } from '../src/created-store';
import { SessionCache } from '../src/session-cache';
import type { CreatedPlaylist } from '../src/spotify';
import { MemoryStorage } from './fixtures/builders';

const playlist = (id: string): CreatedPlaylist => ({ id, uri: `spotify:playlist:${id}`, url: `https://open.spotify.com/playlist/${id}` });

function deferred() {
  let resolve!: (p: CreatedPlaylist) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<CreatedPlaylist>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const cache = new SessionCache(new MemoryStorage());
  const changes: string[] = [];
  return { cache, changes, store: new CreatedStore(cache, (key) => changes.push(key)) };
}

describe('CreatedStore', () => {
  it('reports progress while creating and the playlist once created, while the tracks match', async () => {
    const { store, changes } = setup();
    const run = deferred();
    let report!: (message: string) => void;
    const done = store.create('favorites', 'sig', (onProgress) => {
      report = onProgress;
      return run.promise;
    });
    expect(store.status('favorites', 'sig')).toEqual({ kind: 'creating', progress: 'Creating playlist…' });
    report('Adding tracks… 100 / 200');
    expect(store.status('favorites', 'sig')).toEqual({ kind: 'creating', progress: 'Adding tracks… 100 / 200' });

    run.resolve(playlist('p1'));
    await done;
    expect(store.status('favorites', 'sig')).toEqual({ kind: 'created', playlist: playlist('p1') });
    expect(store.status('favorites', 'other-tracks')).toEqual({ kind: 'idle', error: undefined });
    expect(changes.every((key) => key === 'favorites')).toBe(true);
    expect(changes.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps a record of a key created, being created or failed this session, whatever its tracks now', async () => {
    const { store } = setup();
    expect(store.hasRecord('favorites')).toBe(false);
    const run = deferred();
    const done = store.create('favorites', 'sig', () => run.promise);
    expect(store.hasRecord('favorites')).toBe(true);
    run.resolve(playlist('p1'));
    await done;
    expect(store.status('favorites', 'new-tracks').kind).toBe('idle');
    expect(store.hasRecord('favorites')).toBe(true);
    expect(store.hasRecord('rediscover')).toBe(false);

    await store.create('rediscover', 'sig', async () => {
      throw new Error('HTTP 500');
    });
    expect(store.hasRecord('rediscover')).toBe(true);

    store.reset();
    expect(store.hasRecord('favorites')).toBe(false);
    expect(store.hasRecord('rediscover')).toBe(false);
  });

  it('does not start a second creation for a playlist that is still being created', async () => {
    const { store } = setup();
    const run = deferred();
    let calls = 0;
    const first = store.create('favorites', 'sig', () => (calls++, run.promise));
    await store.create('favorites', 'sig', () => (calls++, run.promise));
    expect(calls).toBe(1);
    run.resolve(playlist('p1'));
    await first;
  });

  it('keeps the error for the card and allows another try', async () => {
    const { store } = setup();
    await store.create('favorites', 'sig', async () => {
      throw new Error('HTTP 500');
    });
    expect(store.status('favorites', 'sig')).toEqual({ kind: 'idle', error: 'HTTP 500' });
    await store.create('favorites', 'sig', async () => playlist('p2'));
    expect(store.status('favorites', 'sig')).toEqual({ kind: 'created', playlist: playlist('p2') });
  });

  it('reports progress and errors only for the tracks being created', async () => {
    const { store } = setup();
    const run = deferred();
    const pending = store.create('favorites', 'old', () => run.promise);
    expect(store.status('favorites', 'old').kind).toBe('creating');
    expect(store.status('favorites', 'new')).toEqual({ kind: 'idle', error: undefined });

    run.reject(new Error('HTTP 500'));
    await pending;
    expect(store.status('favorites', 'old')).toEqual({ kind: 'idle', error: 'HTTP 500' });
    expect(store.status('favorites', 'new')).toEqual({ kind: 'idle', error: undefined });
  });

  it('does not record a creation that finishes after a reset', async () => {
    const { store, cache } = setup();
    await store.create('decade:1990', 'sig', async () => playlist('old'));
    const run = deferred();
    const pending = store.create('favorites', 'sig', () => run.promise);
    store.reset();
    expect(store.status('decade:1990', 'sig').kind).toBe('idle');
    expect(store.status('favorites', 'sig').kind).toBe('creating');

    run.resolve(playlist('p1'));
    await pending;
    expect(store.status('favorites', 'sig').kind).toBe('idle');
    expect(cache.get('created')).toEqual({});
  });

  it('adds only its own entry to the latest cached map', async () => {
    const { store, cache } = setup();
    const slow = deferred();
    const pending = store.create('a', 'sig-a', () => slow.promise);
    await store.create('b', 'sig-b', async () => playlist('pb'));
    slow.resolve(playlist('pa'));
    await pending;
    expect(Object.keys(cache.get<Record<string, unknown>>('created')!).sort()).toEqual(['a', 'b']);
    expect(store.status('b', 'sig-b')).toEqual({ kind: 'created', playlist: playlist('pb') });
  });
});

describe('CreatedStore across different sets', () => {
  it('keeps every created version of a suggestion linked and listed', async () => {
    const { store } = setup();
    await store.create('genre:rock', 'first-tracks', async () => playlist('p1'), 'Genre: Rock');
    await store.create('genre:rock', 'other-tracks', async () => playlist('p2'), 'Genre: Rock');
    expect(store.status('genre:rock', 'first-tracks')).toEqual({ kind: 'created', playlist: playlist('p1') });
    expect(store.status('genre:rock', 'other-tracks')).toEqual({ kind: 'created', playlist: playlist('p2') });
    expect(store.all()).toEqual([
      { key: 'genre:rock', name: 'Genre: Rock', playlist: playlist('p1') },
      { key: 'genre:rock', name: 'Genre: Rock', playlist: playlist('p2') },
    ]);
  });

  it('reads entries saved in the single-entry shape', () => {
    const { store, cache } = setup();
    cache.set('created', { favorites: { ...playlist('old'), signature: 'sig' } });
    expect(store.status('favorites', 'sig')).toEqual({ kind: 'created', playlist: playlist('old') });
    expect(store.all()).toEqual([{ key: 'favorites', name: 'favorites', playlist: playlist('old') }]);
  });
});
