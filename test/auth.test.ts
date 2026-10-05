import { describe, expect, it } from 'vitest';
import { AuthError, SCOPES, SpotifyAuth, codeChallenge, generateCodeVerifier } from '../src/auth';
import { MemoryStorage } from './fixtures/builders';
import { fakeFetch, json } from './fixtures/fake-fetch';

const REDIRECT = 'http://127.0.0.1:8888/callback';

function setup(responder: Parameters<typeof fakeFetch>[0] = () => json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })) {
  const storage = new MemoryStorage();
  const fake = fakeFetch(responder);
  let now = 1_000_000;
  const auth = new SpotifyAuth({ clientId: 'client-123', redirectUri: REDIRECT, storage, fetch: fake.fetch, now: () => now });
  return { auth, storage, calls: fake.calls, advance: (ms: number) => (now += ms) };
}

async function signIn(auth: SpotifyAuth) {
  const url = new URL(await auth.authorizeUrl());
  await auth.handleCallback(`?code=the-code&state=${url.searchParams.get('state')}`);
  return url;
}

describe('PKCE helpers', () => {
  it('generates RFC 7636 verifiers', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(generateCodeVerifier()).not.toBe(v);
  });

  it('derives the S256 challenge as unpadded base64url SHA-256 (RFC 7636 appendix B)', async () => {
    await expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('SpotifyAuth', () => {
  it('builds an authorize URL with PKCE, state and only the needed scopes', async () => {
    const { auth } = setup();
    const url = new URL(await auth.authorizeUrl());
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(SCOPES);
    expect(SCOPES).toEqual([
      'user-library-read',
      'user-top-read',
      'user-read-recently-played',
      'playlist-modify-private',
      'playlist-read-private',
    ]);
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('exchanges the code with the verifier and no client secret', async () => {
    const { auth, calls } = setup();
    await signIn(auth);
    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(calls[0].body);
    expect(calls[0].url).toBe('https://accounts.spotify.com/api/token');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(form.get('client_id')).toBe('client-123');
    expect(form.has('client_secret')).toBe(false);
    expect(auth.isSignedIn()).toBe(true);
    await expect(auth.getAccessToken()).resolves.toBe('at');
  });

  it('rejects a callback whose state does not match', async () => {
    const { auth } = setup();
    await auth.authorizeUrl();
    await expect(auth.handleCallback('?code=x&state=forged')).rejects.toBeInstanceOf(AuthError);
    expect(auth.isSignedIn()).toBe(false);
  });

  it('reports a denied consent', async () => {
    const { auth } = setup();
    await expect(auth.handleCallback('?error=access_denied')).rejects.toThrow('denied');
  });

  it('refreshes an expiring token and keeps the old refresh token when none is returned', async () => {
    let n = 0;
    const { auth, calls, advance } = setup(() =>
      n++ === 0 ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }) : json({ access_token: `at${n}`, expires_in: 3600 }),
    );
    await signIn(auth);
    advance(3600 * 1000);
    await expect(auth.getAccessToken()).resolves.toBe('at2');
    expect(new URLSearchParams(calls[1].body).get('refresh_token')).toBe('rt');
    advance(3600 * 1000);
    await expect(auth.getAccessToken()).resolves.toBe('at3');
    expect(new URLSearchParams(calls[2].body).get('refresh_token')).toBe('rt');
  });

  it('records the granted scopes and keeps them when a refresh leaves them out', async () => {
    let n = 0;
    const { auth, advance } = setup(() =>
      n++ === 0
        ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: SCOPES.join(' ') })
        : json({ access_token: `at${n}`, expires_in: 3600 }),
    );
    await signIn(auth);
    expect(auth.hasAllScopes()).toBe(true);
    advance(3600 * 1000);
    await auth.getAccessToken();
    expect(auth.hasAllScopes()).toBe(true);
  });

  it('asks for consent again when a session lacks a scope the app now needs', async () => {
    const { auth, storage } = setup(() =>
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: SCOPES.filter((s) => s !== 'playlist-read-private').join(' ') }),
    );
    await signIn(auth);
    expect(auth.hasAllScopes()).toBe(false);
    // Tokens stored before scopes were recorded count as missing them.
    storage.setItem('curator.token', JSON.stringify({ accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() * 2 }));
    expect(auth.isSignedIn()).toBe(true);
    expect(auth.hasAllScopes()).toBe(false);
  });

  it('signs out when a refresh is rejected', async () => {
    let n = 0;
    const { auth, advance } = setup(() =>
      n++ === 0 ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400),
    );
    await signIn(auth);
    advance(3600 * 1000);
    await expect(auth.getAccessToken()).rejects.toThrow('invalid_grant');
    expect(auth.isSignedIn()).toBe(false);
  });
});
