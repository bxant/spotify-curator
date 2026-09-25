import './style.css';
import { AuthError, SpotifyAuth } from './auth';
import { browse, filterOptions, playlistFacets, type BrowseCriteria, type Browsable, type SortOrder } from './browse';
import { REDIRECT_URI, configuredClientId } from './config';
import { curate, keepSelected, mergeGenres, trackSignature, withKept, type CurationResult } from './curate';
import {
  artistsToMatch,
  cachedMusicBrainz,
  loadGenres,
  loadKeys,
  loadLibrary,
  loadMusicBrainz,
  musicBrainzGenres,
  saveKeys,
  type LibrarySnapshot,
} from './library';
import { MusicBrainzClient, type ArtistGenreMatch } from './musicbrainz';
import { ReccoBeatsClient } from './reccobeats';
import { SessionCache, browserCache } from './session-cache';
import { CreatedStore } from './created-store';
import { SpotifyClient, type CreatedPlaylist } from './spotify';
import type { CuratedPlaylist, LikedTrack, PlaylistKind, TrackKey } from './types';

const app = document.getElementById('app') as HTMLElement;
const cache = new SessionCache();
/** MusicBrainz matches outlive the tab: they are public data and slow to look up again. */
const lookupCache = browserCache();
/** Redraws the create controls of the card currently on the page for a playlist key. */
const createControlRefreshers = new Map<string, () => void>();
const createdStore = new CreatedStore(cache, (key) => {
  createControlRefreshers.get(key)?.();
  createdListRefresher?.();
});
let createdListRefresher: (() => void) | undefined;

/** Playlist description limit on Spotify. */
const DESCRIPTION_MAX = 300;
const PREVIEW_COUNT = 5;
/** Rough MusicBrainz pace for the estimate shown before a lookup (batched searches plus name fallbacks). */
const MB_SECONDS_PER_ARTIST = 0.45;
const THEME_KEY = 'curator.theme';
/** Bumped on every (re)load so enrichment from an older load cannot re-render the page. */
let generation = 0;
/** Aborted with each new generation so an older load's lookups stop making requests. */
let lookups = new AbortController();

function nextGeneration(): number {
  lookups.abort();
  lookups = new AbortController();
  return ++generation;
}

type Child = Node | string | null | undefined | false;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  for (const child of children) if (child) el.append(child);
  return el;
}

const ICONS = {
  note: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z',
  tag: 'M21.4 11.6 12.4 2.6A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7c0 .55.22 1.05.59 1.42l9 9a2 2 0 0 0 2.82 0l7-7a2 2 0 0 0 0-2.82ZM6.5 8A1.5 1.5 0 1 1 6.5 5a1.5 1.5 0 0 1 0 3Z',
  shuffle:
    'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41ZM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5Zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13Z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM2 13h2v-2H2v2Zm18 0h2v-2h-2v2ZM11 2v2h2V2h-2Zm0 18v2h2v-2h-2ZM5.99 4.58 4.58 5.99l1.41 1.42L7.41 6 5.99 4.58Zm12.02 12.03-1.41 1.41 1.41 1.42 1.42-1.42-1.42-1.41ZM19.42 6 18 4.58 16.59 6 18 7.41 19.42 6ZM7.41 18.01 6 16.59l-1.42 1.42L6 19.42l1.41-1.41Z',
  moon: 'M12.3 22a10 10 0 0 1-2.9-19.57A8 8 0 0 0 21.57 14.6 10 10 0 0 1 12.3 22Z',
} as const;

function icon(name: keyof typeof ICONS): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function button(label: Child | Child[], attrs: Record<string, string>, onClick: () => void): HTMLButtonElement {
  const el = h('button', { type: 'button', ...attrs }, ...(Array.isArray(label) ? label : [label])) as HTMLButtonElement;
  el.addEventListener('click', onClick);
  return el;
}

function show(...nodes: Child[]) {
  app.replaceChildren(...nodes.filter((n): n is Node | string => !!n));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Theme: dark by default, light on request, remembered in this browser.

function savedTheme(): 'light' | 'dark' {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
}

function themeToggle(): HTMLElement {
  const current = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const next = () => (current() === 'dark' ? 'light' : 'dark');
  const label = () => `Switch to ${next()} theme`;
  const el = button(icon(current() === 'dark' ? 'sun' : 'moon'), { class: 'icon-button', 'aria-label': label(), title: label() }, () => {
    const theme = next();
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Not remembered; still applies for this page.
    }
    applyTheme(theme);
    el.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
    el.setAttribute('aria-label', label());
    el.title = label();
  });
  return el;
}

// ---------------------------------------------------------------------------

