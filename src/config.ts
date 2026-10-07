// Runtime configuration. The Client ID comes from .env (VITE_SPOTIFY_CLIENT_ID)
// locally, or from the host's build environment when deployed, and is never
// committed; see .env.example and the README.

export const PLACEHOLDER_CLIENT_ID = 'your-client-id-here';

/**
 * The sign-in redirect URI for the page's own origin, e.g.
 * http://127.0.0.1:8888/callback locally or https://<project>.pages.dev/callback
 * when hosted. It must match a redirect URI registered on the Spotify app exactly.
 */
export function redirectUri(origin: string): string {
  return `${origin}/callback`;
}

/** Normalizes the raw VITE_SPOTIFY_CLIENT_ID value; null when unset or still the placeholder. */
export function configuredClientId(raw: string | undefined): string | null {
  const id = raw?.trim();
  return id && id !== PLACEHOLDER_CLIENT_ID ? id : null;
}
