// How the Musicians Corner tab arrives signed in, with the library already loaded.
//
// The sign-in token and the library cache live in sessionStorage, which belongs to one tab:
// a new tab starts empty, i.e. signed out. So the header link opens the new tab with a
// one-off nonce (`/?handoff=<nonce>#/musicians`) and the tabs talk over a same-origin
// BroadcastChannel:
//   new tab   → { request, nonce }
//   curator   → { session, nonce, entries }   only for a nonce it put in its own link
// The new tab copies the entries (the token and `curator.cache.v1.*`, never the PKCE
// verifier) into its own sessionStorage and carries on as if it had loaded them itself.
// Nothing is written to localStorage or disk on the way, so tokens still vanish when the
// tabs close.
//
// The same channel keeps the tabs in step afterwards:
//   { signed-out }  Sign out in any tab signs out every curator tab (each clears its own
//                   sessionStorage), so a second tab never outlives a sign-out.
//   { token }       After a token refresh, tabs holding the refresh token it replaced adopt
//                   the new one, since Spotify may rotate refresh tokens.
//
// Everything takes its channel and storage as arguments, so tests run without a browser.

import { TOKEN_KEY, generateCodeVerifier, type StoredToken } from '../auth';
import { CACHE_PREFIX } from '../session-cache';

export const CHANNEL_NAME = 'curator.tabs';
/** Query parameter carrying the nonce on the Musicians Corner link. */
export const HANDOFF_PARAM = 'handoff';
/** How long a new tab waits for its opener before showing the sign-in page instead. */
export const HANDOFF_TIMEOUT_MS = 4000;

export type TabMessage =
  | { type: 'request'; nonce: string }
  | { type: 'session'; nonce: string; entries: [string, string][] }
  | { type: 'signed-out' }
  | { type: 'token'; replaces: string; token: StoredToken };

/** The part of BroadcastChannel this module uses. */
export interface TabChannel {
  postMessage(message: TabMessage): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** Only the sign-in token and the session cache travel to another tab. */
export function isShared(key: string): boolean {
  return key === TOKEN_KEY || key.startsWith(CACHE_PREFIX);
}

/** The entries a new tab needs to arrive signed in with the same data. */
export function sessionEntries(storage: Storage): [string, string][] {
  const entries: [string, string][] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    const value = key === null ? null : storage.getItem(key);
    if (key !== null && value !== null && isShared(key)) entries.push([key, value]);
  }
  return entries;
}

/** Copies handed-over entries into this tab's storage; anything not shareable is ignored. */
export function restoreEntries(storage: Storage, entries: unknown): boolean {
  if (!Array.isArray(entries)) return false;
  let token = false;
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string' || !isShared(entry[0])) continue;
    try {
      storage.setItem(entry[0], entry[1]);
      if (entry[0] === TOKEN_KEY) token = true;
    } catch {
      // Storage full: the tab loads that data again itself (or signs in, without the token).
    }
  }
  return token;
}

/** The address of the Musicians Corner tab for a nonce. */
export function handoffHref(nonce: string, hash: string): string {
  return `/?${new URLSearchParams({ [HANDOFF_PARAM]: nonce })}${hash}`;
}

/** The nonce a tab was opened with, if any. */
export function handoffNonce(search: string): string | null {
  return new URLSearchParams(search).get(HANDOFF_PARAM) || null;
}

function isMessage(data: unknown): data is TabMessage {
  return !!data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string';
}

/**
 * The tab's end of the channel: answers handoff requests for links it made, and applies
 * sign-outs and token refreshes from other tabs.
 */
export class TabLink {
  private readonly offers = new Set<string>();
  private readonly listener = (event: { data: unknown }) => this.receive(event.data);

  constructor(
    private readonly channel: TabChannel,
    private readonly storage: Storage,
    private readonly onSignedOut: () => void,
  ) {
    channel.addEventListener('message', this.listener);
  }

  /** A nonce for one Musicians Corner link; a request carrying it gets this tab's session. */
  offer(): string {
    const nonce = generateCodeVerifier(32);
    this.offers.add(nonce);
    return nonce;
  }

  /** Tells every other tab to sign out too. */
  signedOut(): void {
    this.offers.clear();
    this.channel.postMessage({ type: 'signed-out' });
  }

  /** Shares a refreshed token with tabs that still hold the one it replaced. */
  tokenStored(token: StoredToken, previous: StoredToken | null): void {
    if (previous?.refreshToken) this.channel.postMessage({ type: 'token', replaces: previous.refreshToken, token });
  }

  private receive(data: unknown): void {
    if (!isMessage(data)) return;
    if (data.type === 'request') {
      if (!this.offers.has(data.nonce) || this.storage.getItem(TOKEN_KEY) === null) return;
      this.channel.postMessage({ type: 'session', nonce: data.nonce, entries: sessionEntries(this.storage) });
    } else if (data.type === 'signed-out') {
      this.offers.clear();
      this.onSignedOut();
    } else if (data.type === 'token') {
      if (readToken(this.storage)?.refreshToken === data.replaces) this.storage.setItem(TOKEN_KEY, JSON.stringify(data.token));
    }
  }
}

function readToken(storage: Storage): StoredToken | null {
  try {
    const raw = storage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredToken) : null;
  } catch {
    return null;
  }
}

/**
 * Asks the tab that opened this one for its session and copies it in. Resolves true once
 * this tab holds a token, false when no tab answered within `timeoutMs`.
 */
export function receiveSession(
  channel: TabChannel,
  storage: Storage,
  nonce: string,
  timeoutMs = HANDOFF_TIMEOUT_MS,
  setTimer: (fn: () => void, ms: number) => unknown = setTimeout,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      channel.removeEventListener('message', listener);
      resolve(ok);
    };
    const listener = (event: { data: unknown }) => {
      const data = event.data;
      if (isMessage(data) && data.type === 'session' && data.nonce === nonce) finish(restoreEntries(storage, data.entries));
    };
    channel.addEventListener('message', listener);
    setTimer(() => finish(false), timeoutMs);
    channel.postMessage({ type: 'request', nonce });
  });
}