async function start() {
  applyTheme(savedTheme());
  // Spotify only accepts the 127.0.0.1 redirect URI; keep the whole session on
  // that origin so the PKCE verifier in sessionStorage is found on return.
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }

  const clientId = configuredClientId(import.meta.env.VITE_SPOTIFY_CLIENT_ID);
  if (!clientId) {
    showSetup();
    return;
  }

  const auth = new SpotifyAuth({ clientId, redirectUri: REDIRECT_URI, storage: sessionStorage });

  if (location.pathname === '/callback') {
    try {
      await auth.handleCallback(location.search);
    } catch (err) {
      history.replaceState(null, '', '/');
      showSignIn(auth, errorText(err));
      return;
    }
    history.replaceState(null, '', '/');
  }

  if (!auth.isSignedIn()) {
    showSignIn(auth);
    return;
  }
  await showCurator(auth);
}

function brand(): HTMLElement {
  return h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('note')), 'Liked Songs Curator');
}

function showSetup() {
  show(
    h(
      'section',
      { class: 'panel center' },
      brand(),
      h('h1', {}, 'Almost ready'),
      h('p', {}, 'No Spotify Client ID is configured yet.'),
      h(
        'p',
        {},
        'Copy ',
        h('code', {}, '.env.example'),
        ' to ',
        h('code', {}, '.env'),
        ', set ',
        h('code', {}, 'VITE_SPOTIFY_CLIENT_ID'),
        ' to your app’s Client ID, make sure ',
        h('code', {}, REDIRECT_URI),
        ' is a registered redirect URI, then restart ',
        h('code', {}, 'npm start'),
        '.',
      ),
    ),
  );
}

function showSignIn(auth: SpotifyAuth, error?: string) {
  const connect = button('Connect Spotify', { class: 'primary large' }, async () => {
    connect.disabled = true;
    location.assign(await auth.authorizeUrl());
  });
  show(
    h(
      'section',
      { class: 'panel center' },
      brand(),
      h('h1', {}, 'Playlists from the songs you already love'),
      h(
        'p',
        {},
        'Suggests playlists from your Liked Songs — real favorites, forgotten likes, the best of albums you liked whole, ' +
          'your top artists, genres, musical keys and decades — and creates the ones you pick as private playlists in your Spotify account.',
      ),
      error && h('p', { class: 'error' }, error),
      connect,
      h(
        'p',
        { class: 'muted small' },
        'Read-only access to your library, top items and recent plays, plus permission to create private playlists. ' +
          'Nothing is stored outside this browser.',
      ),
    ),
  );
}

interface LookupRun {
  running: boolean;
  done: number;
  total: number;
  etaSeconds?: number;
  error?: string;
  stop?: () => void;
}

interface CuratorState {
  library: LibrarySnapshot;
  genres: Record<string, string[]>;
  keys: Record<string, TrackKey | null>;
  musicBrainz: Record<string, ArtistGenreMatch>;
  notes: string[];
  genreProgress: string;
  keyRun: LookupRun;
  mbRun: LookupRun;
  /** 0 is the default set; each "Curate a different set" moves to the next one. */
  variant: number;
  /** Suggestions the owner kept when curating a different set, exactly as they were. */
  kept: CuratedPlaylist[];
  criteria: BrowseCriteria;
}

const DEFAULT_CRITERIA: BrowseCriteria = { sort: 'recommended' };

