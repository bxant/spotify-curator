# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Commands: `npm test` (Vitest, offline, no Client ID needed), `npm run build` (tsc + Vite), `npm start` (dev server on http://127.0.0.1:8888). Node 20.19+; Vitest stays on 4.x because 5.x needs Node 22.
- Keep curation in `src/curate.ts` pure (no network, DOM, or clock reads) and test it with fixtures from `test/fixtures/`; API clients take injectable `fetch`/`sleep` so tests never hit the network.
- Spotify Development Mode sharp edges: only use endpoints listed in the README's "Spotify API usage" section, and re-check the Web API changelog before adding one. Batch lookups, popularity, artist top tracks, audio features and `POST /users/{id}/playlists` are gone, and artist `genres` is deprecated and may be empty.
- Keys and genres are looked up automatically in the background after the library loads (`src/enrich.ts`): ReccoBeats for keys, Wikidata first then MusicBrainz and Spotify for genres. Respect each service's limits as documented in README "Data sources" (MusicBrainz ~1 request/second through the client's throttle, Wikidata one query at a time, both with an identifying User-Agent); keep requests batched (OR-queries, `VALUES`), and list any new third-party service and what it receives in the page's Data sources and the README.
- UI checks without a Spotify account: run the dev server with any `VITE_SPOTIFY_CLIENT_ID`, then seed `sessionStorage` with `curator.token` (`{accessToken, refreshToken, expiresAt}`) and `curator.cache.v1.library` (a `LibrarySnapshot`) and reload; everything renders from the cache. Key and genre results live in `localStorage` (`curator.cache.v1.keys`, `…genres`, `…wikidata.artists`, `…musicbrainz.artists`); lookups for anything missing there start on their own against the live services. Routes and browse state live in the hash (`src/route.ts`).
- The redirect URI must be exactly `http://127.0.0.1:8888/callback` (Spotify rejects `localhost`). The Client ID lives only in the gitignored `.env`; never commit it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
