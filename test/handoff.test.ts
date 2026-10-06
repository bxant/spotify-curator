import { describe, expect, it, vi } from 'vitest';
import { TOKEN_KEY, type StoredToken } from '../src/auth';
import {
  HANDOFF_PARAM,
  TabLink,
  handoffHref,
  handoffNonce,
  receiveSession,
  restoreEntries,
  sessionEntries,
  type TabChannel,
  type TabMessage,
} from '../src/musicians-corner/handoff';
import { LOOKUP_LOCK, withLookupLock, type Locks } from '../src/musicians-corner/shared-lookups';
import { SessionCache } from '../src/session-cache';
import { MemoryStorage } from './fixtures/builders';

/** In-memory BroadcastChannel: a message reaches every other channel on the bus, synchronously. */
class Bus {
  readonly channels: FakeChannel[] = [];
  readonly sent: TabMessage[] = [];
  channel(): FakeChannel {
    const c = new FakeChannel(this);
    this.channels.push(c);
    return c;
  }
}

class FakeChannel implements TabChannel {
  private listeners: ((event: { data: unknown }) => void)[] = [];
  constructor(private readonly bus: Bus) {}
  postMessage(message: TabMessage): void {
    this.bus.sent.push(message);
    // Structured clone, like the real channel.
    const data = structuredClone(message);
    for (const other of this.bus.channels) if (other !== this) other.deliver(data);
  }
  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  deliver(data: unknown): void {
    for (const l of [...this.listeners]) l({ data });
  }
}

const token = (refreshToken: string, accessToken = `access-${refreshToken}`): StoredToken => ({ accessToken, refreshToken, expiresAt: 1_000, scope: 'a b' });

/** A signed-in curator tab's sessionStorage: token, PKCE leftovers, library cache and an unrelated key. */
function signedInStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, JSON.stringify(token('r1')));
  storage.setItem('curator.pkce.verifier', 'secret-verifier');
  storage.setItem('curator.return-hash', '#/');
  storage.setItem('other.app', 'x');
  const cache = new SessionCache(storage);
  cache.set('library', { liked: [{ id: 't1' }] });
  cache.set('set', { variant: 2, kept: [] });
  return storage;
}

/** A timer the test fires by hand. */
function manualTimer() {
  let fire: (() => void) | undefined;
  return { set: (fn: () => void) => void (fire = fn), fire: () => fire?.() };
}

describe('session entries', () => {
  it('hand over only the token and the session cache, never the PKCE verifier or other keys', () => {
    const keys = sessionEntries(signedInStorage()).map(([k]) => k).sort();
    expect(keys).toEqual(['curator.cache.v1.library', 'curator.cache.v1.set', TOKEN_KEY]);
  });

  it('restore only shareable, well-formed entries', () => {
    const storage = new MemoryStorage();
    const ok = restoreEntries(storage, [
      [TOKEN_KEY, '{"accessToken":"a"}'],
      ['curator.cache.v1.library', '{}'],
      ['curator.pkce.verifier', 'planted'],
      ['evil', 'x'],
      ['curator.cache.v1.set', 42],
      'junk',
    ]);
    expect(ok).toBe(true);
    expect(storage.getItem('curator.pkce.verifier')).toBeNull();
    expect(storage.getItem('evil')).toBeNull();
    expect(storage.getItem('curator.cache.v1.set')).toBeNull();
    expect(storage.length).toBe(2);
    expect(restoreEntries(new MemoryStorage(), 'not a list')).toBe(false);
    expect(restoreEntries(new MemoryStorage(), [['curator.cache.v1.library', '{}']])).toBe(false);
  });
});

describe('handoff address', () => {
  it('carries the nonce in the query and the route in the hash', () => {
    const href = handoffHref('n0nce', '#/musicians');
    expect(href).toBe(`/?${HANDOFF_PARAM}=n0nce#/musicians`);
    expect(handoffNonce(new URL(href, 'http://127.0.0.1:8888').search)).toBe('n0nce');
    expect(handoffNonce('')).toBeNull();
    expect(handoffNonce(`?${HANDOFF_PARAM}=`)).toBeNull();
  });
});