async function showCurator(auth: SpotifyAuth, forceReload = false) {
  const current = nextGeneration();
  const signal = lookups.signal;
  const client = new SpotifyClient({ getToken: (force) => auth.getAccessToken(force) });
  const status = h('p', { class: 'muted' }, 'Connecting to Spotify…');
  show(h('section', { class: 'panel center' }, brand(), h('h1', {}, 'Reading your library'), h('div', { class: 'spinner', 'aria-hidden': 'true' }), status));

  let library: LibrarySnapshot;
  try {
    library = await loadLibrary(client, cache, (message) => (status.textContent = message), forceReload);
  } catch (err) {
    if (current !== generation) return;
    if (err instanceof AuthError) {
      auth.signOut();
      showSignIn(auth, err.message);
      return;
    }
    show(
      h(
        'section',
        { class: 'panel center' },
        h('h1', {}, 'Could not load your library'),
        h('p', { class: 'error' }, errorText(err)),
        button('Try again', {}, () => showCurator(auth, forceReload)),
      ),
    );
    return;
  }

  if (current !== generation) return;
  const state: CuratorState = {
    library,
    genres: cache.get<Record<string, string[]>>('genres') ?? {},
    keys: cache.get<Record<string, TrackKey | null>>('keys') ?? {},
    musicBrainz: cachedMusicBrainz(lookupCache),
    notes: [],
    genreProgress: '',
    keyRun: { running: false, done: 0, total: 0 },
    mbRun: { running: false, done: 0, total: 0 },
    variant: 0,
    kept: [],
    criteria: { ...DEFAULT_CRITERIA },
  };

  /** A signal that aborts on a new page load or when the owner clicks Stop. */
  const stoppable = (run: LookupRun) => {
    const own = new AbortController();
    run.stop = () => own.abort();
    return { signal: AbortSignal.any([signal, own.signal]), own: own.signal };
  };

  // Key lookups send track IDs to ReccoBeats, so they only start when the owner asks.
  const findKeys = () => {
    const run = state.keyRun;
    const { signal: runSignal, own } = stoppable(run);
    Object.assign(run, { running: true, done: 0, total: 0, error: undefined });
    view.render();
    void loadKeys(
      new ReccoBeatsClient(),
      library.liked,
      cache,
      (done, total) => {
        Object.assign(run, { done, total });
        view.renderProgress();
      },
      runSignal,
    ).then((result) => {
      if (signal.aborted) return;
      state.keys = result.data;
      // Stopped by the owner: keep what loaded, as a later click continues from there.
      const error = own.aborted ? undefined : result.error;
      if (own.aborted) saveKeys(cache, result.data);
      Object.assign(run, { running: false, stop: undefined, error });
      if (error) state.notes.push(`Musical key lookup stopped early (${error}); key playlists use what loaded.`);
      view.render();
    });
  };

  // MusicBrainz lookups send artist names and ISRCs, so they also wait for the owner.
  const findGenres = () => {
    const run = state.mbRun;
    const { signal: runSignal } = stoppable(run);
    Object.assign(run, { running: true, done: 0, total: artistsToMatch(library.liked, state.musicBrainz).length, error: undefined });
    run.etaSeconds = Math.round(run.total * MB_SECONDS_PER_ARTIST);
    view.render();
    void loadMusicBrainz(
      new MusicBrainzClient(),
      library.liked,
      lookupCache,
      (progress, data) => {
        Object.assign(run, progress);
        state.musicBrainz = data;
        // New genres change the suggestions; redraw them as each batch lands.
        view.render();
      },
      runSignal,
    ).then((result) => {
      if (signal.aborted) return;
      state.musicBrainz = result.data;
      Object.assign(run, { running: false, stop: undefined, error: result.error });
      if (result.error) state.notes.push(`MusicBrainz genre lookup stopped early (${result.error}); genre playlists use what loaded.`);
      view.render();
    });
  };

  const view = createCuratorView(auth, client, state, () => current === generation, { findKeys, findGenres });
  view.render();

  // Re-curate when genres finish so genre playlists appear.
  const result = await loadGenres(
    client,
    library.liked,
    cache,
    (done, total) => {
      state.genreProgress = `Reading Spotify artist genres… ${done.toLocaleString()} / ${total.toLocaleString()}`;
      view.renderProgress();
    },
    signal,
  );
  if (signal.aborted) return;
  state.genres = result.data;
  state.genreProgress = '';
  if (result.error) state.notes.push(`Artist genre lookup stopped early (${result.error}); genre playlists use what loaded.`);
  view.render();
}

interface Actions {
  findKeys: () => void;
  findGenres: () => void;
}

function createCuratorView(
  auth: SpotifyAuth,
  client: SpotifyClient,
  state: CuratorState,
  isCurrent: () => boolean,
  actions: Actions,
) {
  /** Live parts of the enrichment cards, updated in place so buttons keep working mid-lookup. */
  const live = {
    spotifyGenres: h('p', { class: 'muted small live' }),
    keyBar: h('progress', { max: '1', value: '0' }) as HTMLProgressElement,
    keyText: h('span', {}),
    mbBar: h('progress', { max: '1', value: '0' }) as HTMLProgressElement,
    mbText: h('span', {}),
  };

  const renderProgress = () => {
    if (!isCurrent()) return;
    live.spotifyGenres.textContent = state.genreProgress;
    live.spotifyGenres.hidden = !state.genreProgress;
    setBar(live.keyBar, state.keyRun);
    live.keyText.textContent = state.keyRun.total
      ? `${state.keyRun.done.toLocaleString()} / ${state.keyRun.total.toLocaleString()} songs`
      : 'Starting…';
    setBar(live.mbBar, state.mbRun);
    live.mbText.textContent =
      `${state.mbRun.done.toLocaleString()} / ${state.mbRun.total.toLocaleString()} artists` +
      (state.mbRun.etaSeconds ? ` · about ${duration(state.mbRun.etaSeconds)} left` : '');
  };

  const render = () => {
    if (!isCurrent()) return;
    // Keep expanded track lists open across re-renders.
    const open = new Set(
      [...app.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.dataset.key ?? ''),
    );
    const mbGenres = musicBrainzGenres(state.musicBrainz);
    const result = curate(state.library.liked, state.library.history, {
      now: new Date(),
      artistGenres: state.genres,
      musicBrainzGenres: mbGenres,
      trackKeys: state.keys,
      variant: state.variant,
    });
    const shown = withKept(state.kept, result.playlists);
    const facetInputs = { artistGenres: mergeGenres(state.genres, mbGenres), trackKeys: state.keys };
    const items: Browsable[] = shown.map((playlist) => ({ playlist, facets: playlistFacets(playlist, facetInputs) }));
    const keptKeys = new Set(state.kept.map((p) => p.key));

    const grid = h('div', { class: 'grid' });
    const count = h('p', { class: 'muted small', role: 'status' });
    const renderGrid = () => {
      const visible = browse(items, state.criteria);
      count.textContent =
        visible.length === items.length
          ? `${items.length} suggestions`
          : `Showing ${visible.length} of ${items.length} suggestions`;
      grid.replaceChildren(
        ...(visible.length > 0
          ? visible.map(({ playlist, facets }) => playlistCard(client, playlist, facets, open.has(playlist.key), keptKeys.has(playlist.key)))
          : [h('p', { class: 'muted empty' }, items.length === 0 ? 'Not enough liked songs or listening history to suggest playlists yet.' : 'No suggestions match these filters.')]),
      );
    };

    renderProgress();
    show(
      topBar(auth),
      hero(state, result),
      createdList(),
      enrichSection(state, result, live, actions),
      h(
        'section',
        { class: 'suggestions', 'aria-labelledby': 'suggestions-title' },
        h(
          'div',
          { class: 'section-head' },
          h('div', {}, h('h2', { id: 'suggestions-title' }, state.variant === 0 ? 'Suggested playlists' : `Suggested playlists · set ${state.variant + 1}`), count),
          items.length > 0 &&
            button([icon('shuffle'), 'Curate a different set'], { class: 'secondary' }, () =>
              recurateDialog(shown, keptKeys, (keep) => {
                state.kept = keepSelected(shown, keep);
                state.variant++;
                render();
              }),
            ),
        ),
        browseBar(items, state, renderGrid),
        grid,
      ),
    );
    renderGrid();
  };

  return { render, renderProgress };
}

