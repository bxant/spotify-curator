# spotify-curator

A local web page that suggests playlists from your Spotify **Liked Songs** and creates the ones you pick as private playlists in your Spotify account. It is built for big libraries (thousands of liked songs) with lots of never-played likes and whole albums liked at once.

It runs only on your machine at http://127.0.0.1:8888. Nothing is saved to disk except your config: fetched library data stays in the browser tab's `sessionStorage` and is gone when you close the tab.

## Suggested playlists

The page shows your Spotify profile, a few library stats, and one card per suggestion with its name, the reason for it, the track count, and a track preview. **Create in Spotify** creates a private playlist, adds the tracks 100 at a time, and then links to it on open.spotify.com and in the Spotify app.

| Playlist | How it is picked |
| --- | --- |
| **Real Favorites** | Liked songs that appear in your top tracks (4 weeks, 6 months, 1 year) or recent plays, most played first. |
| **Rediscover: Liked, Then Forgotten** | Songs you liked one by one more than 90 days ago that never appear in your top tracks or recent plays. 50 picks spread across the years you liked them, at most 2 per artist. |
| **Best of Each Album** | For albums you liked nearly whole in one sitting, only the tracks you actually play or liked on their own. |
| **Genre: …** | Up to 8 of your biggest artist genres, skipping genres that mostly repeat an earlier one. |
| **Key of …** | Up to 6 of the most common musical keys (with the Camelot code for harmonic mixing). |
| **The 1990s, …** | One playlist per release decade, in release order. |

Genre, key and decade playlists hold at most 100 tracks: played favorites first, then unplayed songs spread across your liked-at timeline, at most 4 per artist. They use the album-thinned library, so an album you liked whole contributes only its played tracks (or one track if none were played).

### How "played" is estimated

Spotify has no per-track play counts. A liked song counts as played when it appears in your top tracks for any time range or in your last 50 plays. Everything else counts as not listened to. Songs whose IDs differ between endpoints (relinked tracks) are matched by name and primary artist.

An album counts as "liked whole" when at least 4 of its tracks, and at least 40% of the album, were liked within one hour.

## Setup

You need Node.js 20.19 or newer and a Spotify developer app. Spotify requires the app owner to have Premium for Development Mode apps.

1. In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), open your app and add the redirect URI `http://127.0.0.1:8888/callback` exactly. Spotify rejects `localhost` for loopback redirect URIs.
2. Copy the config template and add your app's Client ID:

   ```sh
   cp .env.example .env
   # edit .env: VITE_SPOTIFY_CLIENT_ID=<your client id>
   ```

   `.env` is gitignored. Sign-in uses Authorization Code with PKCE, so there is no client secret.
3. Install dependencies once:

   ```sh
   npm install
   ```

## Run

```sh
npm start
```

Then open http://127.0.0.1:8888 in your browser. On WSL2, the Windows browser reaches the WSL server through localhost forwarding. If you open `localhost:8888`, the page switches to `127.0.0.1` so sign-in works.

Loading takes about a minute: ~80 pages of liked songs, then single-artist genre lookups and batched key lookups in the background. Genre and key playlists appear when those finish. **Refresh data** refetches your likes and listening history. Genres and keys are only looked up for new tracks and artists.

## Development

```sh
npm test          # unit tests (Vitest); no network or Client ID needed
npm run build     # typecheck + production build
```

| Path | Role |
| --- | --- |
| `src/curate.ts` | Pure curation logic (no network, no DOM), tested in `test/curate.test.ts` with fixture data |
| `src/spotify.ts` | Spotify Web API client: paging, 429 `Retry-After`, 401 refresh, playlist creation |
| `src/reccobeats.ts` | Musical key lookups via ReccoBeats |
| `src/auth.ts` | PKCE sign-in and token refresh |
| `src/library.ts` | Loads and caches library data and enrichments for the session |
| `src/main.ts` | The page |

## Spotify API usage

This app only uses endpoints that the Spotify Web API docs list as available to **Development Mode** apps after the [February 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026). Checked in September 2026.

| Purpose | Endpoint | Scope |
| --- | --- | --- |
| Profile (name, image) | `GET /me` | none |
| Liked Songs | `GET /me/tracks` (50 per page) | `user-library-read` |
| Top tracks / artists | `GET /me/top/{tracks,artists}` | `user-top-read` |
| Recently played | `GET /me/player/recently-played` | `user-read-recently-played` |
| Artist genres | `GET /artists/{id}` (one at a time) | none |
| Create playlist | `POST /me/playlists` (`public: false`) | `playlist-modify-private` |
| Add tracks | `POST /playlists/{id}/items` (100 per request) | `playlist-modify-private` |

Known limits:

- Recommendations, Audio Features, Audio Analysis and Related Artists are closed to new apps. The batch lookups (`GET /artists?ids=`, `GET /tracks?ids=`), Artist Top Tracks, and `POST /users/{id}/playlists` were removed for Development Mode, so none of them are used.
- Track and artist `popularity` were removed for Development Mode, so no playlist depends on popularity.
- Artist `genres` is marked deprecated and may be empty. Genre playlists use whatever Spotify returns, and the page says so when there are no genres.
- If Spotify asks the app to wait more than 2 minutes (a long `Retry-After`), genre lookups stop and the page keeps the genres it already has.

### Musical key (ReccoBeats)

Spotify no longer gives new apps musical key data. Keys come from [ReccoBeats](https://reccobeats.com), a free third-party API with no API key that returns Spotify-style audio features by Spotify track ID (`GET https://api.reccobeats.com/v1/audio-features?ids=…`, 40 IDs per request). The app sends it only Spotify track IDs, two requests at a time, and honors its `Retry-After`. Tracks it doesn't know have no key. If ReccoBeats is down or rate-limits hard, the page skips key playlists and shows a note.