describe('opening the Musicians Corner tab', () => {
  it('arrives signed in with the opener’s library, without the PKCE verifier', async () => {
    const bus = new Bus();
    const openerStorage = signedInStorage();
    new TabLink(bus.channel(), openerStorage, () => {});
    const opener = new TabLink(bus.channel(), openerStorage, () => {});
    const nonce = opener.offer();

    const newTab = new MemoryStorage();
    const timer = manualTimer();
    const arrived = await receiveSession(bus.channel(), newTab, nonce, 1000, timer.set);

    expect(arrived).toBe(true);
    expect(JSON.parse(newTab.getItem(TOKEN_KEY) as string)).toEqual(token('r1'));
    expect(new SessionCache(newTab).get('library')).toEqual({ liked: [{ id: 't1' }] });
    expect(new SessionCache(newTab).get('set')).toEqual({ variant: 2, kept: [] });
    expect(newTab.getItem('curator.pkce.verifier')).toBeNull();
    // Only the tab that made the link answered, once.
    expect(bus.sent.filter((m) => m.type === 'session')).toHaveLength(1);
  });

  it('gets nothing for a nonce no tab offered, and gives up after the timeout', async () => {
    const bus = new Bus();
    const opener = new TabLink(bus.channel(), signedInStorage(), () => {});
    opener.offer();
    const newTab = new MemoryStorage();
    const timer = manualTimer();
    const pending = receiveSession(bus.channel(), newTab, 'guessed', 1000, timer.set);
    timer.fire();
    expect(await pending).toBe(false);
    expect(newTab.length).toBe(0);
    expect(bus.sent.some((m) => m.type === 'session')).toBe(false);
  });

  it('gets nothing from a tab that has signed out since making the link', async () => {
    const bus = new Bus();
    const storage = signedInStorage();
    const opener = new TabLink(bus.channel(), storage, () => {});
    const nonce = opener.offer();
    storage.removeItem(TOKEN_KEY);
    const timer = manualTimer();
    const pending = receiveSession(bus.channel(), new MemoryStorage(), nonce, 1000, timer.set);
    timer.fire();
    expect(await pending).toBe(false);
  });

  it('forgets its offers when it signs out', async () => {
    const bus = new Bus();
    const opener = new TabLink(bus.channel(), signedInStorage(), () => {});
    const nonce = opener.offer();
    opener.signedOut();
    const timer = manualTimer();
    const pending = receiveSession(bus.channel(), new MemoryStorage(), nonce, 1000, timer.set);
    timer.fire();
    expect(await pending).toBe(false);
  });
});

describe('keeping tabs in step', () => {
  it('signs every other tab out when one signs out', () => {
    const bus = new Bus();
    const signedOut = vi.fn();
    const curator = new TabLink(bus.channel(), signedInStorage(), () => {});
    new TabLink(bus.channel(), signedInStorage(), signedOut);
    curator.signedOut();
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it('passes a refreshed token to tabs that hold the refresh token it replaced', () => {
    const bus = new Bus();
    const refreshing = new TabLink(bus.channel(), signedInStorage(), () => {});
    const sameSession = signedInStorage();
    new TabLink(bus.channel(), sameSession, () => {});
    const otherSession = new MemoryStorage();
    otherSession.setItem(TOKEN_KEY, JSON.stringify(token('someone-else')));
    new TabLink(bus.channel(), otherSession, () => {});

    refreshing.tokenStored(token('r2'), token('r1'));

    expect(JSON.parse(sameSession.getItem(TOKEN_KEY) as string)).toEqual(token('r2'));
    expect(JSON.parse(otherSession.getItem(TOKEN_KEY) as string)).toEqual(token('someone-else'));
  });

  it('does not announce a first sign-in, which replaced no token', () => {
    const bus = new Bus();
    const tab = new TabLink(bus.channel(), new MemoryStorage(), () => {});
    tab.tokenStored(token('r1'), null);
    expect(bus.sent).toEqual([]);
  });

  it('ignores messages it does not understand', () => {
    const bus = new Bus();
    const storage = signedInStorage();
    const before = storage.getItem(TOKEN_KEY);
    new TabLink(bus.channel(), storage, () => {
      throw new Error('should not sign out');
    });
    const stranger = bus.channel();
    for (const data of [null, 'signed-out', { type: 'token' }, { type: 'session', nonce: 'x', entries: [] }]) {
      for (const c of bus.channels) if (c !== stranger) c.deliver(data);
    }
    expect(storage.getItem(TOKEN_KEY)).toBe(before);
  });
});

describe('one tab at a time runs the lookups', () => {
  /** A Web Locks stand-in: a FIFO queue per lock name, honoring abort while waiting. */
  function fakeLocks(): Locks & { names: string[] } {
    let tail = Promise.resolve();
    const names: string[] = [];
    return {
      names,
      request(name, options, callback) {
        names.push(name);
        const turn = tail;
        let release!: () => void;
        tail = new Promise<void>((r) => (release = r));
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          void turn.then(async () => {
            if (options.signal?.aborted) return release();
            try {
              resolve(await callback());
            } catch (err) {
              reject(err);
            } finally {
              release();
            }
          });
        });
      },
    };
  }

  it('runs a second tab’s lookups only after the first tab’s finish', async () => {
    const locks = fakeLocks();
    const order: string[] = [];
    let finishFirst!: () => void;
    const first = withLookupLock(locks, new AbortController().signal, async () => {
      order.push('first starts');
      await new Promise<void>((r) => (finishFirst = r));
      order.push('first ends');
    });
    const second = withLookupLock(locks, new AbortController().signal, async () => {
      order.push('second starts');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first starts']);
    finishFirst();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(order).toEqual(['first starts', 'first ends', 'second starts']);
    expect(locks.names).toEqual([LOOKUP_LOCK, LOOKUP_LOCK]);
  });

  it('gives up waiting, without running, when stopped', async () => {
    const locks = fakeLocks();
    let finishFirst!: () => void;
    const first = withLookupLock(locks, new AbortController().signal, () => new Promise<void>((r) => (finishFirst = r)));
    const stop = new AbortController();
    const task = vi.fn(async () => {});
    const second = withLookupLock(locks, stop.signal, task);
    stop.abort();
    expect(await second).toBe(false);
    finishFirst();
    await first;
    expect(task).not.toHaveBeenCalled();
  });

  it('just runs where the browser has no Web Locks', async () => {
    const task = vi.fn(async () => {});
    expect(await withLookupLock(undefined, new AbortController().signal, task)).toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