function setBar(bar: HTMLProgressElement, run: LookupRun) {
  if (run.total > 0) {
    bar.max = run.total;
    bar.value = run.done;
  } else {
    bar.removeAttribute('value'); // indeterminate
  }
}

function duration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds / 10) * 10)} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function topBar(auth: SpotifyAuth): HTMLElement {
  // Refetches likes and listening history; genre and key lookups stay cached and
  // only newly liked tracks' artists (and, on request, keys) are looked up.
  const refresh = button('Refresh data', { class: 'ghost', title: 'Refetch Liked Songs and listening history' }, () => {
    createdStore.reset();
    void showCurator(auth, true);
  });
  const signOut = button('Sign out', { class: 'ghost' }, () => {
    nextGeneration();
    createdStore.reset();
    cache.clear();
    lookupCache.clear();
    auth.signOut();
    showSignIn(auth);
  });
  return h('header', { class: 'topbar' }, brand(), h('div', { class: 'actions' }, themeToggle(), refresh, signOut));
}

function hero(state: CuratorState, result: CurationResult): HTMLElement {
  const { profile, fetchedAt } = state.library;
  const avatar = profile.imageUrl
    ? h('img', { class: 'avatar', src: profile.imageUrl, alt: '' })
    : h('div', { class: 'avatar', 'aria-hidden': 'true' }, profile.displayName.slice(0, 1).toUpperCase());
  const s = result.stats;
  const stat = (value: number, label: string) => h('li', {}, h('strong', {}, value.toLocaleString()), label);

  const notes = [...state.notes];
  const mbDone = !state.mbRun.running && artistsToMatch(state.library.liked, state.musicBrainz).length === 0;
  if (!state.genreProgress && !state.mbRun.running && s.likedCount > 0 && s.tracksWithGenres === 0) {
    notes.push(
      mbDone
        ? 'Neither Spotify nor MusicBrainz had genres for your artists, so there are no genre playlists.'
        : 'Spotify returned no artist genres (the field is deprecated for new apps). Find more genres from MusicBrainz below to get genre playlists.',
    );
  }
  const keysMissing = state.library.liked.some((t) => !(t.id in state.keys));
  if (!state.keyRun.running && !keysMissing && s.likedCount > 0 && s.tracksWithKey === 0) {
    notes.push('No musical keys were available from ReccoBeats, so there are no key playlists.');
  }

  return h(
    'section',
    { class: 'hero' },
    h(
      'div',
      { class: 'profile' },
      avatar,
      h(
        'div',
        { class: 'who' },
        h('div', { class: 'eyebrow' }, 'Curating the Liked Songs of'),
        h('h1', {}, profile.displayName),
        h(
          'div',
          { class: 'muted small' },
          `Library fetched ${new Date(fetchedAt).toLocaleString()}`,
          profile.profileUrl && ' · ',
          profile.profileUrl && h('a', { href: profile.profileUrl, target: '_blank', rel: 'noopener' }, 'Spotify profile ↗'),
        ),
      ),
    ),
    h(
      'ul',
      { class: 'stats' },
      stat(s.likedCount, 'liked songs'),
      stat(s.withPlaySignal, 'with play signal'),
      stat(s.stackedAlbums, 'albums liked whole'),
      stat(s.tracksWithGenres, 'with genres'),
      stat(s.tracksWithKey, 'with musical key'),
    ),
    notes.length > 0 && h('ul', { class: 'notes' }, ...notes.map((n) => h('li', {}, n))),
  );
}

