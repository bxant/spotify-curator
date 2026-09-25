# spotify-curator

A local web page that suggests playlists from your Spotify **Liked Songs** and creates the ones you pick as private playlists in your Spotify account. It is built for big libraries (thousands of liked songs) with lots of never-played likes and whole albums liked at once.

It runs only on your machine at http://127.0.0.1:8888, in a Spotify-style dark theme (a light theme is one click away). Nothing is saved to disk except your config: fetched library data stays in the browser tab's `sessionStorage` and is gone when you close the tab. Only the optional MusicBrainz genre lookups (public artist data that is slow to redo) and your theme choice are kept in the browser's `localStorage`; **Sign out** clears the lookups.

## Suggested playlists

The page shows your Spotify profile, a few library stats, and one card per suggestion with album-art, its name, the reason for it, the track count, what it covers (decade, genres, key), and a track preview. **Create in Spotify** creates a private playlist, adds the tracks 100 at a time, and then links to it on open.spotify.com and in the Spotify app. If the suggestion's tracks change later (for example when genres finish loading) or you click **Refresh data**, the card offers **Create in Spotify** again.

| Playlist | How it is picked |
| --- | --- |
| **Real Favorites** | Liked songs that appear in your top tracks (4 weeks, 6 months, 1 year) or recent plays, most played first. |
| **Rediscover: Liked, Then Forgotten** | Songs you liked one by one more than 90 days ago that never appear in your top tracks or recent plays. 50 picks spread across the years you liked them, at most 2 per artist. |
| **Best of Each Album** | For albums you liked nearly whole in one sitting, only the tracks you actually play or liked on their own. |
| **Artist: …** | Up to 6 of your most-liked and most-played artists (liked-song count and play signal count equally), one playlist each with up to 50 of their liked songs, played favorites first. Featured credits count. Artists need at least 8 liked songs. |
| **Genre: …** | Up to 8 of your biggest artist genres (from Spotify, plus MusicBrainz once you click **Find more genres**), skipping genres that mostly repeat an earlier one. |
| **Key of …** | Up to 6 of the most common musical keys (with the Camelot code for harmonic mixing). Only after you click **Find musical keys** (see [Musical key](#musical-key-reccobeats)). |
| **The 1990s, …** | One playlist per release decade, in release order. |

Genre, key and decade playlists hold at most 100 tracks: played favorites first, then unplayed songs spread across your liked-at timeline, at most 4 per artist. They use the album-thinned library, so an album you liked whole contributes only its played tracks (or one track if none were played).

### Sort and filter

Above the cards, sort the suggestions by type, decade, genre, key (Camelot order), artist or track count, and filter them by type, decade, genre, key, artist and size. A decade, genre or key describes a playlist when at least 20% of its tracks have it; an artist is listed for a playlist when at least 2 of its tracks are theirs. Each filter only offers values that match a suggestion. Genre filters include MusicBrainz genres, and key filters appear after **Find musical keys**.

### Curate a different set

**Curate a different set** opens a confirmation listing the current suggestions. Check the ones to keep (already-created ones start checked): kept suggestions carry over exactly as they are, and the rest are replaced by an alternative set with different genre, key and artist picks where there are more candidates than fit, and a different selection and order of tracks. Each new set is reproducible and differs from the last. Playlists you already created stay in Spotify and stay linked in **Created in Spotify this session** at the top of the page. **Refresh data** goes back to the default set.

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

Loading takes about a minute: ~80 pages of liked songs, then single-artist genre lookups in the background. Genre playlists appear when those finish. Key playlists appear only after you click **Find musical keys**, and MusicBrainz genres only after you click **Find more genres**. Both lookups show progress, can be stopped, and continue where they left off. **Refresh data** refetches your likes and listening history. Genres are only looked up for new artists, and keys for new tracks only when you click **Find musical keys** again.

## Development

```sh
npm test          # unit tests (Vitest); no network or Client ID needed
npm run build     # typecheck + production build
```

| Path | Role |
| --- | --- |
| `src/curate.ts` | Pure curation logic (no network, no DOM), including alternative sets and kept suggestions, tested in `test/curate.test.ts` with fixture data |
| `src/browse.ts` | Pure sort and filter logic for the suggestions |
| `src/spotify.ts` | Spotify Web API client: paging, 429 `Retry-After`, 401 refresh, playlist creation |
| `src/reccobeats.ts` | Musical key lookups via ReccoBeats |
| `src/musicbrainz.ts` | Artist matching (pure) and genre lookups via MusicBrainz |
| `src/auth.ts` | PKCE sign-in and token refresh |
| `src/library.ts` | Loads and caches library data and enrichments for the session |
| `src/main.ts` | The page |

## Spotify API usage

This app only uses endpoints that the Spotify Web API docs list as available to **Development Mode** apps after the [February 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026). Checked in September 2026.

| Purpose | Endpoint | Scope |
| --- | --- | --- |
| Profile (name, image) | `GET /me` | none |
| Liked Songs (with each track's ISRC from `external_ids`) | `GET /me/tracks` (50 per page) | `user-library-read` |
| Top tracks / artists | `GET /me/top/{tracks,artists}` | `user-top-read` |
| Recently played | `GET /me/player/recently-played` | `user-read-recently-played` |
| Artist genres | `GET /artists/{id}` (one at a time) | none |
| Create playlist | `POST /me/playlists` (`public: false`) | `playlist-modify-private` |
| Add tracks | `POST /playlists/{id}/items` (100 per request) | `playlist-modify-private` |

Known limits:

- Recommendations, Audio Features, Audio Analysis and Related Artists are closed to new apps. The batch lookups (`GET /artists?ids=`, `GET /tracks?ids=`), Artist Top Tracks, and `POST /users/{id}/playlists` were removed for Development Mode, so none of them are used.
- Track and artist `popularity` were removed for Development Mode, so no playlist depends on popularity. Track `external_ids` was removed in February 2026 and restored in March 2026; the ISRC is only used to match artists on MusicBrainz, and tracks without one fall back to name matching.
- Artist `genres` is marked deprecated and may be empty. Genre playlists use whatever Spotify returns, and the page says so when there are no genres.
- If Spotify asks the app to wait more than 2 minutes (a long `Retry-After`), genre lookups stop and the page keeps the genres it already has.

### Musical key (ReccoBeats)

Spotify no longer gives new apps musical key data. Keys come from [ReccoBeats](https://reccobeats.com), a free third-party API with no API key that returns Spotify-style audio features by Spotify track ID (`GET https://api.reccobeats.com/v1/audio-features?ids=…`, 40 IDs per request). Key lookup is opt-in: nothing is sent to ReccoBeats until you click **Find musical keys**, and page loads and **Refresh data** never start it. It then sends the Spotify track IDs of your liked songs (and nothing else), two requests at a time, and honors its `Retry-After`. Tracks it doesn't know have no key. If ReccoBeats is down or rate-limits hard, the page skips key playlists and shows a note.

### Genres (MusicBrainz)

Spotify's artist `genres` is deprecated and often empty, so genres can also come from [MusicBrainz](https://musicbrainz.org), the open music encyclopedia. Its API is free for non-commercial use with no API key; it asks for at most one request per second per IP and a User-Agent that identifies the app ([rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting), checked September 2026). Genre tags are MusicBrainz supplementary data under [CC BY-NC-SA](https://musicbrainz.org/doc/About/Data_License).

The lookup is opt-in like musical keys: nothing is sent until you click **Find more genres**. It then sends artist names and the ISRC codes of liked songs (and nothing else), 25 artists at a time:

1. One recording search for the artists' ISRCs (`GET /ws/2/recording?query=isrc:… OR isrc:…`). An artist matches when the recordings with their track's ISRC credit exactly one MusicBrainz artist with the same name (ignoring case, accents and punctuation).
2. For artists without an ISRC match, an exact-name artist search (`GET /ws/2/artist?query=artist:"…"`). Exactly one artist with that name matches; several (e.g. two bands called Nirvana) are skipped as ambiguous.
3. One artist search for the matched artists' tags (`GET /ws/2/artist?query=arid:… OR arid:…`). Genres are tags on MusicBrainz's official genre list (`GET /ws/2/genre/all?fmt=txt`, fetched once) with positive votes and at least a fifth of the top tag's votes, up to 5 per artist.

Requests start at least 1.1 s apart and slow to 2 s after a 503 (MusicBrainz's rate-limit answer). The page sends `User-Agent: spotify-curator/0.2.0 ( https://github.com/bxant/spotify-curator )`; browsers that refuse to set that header send their own. Results are cached per artist in `localStorage`, so later lookups only cover newly liked artists. MusicBrainz genres are merged with Spotify's, lowercased, into the same genre playlists and filters.
