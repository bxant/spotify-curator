// Key and genre lookups across tabs. With the Musicians Corner open next to the curator,
// two tabs would otherwise look up the same songs at once and double the request rate the
// outside services allow (MusicBrainz asks for one request a second). A Web Lock lets one
// tab at a time run the lookups; a tab waiting its turn picks up the results the running
// tab saves to the shared (localStorage) lookup cache, through `storage` events, and finds
// little left to do once the lock is its own.

export const LOOKUP_LOCK = 'curator.lookups';

/** The part of the Web Locks API (`navigator.locks`) used here. */
export interface Locks {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>;
}

/**
 * Runs `task` while this tab holds the lookup lock; without Web Locks it just runs it.
 * Resolves false, without running it, when `signal` aborts while waiting for the lock.
 */
export async function withLookupLock(locks: Locks | undefined, signal: AbortSignal, task: () => Promise<void>): Promise<boolean> {
  if (!locks) {
    await task();
    return true;
  }
  let ran = false;
  try {
    await locks.request(LOOKUP_LOCK, { signal }, async () => {
      ran = true;
      await task();
    });
  } catch (err) {
    if (!signal.aborted) throw err;
  }
  return ran;
}