/** Links to every playlist created this session, so curating a different set never hides one. */
function createdList(): HTMLElement {
  const box = h('section', { class: 'created-list', 'aria-label': 'Created this session' });
  const refresh = () => {
    const all = createdStore.all();
    box.hidden = all.length === 0;
    box.replaceChildren(
      h('h2', {}, icon('check'), `Created in Spotify this session (${all.length})`),
      h(
        'ul',
        {},
        ...all.map((c) => h('li', {}, h('a', { href: c.playlist.url, target: '_blank', rel: 'noopener' }, `${c.name} ↗`), h('a', { class: 'muted small', href: c.playlist.uri }, 'Open in app'))),
      ),
    );
  };
  createdListRefresher = refresh;
  refresh();
  return box;
}

// ---------------------------------------------------------------------------
// Enrichment: the two opt-in lookups that send data to outside services.

function enrichSection(
  state: CuratorState,
  result: CurationResult,
  live: { spotifyGenres: HTMLElement; keyBar: HTMLProgressElement; keyText: HTMLElement; mbBar: HTMLProgressElement; mbText: HTMLElement },
  actions: Actions,
): HTMLElement {
  const liked = state.library.liked;
  const s = result.stats;

  // Musical keys (ReccoBeats)
  const keysKnown = liked.filter((t) => t.id in state.keys).length;
  const keysMissing = liked.length - keysKnown;
  const keyRun = state.keyRun;
  let keyState: HTMLElement;
  if (keyRun.running) {
    keyState = runningState(live.keyBar, live.keyText, keyRun);
  } else if (keysMissing === 0 && liked.length > 0) {
    keyState = doneState(`Keys found for ${s.tracksWithKey.toLocaleString()} of ${liked.length.toLocaleString()} songs.`);
  } else {
    const label = keysKnown > 0 ? `Find keys for ${keysMissing.toLocaleString()} more songs` : 'Find musical keys';
    keyState = h(
      'div',
      { class: 'enrich-state' },
      button(label, { class: 'primary' }, actions.findKeys),
      h('span', { class: 'muted small' }, keysKnown > 0 ? `${s.tracksWithKey.toLocaleString()} songs have a key so far.` : `${liked.length.toLocaleString()} songs to look up.`),
    );
  }

  // Genres (MusicBrainz)
  const mbRun = state.mbRun;
  const artistsLeft = artistsToMatch(liked, state.musicBrainz).length;
  const libraryArtists = new Set(liked.flatMap((t) => t.artists.map((a) => a.id)));
  const matches = [...libraryArtists].map((id) => state.musicBrainz[id]).filter((m): m is ArtistGenreMatch => !!m);
  const matched = matches.filter((m) => m.mbid).length;
  const withGenres = matches.filter((m) => m.genres.length > 0).length;
  let mbState: HTMLElement;
  if (mbRun.running) {
    mbState = runningState(live.mbBar, live.mbText, mbRun);
  } else if (artistsLeft === 0 && libraryArtists.size > 0) {
    mbState = doneState(
      `Matched ${matched.toLocaleString()} of ${libraryArtists.size.toLocaleString()} artists; ${withGenres.toLocaleString()} have genres.`,
    );
  } else {
    const label = matches.length > 0 ? `Continue: ${artistsLeft.toLocaleString()} artists left` : 'Find more genres';
    mbState = h(
      'div',
      { class: 'enrich-state' },
      button(label, { class: 'primary' }, actions.findGenres),
      h('span', { class: 'muted small' }, `${artistsLeft.toLocaleString()} artists, about ${duration(artistsLeft * MB_SECONDS_PER_ARTIST)}.`),
    );
  }

  return h(
    'section',
    { class: 'enrich', 'aria-labelledby': 'enrich-title' },
    h('h2', { id: 'enrich-title' }, 'Make the suggestions smarter'),
    h(
      'p',
      { class: 'muted' },
      'Spotify no longer gives new apps musical keys and has deprecated artist genres. These optional lookups fill the gaps from free outside services. ',
      'Nothing is sent to them until you click.',
    ),
    h(
      'div',
      { class: 'enrich-grid' },
      enrichCard({
        icon: 'note',
        title: 'Musical keys',
        service: 'ReccoBeats',
        what: 'Adds key playlists (with Camelot codes for harmonic mixing) and lets you sort and filter by key.',
        sends: 'Sends the Spotify track IDs of your liked songs to ReccoBeats (reccobeats.com), and nothing else.',
        state: keyState,
      }),
      enrichCard({
        icon: 'tag',
        title: 'More genres',
        service: 'MusicBrainz',
        what: 'Cross-references your artists on MusicBrainz, the open music encyclopedia, for genre playlists and genre filters. Matches by ISRC or exact name and skips anything ambiguous.',
        sends:
          'Sends artist names and the ISRC recording codes of liked songs to MusicBrainz (musicbrainz.org), one request a second as it asks. Results are kept in this browser until you sign out.',
        state: mbState,
        extra: live.spotifyGenres,
      }),
    ),
  );
}

