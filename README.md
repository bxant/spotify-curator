# spotify-curator

A local web page that suggests playlists from your Spotify **Liked Songs** and creates the ones you pick as private playlists in your Spotify account. It is built for big libraries (thousands of liked songs) with lots of never-played likes and whole albums liked at once.

It runs only on your machine at http://127.0.0.1:8888, in a Spotify-style dark theme (a light theme is one click away). Nothing is saved to disk except your config: fetched library data stays in the browser tab's `sessionStorage` and is gone when you close the tab. Only the musical key and genre lookups (public data that is slow to redo, see [Data sources](#data-sources)) and your theme choice are kept in the browser's `localStorage`; **Sign out** clears the lookups.

## Suggested playlists

The page shows your Spotify profile, a few library stats, and under **Your recommendations** one card per suggestion with album-art, its name, the reason for it, the track count, what it covers (decade, genres, key), and a track preview. **Create in Spotify** creates a private playlist, adds the tracks 100 at a time, and then links to it on open.spotify.com and in the Spotify app. If the suggestion's tracks change later (for example when genres finish loading, or you remove a track) or you click **Refresh data**, it offers **Create in Spotify** again.

Click a card to open the playlist on its own page (`#/playlist/<key>`): big cover, reason, create controls, and the full track list with title, artist, album, year, and key and genres where known. **Back to recommendations** (or the browser's back button) returns to the grid with its sort, filters and scroll position as you left them; the page's address keeps the sort and filters (`#/?sort=decade&genre=rock`), so reloads keep them too.

On a playlist's page, **×** removes a track from that suggestion before you create it. Removed tracks stay listed below the track list, where **Restore** (or **Restore all**) brings them back. Removals apply everywhere the suggestion appears (card, counts, filters, and **Create in Spotify**) and last for the browser tab's session, across Back, reload, **Refresh data** and different sets.

### Already in your Spotify

On every load the page reads your own playlists (never changing them) so suggestions you saved in an earlier session are not offered again. Each playlist the app creates ends its description with `Curated from Liked Songs by spotify-curator.`; a suggestion counts as saved when one of your playlists with that tag (or the plain `Curated from Liked Songs.` earlier versions wrote) has its name. A same-named playlist without the tag, or a tagged one you renamed, counts only when at least 60% of the tracks are shared; the page reads the tracks of just those few playlists. Saved suggestions are hidden and the next candidates take their place where there are more (artist, genre and key picks). A line above the cards says how many are hidden; **Show them** lists them marked **In your Spotify**, with **Open in Spotify** and **Create again**.

Sessions signed in before the app asked to read playlists see a **Reconnect Spotify** link to grant it; until then only this session's playlists are recognized.

| Playlist | How it is picked |
| --- | --- |
| **Real Favorites** | Liked songs that appear in your top tracks (4 weeks, 6 months, 1 year) or recent plays, most played first. |
| **Rediscover: Liked, Then Forgotten** | Songs you liked one by one more than 90 days ago that never appear in your top tracks or recent plays. 50 picks spread across the years you liked them, at most 2 per artist. |
| **Best of Each Album** | For albums you liked nearly whole in one sitting, only the tracks you actually play or liked on their own. |
| **Artist: …** | Up to 6 of your most-liked and most-played artists (liked-song count and play signal count equally), one playlist each with up to 50 of their liked songs, played favorites first. Featured credits count. Artists need at least 8 liked songs. |
| **Genre: …** | Up to 8 of your biggest artist genres (from Spotify, Wikidata and MusicBrainz, found in the background), skipping genres that mostly repeat an earlier one. |
| **Key of …** | Up to 6 of the most common musical keys (with the Camelot code for harmonic mixing), found in the background (see [Musical key](#musical-key-reccobeats)). |
| **The 1990s, …** | One playlist per release decade, in release order. |

Genre, key and decade playlists hold at most 100 tracks: played favorites first, then unplayed songs spread across your liked-at timeline, at most 4 per artist. They use the album-thinned library, so an album you liked whole contributes only its played tracks (or one track if none were played).

### Sort and filter

The **Sort & filter these playlists** toolbar at the top of **Your recommendations** only changes which suggestions are shown and in what order; it never curates new ones. It shows how many of the playlists match and has a **Clear filters** button. Sort the suggestions by type, decade, genre, key (Camelot order), artist or track count, and filter them by type, decade, genre, key, artist and size. A decade, genre or key describes a playlist when at least 20% of its tracks have it; an artist is listed for a playlist when at least 2 of its tracks are theirs. Each filter only offers values that match a suggestion, so genre and key filters fill in as the background lookups find genres and keys.

### Curate a different set

**Curate a different set** (in the **Curation** section, above **Data sources**) opens a confirmation listing the current suggestions. Check the ones to keep (already-created ones start checked): kept suggestions carry over exactly as they are, and the rest are replaced by an alternative set with different genre, key and artist picks where there are more candidates than fit, and a different selection and order of tracks. Each new set is reproducible and differs from the last. Playlists you already created stay in Spotify and stay linked in **Created in Spotify this session** at the top of the page. A reload keeps the current set; **Refresh data** goes back to the default set.

### Build your own

**Build your own playlist** (in the **Curation** section, not the recommendations' filter toolbar) makes a new playlist from your Liked Songs instead of narrowing the suggestions. Pick any mix of genres, decades, keys and artists (each optional, several values each) and how many songs you want (5 to 100, 25 by default). A song matches when it has any chosen value of every kind you chose: "rock or jazz, from the 1990s or 2000s". The form shows how many liked songs match as you choose; genre and key choices grow as the background lookups find more.

**Build playlist** opens the result on its own page (`#/playlist/custom`) with the same track removal and **Create in Spotify** as a suggestion. Songs are picked at random, played favorites up to three times as likely, and spread across artists: no artist gets a second song until every matching artist has one, except that on **Try again** songs no earlier try picked come first, so an artist can get a second song before an artist whose only matches were picked last time. When fewer songs match than you asked for, all of them are in and the page says so. **Try again** picks a different selection with the same choices, preferring songs no earlier try picked (then the ones picked longest ago), so it is disabled when every match is already in. The choices and the latest playlist last for the tab's session; **Refresh data** keeps the choices but drops the playlist (and its removals), so build again from the fresh library.

### How "played" is estimated

Spotify has no per-track play counts. A liked song counts as played when it appears in your top tracks for any time range or in your last 50 plays. Everything else counts as not listened to. Songs whose IDs differ between endpoints (relinked tracks) are matched by name and primary artist.

An album counts as "liked whole" when at least 4 of its tracks, and at least 40% of the album, were liked within one hour.

## Musicians Corner

A play-along corner for guitarists, part of the same app. **Musicians Corner ↗** in the header (once signed in) opens it in a new browser tab, already signed in and with the library this tab loaded.

**Goals.** Make the key playlists the curator already suggests useful for jamming: pick a playlist in a key you like, see how to play each song on guitar, and jump to chords and the recording. It reuses the curator's suggestions, playlist pages and **Create in Spotify** rather than curating anything of its own, and it never fetches, scrapes or embeds chord data: chords stay on Ultimate Guitar. Later ideas (not built yet): a **Find on YouTube** link per song.

What it shows (`#/musicians`):

- The **Key of …** playlists from your current recommendations (including any already in your Spotify, marked as such), each with its Camelot code and a capo hint for the key. A different set in the curator tab shows up here on the next load.
- **Easy guitar keys only** limits the list to keys playable with open chords and no capo: G, C, D, A or E major, or E, A or D minor (`#/musicians?easy=1`).
- Opening a playlist shows its own page (`#/musicians/playlist/<key>`), like the curator's: track removal and **Create in Spotify**, so the playlist is easy to find in Spotify while you play. Each song also shows its key, a capo hint, **Chords ↗** (an [Ultimate Guitar](https://www.ultimate-guitar.com) search for the artist and title) and **Play ↗** (the track on open.spotify.com), both in a new tab.
- While keys are still being looked up and there are no key playlists yet, it says so and the background-lookup panel shows the progress.

Capo hints (`capoHint` in `src/musicians-corner/guitar.ts`) pick the lowest capo fret that lets you play the key with open shapes of the same mode: G, C, D, A, E for major keys, Em, Am, Dm for minor ones. F major is "Capo 1 · E shapes" (play the chords a semitone lower, as E shapes; or capo 3 with D shapes); every key needs at most a capo on fret 4.

### How the new tab arrives signed in

The sign-in token and library live in each tab's `sessionStorage`, so a plain new tab would start signed out. The header link carries a one-off nonce (`/?handoff=<nonce>#/musicians`); the new tab asks for its session over a same-origin [`BroadcastChannel`](https://developer.mozilla.org/docs/Web/API/BroadcastChannel), and only the tab that made that link answers, with the token and the `curator.cache.v1.*` entries (never the PKCE verifier). The new tab copies them into its own `sessionStorage`, drops the nonce from the address, and loads from that cache without refetching the library. Nothing passes through `localStorage` or disk, so tokens still vanish when the tabs close. If no tab answers within 4 seconds (the curator tab was closed or signed out), the new tab offers **Connect Spotify** and returns to the corner after signing in.

The tabs stay in step afterwards: **Sign out** in any tab signs out every curator tab (each clears its own session data, and the shared lookup cache is cleared as before), and a refreshed token is passed to tabs holding the refresh token it replaced. Key and genre lookups run in one tab at a time (a [Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API)), so a second tab never doubles the request rate to the lookup services; a waiting tab picks up the results the other one saves. Removals, created playlists and a different set are per tab after the handoff.

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

Loading your library takes under a minute (~90 pages of liked songs). The playlists that need no extra data (favorites, rediscover, albums, artists, decades) show up right away, and musical keys and genres are then [looked up in the background](#background-lookups): key and genre playlists appear and fill in as results arrive, without moving the cards you are looking at. **Refresh data** refetches your likes and listening history; keys and genres are only looked up for songs and artists that are new since the last lookup.

## Development

```sh
npm test          # unit tests (Vitest); no network or Client ID needed
npm run build     # typecheck + production build
```

| Path | Role |
| --- | --- |
| `src/curate.ts` | Pure curation logic (no network, no DOM), including alternative sets and kept suggestions, tested in `test/curate.test.ts` with fixture data |
| `src/builder.ts` | Pure "Build your own" matching and picking, tested in `test/builder.test.ts` |
| `src/browse.ts` | Pure sort and filter logic for the suggestions |
| `src/route.ts` | Pure hash routes: the recommendations (sort and filters in the query), playlist pages, and the Musicians Corner |
| `src/removed-store.ts` | Tracks removed from suggestions, kept for the session |
| `src/saved.ts` | Pure matching of suggestions against the playlists already in your Spotify, tested with `test/fixtures/saved-playlists.ts` |
| `src/spotify.ts` | Spotify Web API client: paging, 429 `Retry-After`, 401 refresh, playlist creation, reading your own playlists |
| `src/enrich.ts` | Background key and genre lookups: runs the services in order, merges their genres, counts progress |
| `src/reccobeats.ts` | Musical key lookups via ReccoBeats |
| `src/wikidata.ts` | Batched artist genre and MusicBrainz ID lookups via Wikidata |
| `src/musicbrainz.ts` | Artist matching (pure) and genre lookups via MusicBrainz |
| `src/auth.ts` | PKCE sign-in and token refresh |
| `src/library.ts` | Loads and caches library data (for the session) and key and genre lookups (in the browser) |
| `src/musicians-corner/guitar.ts` | Pure capo hints, easy-key filter and play-along links (Ultimate Guitar search, open.spotify.com), tested in `test/musicians-corner.test.ts` |
| `src/musicians-corner/handoff.ts` | Hands the sign-in and session cache to the Musicians Corner tab and keeps tabs in step (sign-out, token refresh), tested in `test/handoff.test.ts` |
| `src/musicians-corner/shared-lookups.ts` | Lets one tab at a time run the key and genre lookups |
| `src/musicians-corner/view.ts` | The Musicians Corner page and its extra track columns |
| `src/dom.ts` | Tiny DOM helpers shared by the views |
| `src/main.ts` | The page: routes, the curator views, playlist pages |

## Spotify API usage

This app only uses endpoints that the Spotify Web API docs list as available to **Development Mode** apps after the [February 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026). Checked in September 2026.

| Purpose | Endpoint | Scope |
| --- | --- | --- |
| Profile (name, image) | `GET /me` | none |
| Liked Songs (with each track's ISRC from `external_ids`) | `GET /me/tracks` (50 per page) | `user-library-read` |
| Top tracks / artists | `GET /me/top/{tracks,artists}` | `user-top-read` |
| Recently played | `GET /me/player/recently-played` | `user-read-recently-played` |
| Artist genres | `GET /artists/{id}` (one at a time, only for artists other sources have no genres for) | none |
| Your own playlists (to recognize saved suggestions) | `GET /me/playlists` (50 per page) | `playlist-read-private` |
| Tracks of a few of your own playlists | `GET /playlists/{id}/items` | `playlist-read-private` |
| Create playlist | `POST /me/playlists` (`public: false`) | `playlist-modify-private` |
| Add tracks | `POST /playlists/{id}/items` (100 per request) | `playlist-modify-private` |

Known limits:

- Recommendations, Audio Features, Audio Analysis and Related Artists are closed to new apps. The batch lookups (`GET /artists?ids=`, `GET /tracks?ids=`), Artist Top Tracks, and `POST /users/{id}/playlists` were removed for Development Mode, so none of them are used.
- Track and artist `popularity` were removed for Development Mode, so no playlist depends on popularity. Track `external_ids` was removed in February 2026 and restored in March 2026; the ISRC is only used to match artists on MusicBrainz, and tracks without one fall back to name matching.
- Artist `genres` is marked deprecated and may be empty. Genre playlists use whatever Spotify returns, and the page says so when there are no genres.
- If Spotify asks the app to wait more than 2 minutes (a long `Retry-After`), genre lookups stop and the page keeps the genres it already has.

## Data sources

Spotify has closed musical keys (audio features) to new developer apps and deprecated artist genres, so the page fills those gaps from free, open services that need no account or API key. The page names them, says what each one receives, and explains why under **Data sources** (in the **Curation** section, and in the background-lookup panel on every page):

| Service | Gives | Receives |
| --- | --- | --- |
| Spotify | Profile, Liked Songs, top items, recent plays, any artist genres it still has; creates the playlists you pick | Your sign-in, and the playlists you create |
| [ReccoBeats](https://reccobeats.com) | Musical keys | The Spotify track IDs of your liked songs |
| [Wikidata](https://www.wikidata.org) | Artist genres and MusicBrainz artist IDs | Spotify artist IDs |
| [MusicBrainz](https://musicbrainz.org) | Genres for artists Wikidata has none for | Spotify artist IDs, artist names, MusicBrainz artist IDs, and the ISRC recording codes of liked songs |
| [Ultimate Guitar](https://www.ultimate-guitar.com) | Nothing to the page: **Chords ↗** in the [Musicians Corner](#musicians-corner) opens its search in a new tab | Only when you click **Chords ↗**: that song's artist and title, in the search address your browser opens |

None of them receive your Spotify account, sign-in or listening history. Results are cached per song or artist in `localStorage`, so later visits (and **Refresh data**) only look up what is new; **Sign out** clears them.

### Background lookups

Key and genre lookups start on their own once the library is loaded. A small panel in the bottom corner of every page says that the playlists shown are ready while it is still "Finding keys and genres… 1,240 of 4,512 songs", with a progress bar, **Stop** (keeps what was found; **Resume** continues), and the **Data sources** list. It ends with "Keys and genres are up to date" and how many songs have a key and genres, or says which service could not finish (with **Try again**) while the playlists use what was found. The panel can be shrunk to its icon.

The lookups walk the whole library until every song is covered, most-liked artists first, in two lanes at once (`src/enrich.ts`):

1. **Keys**: ReccoBeats, 40 tracks per request (its maximum), two requests at a time.
2. **Genres**: Wikidata first, 250 artists per query. Then, for artists still without genres, MusicBrainz and Spotify's single-artist lookups side by side; each skips an artist another source has found genres for by the time its turn comes.

While results arrive, the suggestions are re-curated at most every 3 seconds when the browser is idle (curating 4,500 songs takes about 50–120 ms). Cards that did not change stay on the page untouched, so the ones in view do not jump; new key and genre playlists fade in. A playlist's own page does not change its tracks under you: it offers **Show the update** instead.

Measured in October 2026 against the live services, on a 4,500-song library of real Spotify tracks with 3,220 artists (more artists per song than most libraries), from an empty cache. Spotify's artist lookups were simulated as returning no genres, so they saved MusicBrainz no work:

| | Keys done | 90% of songs settled | 95% | All done | Songs with genres |
| --- | --- | --- | --- | --- | --- |
| 1,249 artists unknown to Wikidata, but linked to Spotify on MusicBrainz | 23 s | 65 s | 83 s | **2 min 17 s** | 3,996 |
| The same artists unknown to both (only ISRC and name matching left) | 22 s | 4 min 44 s | 5 min 26 s | 7 min 14 s | 3,695 |

The first row is close to a typical library; the second is a worst case. Before this change, MusicBrainz alone (one artist at a time by ISRC or name) took about 17 minutes for a library this size. A later visit with everything cached makes no requests at all.

### Musical key (ReccoBeats)

Spotify no longer gives new apps musical key data. Keys come from [ReccoBeats](https://reccobeats.com), a free third-party API with no API key that returns Spotify-style audio features by Spotify track ID (`GET https://api.reccobeats.com/v1/audio-features?ids=…`, at most 40 IDs per request). Its [terms](https://reccobeats.com/docs/documentation/terms-of-service) allow free personal and commercial use but no abuse or overload, and its [rate limits](https://reccobeats.com/docs/documentation/rate-limiting) are not published beyond a `429` with `Retry-After` (checked October 2026). The page sends the Spotify track IDs of your liked songs (and nothing else), two requests at a time, and honors `Retry-After`. Tracks it doesn't know have no key. If ReccoBeats is down or rate-limits hard, the page skips key playlists and says so.

### Genres (Wikidata)

[Wikidata](https://www.wikidata.org) is the free knowledge base behind Wikipedia; its data is CC0. Many artists there carry their Spotify artist ID ([P1902](https://www.wikidata.org/wiki/Property:P1902)), their genres ([P136](https://www.wikidata.org/wiki/Property:P136)) and their MusicBrainz artist ID ([P434](https://www.wikidata.org/wiki/Property:P434)), so one SPARQL query (`POST https://query.wikidata.org/sparql`) answers for 250 Spotify artists in about a second. The query service allows each client 60 seconds of query time per minute and 5 parallel queries, and answers `429` with `Retry-After` beyond that ([limits](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual#Query_limits), checked October 2026); the page runs one query at a time and honors `Retry-After`. It identifies itself with `User-Agent` and, since browsers may not let a page set that, `Api-User-Agent` (the same `spotify-curator/…` identity as for MusicBrainz below), as the [User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy) asks. Wikidata's English genre labels are matched to MusicBrainz' genre list (so "rock music" becomes "rock" and "Hip-Hop" becomes "hip hop"); labels that are not genres there are dropped.

### Genres (MusicBrainz)

[MusicBrainz](https://musicbrainz.org), the open music encyclopedia, covers artists Wikidata has no genres for. Its API is free for non-commercial use with no API key; it asks for at most one request per second per IP and a User-Agent that identifies the app ([rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting), checked October 2026). Genre tags are MusicBrainz supplementary data under [CC BY-NC-SA](https://musicbrainz.org/doc/About/Data_License).

Artists are handled most-liked first, cheapest requests first:

1. Artists Wikidata linked to MusicBrainz need no matching: one artist search reads the tags of up to 100 of them (`GET /ws/2/artist?query=arid:… OR arid:…`).
2. For the others, one URL search finds MusicBrainz' links to 50 artists' Spotify pages (`GET /ws/2/url?query=url:"https://open.spotify.com/artist/…" OR …`). An artist matches when exactly one MusicBrainz artist links to their page.
3. Still unmatched artists: one recording search for 25 artists' ISRCs (`GET /ws/2/recording?query=isrc:… OR isrc:…`). An artist matches when the recordings with their track's ISRC credit exactly one MusicBrainz artist with the same name (ignoring case, accents and punctuation).
4. Last, for artists with at least 2 liked songs, one exact-name artist search each (`GET /ws/2/artist?query=artist:"…"`). Exactly one artist with that name matches; several (e.g. two bands called Nirvana) are skipped as ambiguous. Artists with a single liked song are not searched by name: that would cost over a second per song for at most one song's genres, and in live runs it found genres for well under 1% of songs.

Matched artists' tags are read 100 at a time as above. Genres are tags on MusicBrainz's official genre list (`GET /ws/2/genre/all?fmt=txt`, fetched once) with positive votes and at least a fifth of the top tag's votes, up to 5 per artist. Requests start at least 1.1 s apart (two may be open at once, since MusicBrainz answers can take longer than that), slow to 2 s after a 503 (MusicBrainz's rate-limit answer), and return to 1.1 s after 30 answered requests in a row. The page sends `User-Agent: spotify-curator/0.2.0 ( https://github.com/bxant/spotify-curator )`; browsers that refuse to set that header send their own. Spotify, Wikidata and MusicBrainz genres are merged, lowercased, into the same genre playlists and filters.
