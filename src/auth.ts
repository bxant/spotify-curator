// Spotify sign-in with Authorization Code + PKCE (no client secret).
// Tokens live in sessionStorage, so they vanish when the tab is closed.

export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/** Only what the app needs: read likes/top/recent, create private playlists. */
export const SCOPES = [
  'user-library-read',
  'user-top-read',
  'user-read-recently-played',
  'playlist-modify-private',
];

const VERIFIER_KEY = 'curator.pkce.verifier';
const STATE_KEY = 'curator.pkce.state';
const TOKEN_KEY = 'curator.token';
/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

export interface AuthConfig {
  clientId: string;
  redirectUri: string;
  storage: Storage;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Random PKCE code verifier (RFC 7636: 43-128 unreserved characters). */
export function generateCodeVerifier(length = 64): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => VERIFIER_CHARS[b % VERIFIER_CHARS.length]).join('');
}

/** S256 code challenge: base64url(sha256(verifier)) without padding. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class SpotifyAuth {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly config: AuthConfig) {
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
    this.now = config.now ?? Date.now;
  }

  /** Builds the Spotify authorize URL and remembers the PKCE verifier and state. */
  async authorizeUrl(): Promise<string> {
    const verifier = generateCodeVerifier();
    const state = generateCodeVerifier(32);
    this.config.storage.setItem(VERIFIER_KEY, verifier);
    this.config.storage.setItem(STATE_KEY, state);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      scope: SCOPES.join(' '),
      redirect_uri: this.config.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: await codeChallenge(verifier),
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  /** Completes sign-in from the callback URL's query string. */
  async handleCallback(search: string): Promise<void> {
    const params = new URLSearchParams(search);
    const error = params.get('error');
    if (error) throw new AuthError(error === 'access_denied' ? 'Spotify access was denied.' : `Spotify sign-in failed: ${error}`);
    const code = params.get('code');
    const verifier = this.config.storage.getItem(VERIFIER_KEY);
    const expectedState = this.config.storage.getItem(STATE_KEY);
    this.config.storage.removeItem(VERIFIER_KEY);
    this.config.storage.removeItem(STATE_KEY);
    if (!code || !verifier) throw new AuthError('Sign-in was interrupted; please try again.');
    if (!expectedState || params.get('state') !== expectedState) {
      throw new AuthError('Sign-in state did not match; please try again.');
    }
    await this.requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: verifier,
    });
  }

  isSignedIn(): boolean {
    return this.readToken() !== null;
  }

  signOut(): void {
    this.config.storage.removeItem(TOKEN_KEY);
  }

  /** Returns a usable access token, refreshing it when expired or when forced. */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const token = this.readToken();
    if (!token) throw new AuthError('Not signed in to Spotify.');
    if (!forceRefresh && token.expiresAt - EXPIRY_MARGIN_MS > this.now()) return token.accessToken;
    if (!token.refreshToken) {
      this.signOut();
      throw new AuthError('Spotify session expired; please sign in again.');
    }
    // Concurrent callers share a single refresh request.
    this.refreshing ??= this.requestToken({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      client_id: this.config.clientId,
    }).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async requestToken(body: Record<string, string>): Promise<string> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    if (!res.ok) {
      if (body.grant_type === 'refresh_token') this.signOut();
      let detail = `HTTP ${res.status}`;
      try {
        const json = (await res.json()) as { error_description?: string; error?: string };
        detail = json.error_description ?? json.error ?? detail;
      } catch {
        // Keep the status-only detail.
      }
      throw new AuthError(`Spotify token request failed: ${detail}`);
    }
    const json = (await res.json()) as TokenResponse;
    const previous = this.readToken();
    const token: StoredToken = {
      accessToken: json.access_token,
      // Spotify may omit a new refresh token on refresh; keep the old one then.
      refreshToken: json.refresh_token ?? previous?.refreshToken,
      expiresAt: this.now() + json.expires_in * 1000,
    };
    this.config.storage.setItem(TOKEN_KEY, JSON.stringify(token));
    return token.accessToken;
  }

  private readToken(): StoredToken | null {
    try {
      const raw = this.config.storage.getItem(TOKEN_KEY);
      return raw ? (JSON.parse(raw) as StoredToken) : null;
    } catch {
      return null;
    }
  }
}