function enrichCard(c: {
  icon: keyof typeof ICONS;
  title: string;
  service: string;
  what: string;
  sends: string;
  state: HTMLElement;
  extra?: HTMLElement;
}): HTMLElement {
  return h(
    'article',
    { class: 'enrich-card' },
    h(
      'div',
      { class: 'enrich-head' },
      h('span', { class: 'enrich-icon', 'aria-hidden': 'true' }, icon(c.icon)),
      h('div', {}, h('h3', {}, c.title), h('div', { class: 'muted small' }, `via ${c.service}`)),
    ),
    h('p', {}, c.what),
    h('p', { class: 'sends small' }, h('strong', {}, 'What is shared: '), c.sends),
    c.state,
    c.extra,
  );
}

function runningState(bar: HTMLProgressElement, text: HTMLElement, run: LookupRun): HTMLElement {
  const stop = button('Stop', { class: 'ghost small' }, () => run.stop?.());
  return h('div', { class: 'enrich-state running' }, h('div', { class: 'bar' }, bar), h('div', { class: 'bar-row' }, h('span', { class: 'muted small' }, text), stop));
}

function doneState(message: string): HTMLElement {
  return h('div', { class: 'enrich-state done' }, h('span', { class: 'done-badge' }, icon('check'), 'Done'), h('span', { class: 'small' }, message));
}

// ---------------------------------------------------------------------------
// Sort and filter

const KIND_LABEL: Record<PlaylistKind, string> = {
  favorites: 'Favorites',
  rediscover: 'Rediscover',
  'best-of-albums': 'Album thinning',
  artist: 'Artist',
  genre: 'Genre',
  key: 'Musical key',
  era: 'Decade',
};

const SORT_LABEL: Record<SortOrder, string> = {
  recommended: 'Recommended',
  type: 'Type',
  decade: 'Decade',
  genre: 'Genre (A–Z)',
  key: 'Key (Camelot)',
  artist: 'Artist (A–Z)',
  tracks: 'Most tracks',
};

const SIZE_OPTIONS = [25, 50, 100];

function browseBar(items: Browsable[], state: CuratorState, onChange: () => void): HTMLElement {
  const options = filterOptions(items);
  const c = state.criteria;
  // Drop filters whose value no longer matches any suggestion (e.g. after a different set).
  if (c.kind && !options.kinds.some((o) => o.id === c.kind)) c.kind = '';
  if (c.decade != null && !options.decades.some((o) => o.id === c.decade)) c.decade = null;
  if (c.genre && !options.genres.some((o) => o.id === c.genre)) c.genre = '';
  if (c.key && !options.keys.some((o) => o.id === c.key)) c.key = '';
  if (c.artist && !options.artists.some((o) => o.id === c.artist)) c.artist = '';

  const controls: HTMLSelectElement[] = [];
  const field = (label: string, select: HTMLSelectElement, hint?: string) =>
    h('label', { class: 'field' }, h('span', {}, label), select, hint && h('span', { class: 'hint' }, hint));
  const select = (
    name: string,
    choices: { value: string; label: string }[],
    value: string,
    set: (v: string) => void,
    anyLabel?: string,
  ): HTMLSelectElement => {
    const el = h('select', { name }) as HTMLSelectElement;
    if (anyLabel) el.append(new Option(anyLabel, ''));
    for (const o of choices) el.append(new Option(o.label, o.value));
    el.value = value;
    el.disabled = anyLabel !== undefined && choices.length === 0;
    el.addEventListener('change', () => {
      set(el.value);
      clear.hidden = !filtering();
      onChange();
    });
    controls.push(el);
    return el;
  };
  const n = (count: number) => ` (${count})`;
  const filtering = () => !!(c.kind || c.decade != null || c.genre || c.key || c.artist || c.minTracks);

  const clear = button('Clear filters', { class: 'ghost small' }, () => {
    Object.assign(c, { kind: '', decade: null, genre: '', key: '', artist: '', minTracks: 0 });
    for (const el of controls) if (el.name !== 'sort') el.value = '';
    clear.hidden = true;
    onChange();
  });
  clear.hidden = !filtering();

  return h(
    'div',
    { class: 'browse', role: 'group', 'aria-label': 'Sort and filter suggestions' },
    field(
      'Sort by',
      select(
        'sort',
        (Object.keys(SORT_LABEL) as SortOrder[]).map((s) => ({ value: s, label: SORT_LABEL[s] })),
        c.sort,
        (v) => (c.sort = v as SortOrder),
      ),
    ),
    field(
      'Type',
      select('kind', options.kinds.map((o) => ({ value: o.id, label: KIND_LABEL[o.id] + n(o.count) })), c.kind ?? '', (v) => (c.kind = v as PlaylistKind | ''), 'All types'),
    ),
    field(
      'Decade',
      select('decade', options.decades.map((o) => ({ value: String(o.id), label: `${o.id}s${n(o.count)}` })), c.decade == null ? '' : String(c.decade), (v) => (c.decade = v ? Number(v) : null), 'Any decade'),
    ),
    field(
      'Genre',
      select('genre', options.genres.map((o) => ({ value: o.id, label: o.id + n(o.count) })), c.genre ?? '', (v) => (c.genre = v), 'Any genre'),
      options.genres.length === 0 ? 'No genres yet' : undefined,
    ),
    field(
      'Key',
      select('key', options.keys.map((o) => ({ value: o.id, label: o.label + n(o.count) })), c.key ?? '', (v) => (c.key = v), 'Any key'),
      options.keys.length === 0 ? 'Find musical keys first' : undefined,
    ),
    field(
      'Artist',
      select('artist', options.artists.map((o) => ({ value: o.id, label: o.label + n(o.count) })), c.artist ?? '', (v) => (c.artist = v), 'Any artist'),
    ),
    field(
      'Size',
      select('size', SIZE_OPTIONS.map((s) => ({ value: String(s), label: `${s}+ tracks` })), c.minTracks ? String(c.minTracks) : '', (v) => (c.minTracks = Number(v) || 0), 'Any size'),
    ),
    clear,
  );
}

// ---------------------------------------------------------------------------
// Curate a different set

function recurateDialog(shown: CuratedPlaylist[], keptKeys: ReadonlySet<string>, onConfirm: (keep: Set<string>) => void) {
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'recurate-title' }) as HTMLDialogElement;
  const keep = new Set<string>();
  for (const p of shown) {
    // Kept and created suggestions start checked; the owner can still let them go.
    if (keptKeys.has(p.key) || createdStore.status(p.key, trackSignature(p)).kind === 'created') keep.add(p.key);
  }
  const summary = h('p', { class: 'muted small', role: 'status' });
  const boxes: HTMLInputElement[] = [];
  const update = () => {
    summary.textContent = `${keep.size} kept exactly as they are · ${shown.length - keep.size} replaced with new picks`;
  };
  const rows = shown.map((p) => {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = keep.has(p.key);
    box.addEventListener('change', () => {
      if (box.checked) keep.add(p.key);
      else keep.delete(p.key);
      update();
    });
    boxes.push(box);
    const created = createdStore.status(p.key, trackSignature(p)).kind === 'created';
    return h(
      'li',
      {},
      h(
        'label',
        {},
        box,
        h('span', { class: 'name' }, p.name),
        h('span', { class: 'muted small' }, `${KIND_LABEL[p.kind]} · ${p.tracks.length} tracks${created ? ' · created' : ''}${keptKeys.has(p.key) ? ' · kept' : ''}`),
      ),
    );
  });
  const setAll = (checked: boolean) => {
    boxes.forEach((b, i) => {
      b.checked = checked;
      if (checked) keep.add(shown[i].key);
      else keep.delete(shown[i].key);
    });
    update();
  };
  const close = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(
    h('h2', { id: 'recurate-title' }, 'Curate a different set?'),
    h(
      'p',
      {},
      'You will get new genre, key and artist picks where there are more to choose from, and a fresh selection and order of tracks. ',
      'Check the suggestions you want to keep; they carry over unchanged. Playlists already created in Spotify stay there and stay linked at the top of the page.',
    ),
    h('div', { class: 'dialog-tools' }, button('Keep all', { class: 'ghost small' }, () => setAll(true)), button('Keep none', { class: 'ghost small' }, () => setAll(false))),
    h('ul', { class: 'keep-list' }, ...rows),
    summary,
    h(
      'div',
      { class: 'dialog-actions' },
      button('Cancel', { class: 'ghost' }, close),
      button([icon('shuffle'), 'Curate new set'], { class: 'primary' }, () => {
        close();
        onConfirm(new Set(keep));
      }),
    ),
  );
  update();
  document.body.append(dialog);
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// Playlist cards

function playlistCard(
  client: SpotifyClient,
  p: CuratedPlaylist,
  facets: Browsable['facets'],
  open: boolean,
  kept: boolean,
): HTMLElement {
  const minutes = Math.round(p.tracks.reduce((sum, t) => sum + t.durationMs, 0) / 60_000);
  const length = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  const rest = p.tracks.slice(PREVIEW_COUNT);
  const details = rest.length > 0 ? (h('details', { 'data-key': p.key }) as HTMLDetailsElement) : null;
  if (details) {
    details.open = open;
    details.append(h('summary', {}, `Show all ${p.tracks.length} tracks`), trackList(rest));
  }

  const chips = [
    ...(facets.decade != null ? [`${facets.decade}s`] : []),
    ...facets.genres.slice(0, 3),
    ...facets.keys.slice(0, 1).map((k) => k.label),
  ];

  return h(
    'article',
    { class: `card kind-${p.kind}` },
    h(
      'div',
      { class: 'card-head' },
      cover(p),
      h(
        'div',
        { class: 'card-title' },
        h('div', { class: 'badges' }, h('span', { class: 'badge' }, KIND_LABEL[p.kind]), kept && h('span', { class: 'badge kept' }, 'Kept')),
        h('h3', {}, p.name),
        h('div', { class: 'meta' }, `${p.tracks.length} tracks · ${length}`),
      ),
    ),
    h(
      'div',
      { class: 'card-body' },
      h('p', { class: 'reason' }, p.reason),
      chips.length > 0 && h('ul', { class: 'chips', 'aria-label': 'Describes' }, ...chips.map((c) => h('li', {}, c))),
      trackList(p.tracks.slice(0, PREVIEW_COUNT)),
      details,
      createControls(client, p),
    ),
  );
}

/** Album-art mosaic: four different covers when there are four, else the first cover. */
function cover(p: CuratedPlaylist): HTMLElement {
  const urls = [...new Set(p.tracks.map((t) => t.album.coverUrl ?? t.album.imageUrl).filter((u): u is string => !!u))];
  const art = urls.length >= 4 ? urls.slice(0, 4) : urls.slice(0, 1);
  return h(
    'div',
    { class: `cover${art.length === 4 ? ' mosaic' : ''}`, 'aria-hidden': 'true' },
    ...(art.length > 0 ? art.map((src) => h('img', { src, alt: '', loading: 'lazy' })) : [h('div', { class: 'cover-empty' }, icon('note'))]),
  );
}

function trackList(tracks: LikedTrack[]): HTMLElement {
  return h(
    'ol',
    { class: 'tracks' },
    ...tracks.map((t) =>
      h(
        'li',
        {},
        t.album.imageUrl
          ? h('img', { src: t.album.imageUrl, alt: '', loading: 'lazy' })
          : h('div', { class: 'noart' }),
        h(
          'div',
          { class: 't' },
          h('div', { title: t.name }, t.name),
          h(
            'div',
            { class: 'sub' },
            `${t.artists.map((a) => a.name).join(', ')} · ${t.album.name}${t.album.releaseDate ? ` (${t.album.releaseDate.slice(0, 4)})` : ''}`,
          ),
        ),
      ),
    ),
  );
}

function createControls(client: SpotifyClient, p: CuratedPlaylist): HTMLElement {
  const box = h('div', { class: 'create' });
  const signature = trackSignature(p);
  const refresh = () => box.replaceChildren(...createControlsContent(client, p, signature));
  createControlRefreshers.set(p.key, refresh);
  refresh();
  return box;
}

function createControlsContent(client: SpotifyClient, p: CuratedPlaylist, signature: string): HTMLElement[] {
  const status = createdStore.status(p.key, signature);
  if (status.kind === 'created') return openLinks(status.playlist);

  const create = button('Create in Spotify', { class: 'primary' }, () => {
    create.disabled = true;
    void createdStore.create(
      p.key,
      signature,
      (onProgress) =>
        client.createPlaylist(p.name, playlistDescription(p), p.tracks.map((t) => t.uri), (added, total) =>
          onProgress(`Adding tracks… ${added} / ${total}`),
        ),
      p.name,
    );
  });
  if (status.kind === 'creating') {
    create.disabled = true;
    return [create, h('span', { class: 'status' }, status.progress)];
  }
  return [
    create,
    status.error
      ? h('span', { class: 'status error' }, `Could not create the playlist: ${status.error}`)
      : h('span', { class: 'status' }),
  ];
}

function openLinks(playlist: CreatedPlaylist): HTMLElement[] {
  return [
    h('a', { class: 'button primary', href: playlist.url, target: '_blank', rel: 'noopener' }, 'Open in Spotify ↗'),
    h('a', { class: 'button ghost', href: playlist.uri }, 'Open in app'),
    h('span', { class: 'status' }, 'Created as a private playlist.'),
  ];
}

function playlistDescription(p: CuratedPlaylist): string {
  const text = `${p.reason} Curated from Liked Songs.`.replace(/\s+/g, ' ');
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 1)}…`;
}

void start();
