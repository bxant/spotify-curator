import './style.css';
import { AuthError, SpotifyAuth } from './auth';
import { browse, filterOptions, playlistFacets, type BrowseCriteria, type Browsable, type SortOrder } from './browse';
import {
  BUILD_LIMITS,
  BUILT_KEY,
  buildChoices,
  buildPlaylist,
  clampCount,
  criteriaId,
  emptyCriteria,
  matchingTracks,
  normalizeCriteria,
  type BuildChoices,
  type BuildCriteria,
} from './builder';
import { REDIRECT_URI, configuredClientId } from './config';
import {
  camelot,
  curate,
  keepSelected,
  keyName,
  mergeGenres,
  playScores,
  releaseYear,
  trackGenres,
  trackSignature,
  withKept,
  type CurationResult,
} from './curate';
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
import { mapWithConcurrency } from './http';
import { ReccoBeatsClient } from './reccobeats';
import { homeHref, parseRoute, playlistHref, type Route } from './route';
import { SessionCache, browserCache } from './session-cache';
import { CreatedStore } from './created-store';
import { RemovedStore } from './removed-store';
import { APP_TAG, matchSaved, playlistDescription, setAsideSaved, type SavedMatch } from './saved';
import { SpotifyClient, type CreatedPlaylist } from './spotify';
import type { CuratedPlaylist, LikedTrack, PlaylistKind, SavedPlaylist, SavedTracks, TrackKey } from './types';

const app = document.getElementById('app') as HTMLElement;
const cache = new SessionCache();
/** MusicBrainz matches outlive the tab: they are public data and slow to look up again. */
const lookupCache = browserCache();
/** One client for every lookup, so its throttle (and any 503 slowdown) carries across runs. */
const musicBrainz = new MusicBrainzClient();
/** Redraws the create controls of the card currently on the page for a playlist key. */
const createControlRefreshers = new Map<string, () => void>();
const createdStore = new CreatedStore(cache, (key) => {
  createControlRefreshers.get(key)?.();
  createdListRefresher?.();
});
let createdListRefresher: (() => void) | undefined;
/** Tracks the owner removed from recommendations; every view and Create use the edited lists. */
const removedStore = new RemovedStore(cache);

const PREVIEW_COUNT = 5;
/** Saved playlists whose tracks are read at once when checking suggestions against them. */
const SAVED_TRACKS_CONCURRENCY = 3;
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
  activeView = undefined;
  return ++generation;
}

// ---------------------------------------------------------------------------
// Routing: the recommendations (#/, with sort and filters in the query) and one
// page per playlist (#/playlist/<key>). See src/route.ts.

let route: Route = parseRoute(location.hash);
/** Scroll position of the recommendations when a playlist was opened, for the return trip. */
let homeScrollY = 0;
/** The playlist whose page was open last, so its card gets focus on the way back. */
let lastPlaylistKey: string | undefined;
/** The signed-in page, which redraws itself for the current route. */
let activeView: { navigate: (from: Route) => void } | undefined;

window.addEventListener('hashchange', () => {
  const from = route;
  route = parseRoute(location.hash);
  // Marks a playlist page opened from the recommendations, so Back can step back to them
  // (with their sort, filters and scroll) even after a reload.
  if (route.name === 'playlist') mergeHistoryState({ fromHome: from.name === 'home' });
  activeView?.navigate(from);
});

interface EntryState {
  /** Scroll position of the recommendations when a playlist was opened from them. */
  scrollY?: number;
  /** This playlist page was opened from the recommendations entry right before it. */
  fromHome?: boolean;
}

function historyState(): EntryState {
  const state: unknown = history.state;
  return state && typeof state === 'object' ? (state as EntryState) : {};
}

function mergeHistoryState(patch: EntryState) {
  try {
    history.replaceState({ ...historyState(), ...patch }, '');
  } catch {
    // Not remembered across reloads; the page still works for this visit.
  }
}

/** Remembers where the recommendations were scrolled to, in this history entry too so it survives a reload. */
function rememberHomeScroll() {
  homeScrollY = window.scrollY;
  mergeHistoryState({ scrollY: homeScrollY });
}

function savedHomeScroll(): number {
  return historyState().scrollY ?? homeScrollY;
}

/** Back to the recommendations: a real history step when they are the previous page, else a new one. */
function backToRecommendations(criteria: BrowseCriteria) {
  if (historyState().fromHome) history.back();
  else location.hash = homeHref(criteria);
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
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2Z',
  filter: 'M10 18h4v-2h-4v2ZM3 6v2h18V6H3Zm3 7h12v-2H6v2Z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z',
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
  // The page restores the recommendations' scroll itself once they are drawn again.
  history.scrollRestoration = 'manual';
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
        'Read-only access to your library, top items, recent plays and playlists, plus permission to create private playlists. ' +
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
  saved: SavedState;
  /** Also list the suggestions already saved in Spotify (hidden by default). */
  showSaved: boolean;
  build: BuildState;
}

/** The "Build your own" choices and the latest playlist built from them, kept for the tab's session. */
interface BuildState {
  /** The choices in the form, built or not. */
  criteria: BuildCriteria;
  built?: BuiltState;
  /** The last Build found no matching songs. */
  noMatch?: boolean;
}

interface BuiltState {
  criteria: BuildCriteria;
  playlist: CuratedPlaylist;
  matched: number;
  requested: number;
  /** Seed of this try; every Build or Try again uses the next one. */
  seed: number;
  /** Track IDs of every try with these choices so far, oldest first; the last is this one. */
  rolls: string[][];
}

/** The user's own playlists, read on every load so suggestions saved before are recognized. */
interface SavedState {
  /** Only `ready` recognizes earlier sessions' playlists; the others still recognize this session's. */
  status: 'ready' | 'needs-consent' | 'error';
  playlists: SavedPlaylist[];
  /** Tracks of the few playlists that only their tracks can match or rule out. */
  tracks: Record<string, SavedTracks>;
  error?: string;
}

const DEFAULT_CRITERIA: BrowseCriteria = { sort: 'recommended' };
/** Session cache key for the current set and kept suggestions, so a reload shows the same playlists. */
const SET_KEY = 'set';
/** Session cache key for the "Build your own" choices and the latest built playlist. */
const BUILD_KEY = 'build';
/** Earlier tries remembered per choices, so Try again keeps moving to songs not picked yet. */
const MAX_ROLLS = 20;

interface SavedSet {
  variant: number;
  kept: CuratedPlaylist[];
}

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
  status.textContent = 'Checking which suggestions are already in your Spotify…';
  const saved = await loadSavedPlaylists(auth, client, library.profile.id);
  if (current !== generation) return;
  // Refresh data goes back to the default set.
  if (forceReload) cache.set(SET_KEY, null);
  const set = cache.get<SavedSet>(SET_KEY);
  const state: CuratorState = {
    library,
    genres: cache.get<Record<string, string[]>>('genres') ?? {},
    keys: cache.get<Record<string, TrackKey | null>>('keys') ?? {},
    musicBrainz: cachedMusicBrainz(lookupCache),
    notes: [],
    genreProgress: '',
    keyRun: { running: false, done: 0, total: 0 },
    mbRun: { running: false, done: 0, total: 0 },
    variant: set?.variant ?? 0,
    kept: set?.kept ?? [],
    criteria: route.name === 'home' ? { ...route.criteria } : { ...DEFAULT_CRITERIA },
    saved,
    showSaved: false,
    build: cache.get<BuildState>(BUILD_KEY) ?? { criteria: emptyCriteria() },
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
      musicBrainz,
      library.liked,
      lookupCache,
      (progress, data) => {
        Object.assign(run, progress);
        state.musicBrainz = data;
        // New genres change the suggestions; refresh them in place as each batch lands.
        view.update();
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
  activeView = view;
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

/** Reads the user's own playlists; never changes them. Failing here only disables the check. */
async function loadSavedPlaylists(auth: SpotifyAuth, client: SpotifyClient, userId: string): Promise<SavedState> {
  // Sessions signed in before the app asked for playlist-read-private must consent again.
  if (!auth.hasAllScopes()) return { status: 'needs-consent', playlists: [], tracks: {} };
  try {
    return { status: 'ready', playlists: await client.getOwnPlaylists(userId), tracks: {} };
  } catch (err) {
    return { status: 'error', playlists: [], tracks: {}, error: errorText(err) };
  }
}

/** Playlists created in this session count as saved too, for suggestions other than their own card. */
function savedPlaylists(state: CuratorState): SavedPlaylist[] {
  const known = new Set(state.saved.playlists.map((p) => p.id));
  const created = createdStore
    .all()
    .filter((c) => !known.has(c.playlist.id))
    .map((c) => ({ id: c.playlist.id, name: c.name, description: APP_TAG, uri: c.playlist.uri, url: c.playlist.url }));
  return [...state.saved.playlists, ...created];
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

  const curateNow = () => {
    const mbGenres = musicBrainzGenres(state.musicBrainz);
    const options = {
      now: new Date(),
      artistGenres: state.genres,
      musicBrainzGenres: mbGenres,
      trackKeys: state.keys,
      variant: state.variant,
    };
    let result = curate(state.library.liked, state.library.history, options);
    const savedList = savedPlaylists(state);
    const needTracks = new Set<string>();
    // Saved suggestions are set aside and the next candidates fill in; a card created
    // from this page keeps showing its own Open links instead. Matching and Create both
    // see the tracks as shown, without the ones the owner removed.
    const { fresh, saved } = setAsideSaved(
      (exclude) => {
        if (exclude.size > 0) result = curate(state.library.liked, state.library.history, { ...options, exclude });
        return withKept(state.kept, result.playlists);
      },
      (playlists, matched) => {
        const check = matchSaved(
          playlists.filter((p) => !createdStore.hasRecord(p.key)).map((p) => removedStore.apply(p)),
          savedList.filter((s) => !matched.has(s.id)),
          state.saved.tracks,
        );
        for (const id of check.needTracks) needTracks.add(id);
        return check.matches;
      },
    );
    /** As curated (kept suggestions carry these, so a removal can still be undone after a new set). */
    const curated = [...fresh, ...saved.map((s) => s.playlist)];
    /** As shown and created: without the tracks the owner removed. */
    const shown = fresh.map((p) => removedStore.apply(p));
    const artistGenres = mergeGenres(state.genres, mbGenres);
    const facetInputs = { artistGenres, trackKeys: state.keys };
    const browsable = (playlist: CuratedPlaylist): Browsable => ({ playlist, facets: playlistFacets(playlist, facetInputs) });
    return {
      result,
      curated,
      shown,
      freshItems: shown.map(browsable),
      savedItems: saved.map((s) => browsable(removedStore.apply(s.playlist))),
      savedMatches: new Map(saved.map((s) => [s.playlist.key, s.match])),
      needTracks,
      artistGenres,
      keptKeys: new Set(state.kept.map((p) => p.key)),
    };
  };
  type Curated = ReturnType<typeof curateNow>;

  /** Refreshes the suggestions of the current page in place; set by each full render. */
  let refresh = () => {};
  /** Saved playlists whose tracks are being fetched. */
  const tracksInFlight = new Set<string>();

  /** Fetches the tracks some matches depend on, then refreshes the suggestions once. */
  const fetchNeededTracks = (cur: Curated) => {
    const ids = [...cur.needTracks].filter((id) => !(id in state.saved.tracks) && !tracksInFlight.has(id));
    if (ids.length === 0) return;
    for (const id of ids) tracksInFlight.add(id);
    void mapWithConcurrency(ids, SAVED_TRACKS_CONCURRENCY, (id) =>
      client.getPlaylistTracks(id).then(
        (tracks) => (state.saved.tracks[id] = tracks),
        // Unreadable: treat as sharing no tracks rather than asking again.
        () => (state.saved.tracks[id] = { ids: [], keys: [] }),
      ),
    ).then(() => {
      for (const id of ids) tracksInFlight.delete(id);
      update();
    });
  };

  const scores = playScores(state.library.liked, state.library.history);
  const buildInputs = () => ({
    artistGenres: mergeGenres(state.genres, musicBrainzGenres(state.musicBrainz)),
    trackKeys: state.keys,
    scores,
  });
  const saveBuild = () => cache.set(BUILD_KEY, state.build);

  /**
   * Builds a playlist from the choices; with the same choices as the latest one, it is a
   * retry that prefers songs no earlier try picked. Returns false when nothing matches.
   */
  const build = (choices: BuildCriteria): boolean => {
    const criteria = normalizeCriteria(choices);
    const prior = state.build.built;
    const again = prior && criteriaId(prior.criteria) === criteriaId(criteria) ? prior : undefined;
    const seed = (prior?.seed ?? 0) + 1;
    const result = buildPlaylist(state.library.liked, criteria, buildInputs(), { seed, previous: again?.rolls ?? [] });
    state.build.noMatch = !result;
    if (result) {
      const rolls = [...(again?.rolls ?? []), result.playlist.tracks.map((t) => t.id)].slice(-MAX_ROLLS);
      state.build.built = { criteria, playlist: result.playlist, matched: result.matched, requested: result.requested, seed, rolls };
      // Removals belonged to the previous selection.
      removedStore.restoreAll(BUILT_KEY);
    }
    saveBuild();
    return !!result;
  };

  /** Keeps the address bar in step with the sort and filters, without adding history entries. */
  const syncHomeUrl = () => {
    if (route.name !== 'home') return;
    const href = homeHref(state.criteria);
    if (location.hash !== href && !(location.hash === '' && href === '#/')) history.replaceState(history.state, '', href);
    route = { name: 'home', criteria: { ...state.criteria } };
  };

  const renderHome = () => {
    let cur = curateNow();
    const items = () => (state.showSaved ? [...cur.freshItems, ...cur.savedItems] : cur.freshItems);

    const grid = h('div', { class: 'grid' });
    const count = h('p', { class: 'recs-count', role: 'status' });
    const savedLine = h('p', { class: 'muted small saved-line' });
    const renderGrid = () => {
      const { keptKeys, savedMatches } = cur;
      const all = items();
      const visible = browse(all, state.criteria);
      count.textContent =
        visible.length === all.length ? `All ${all.length} playlists` : `${visible.length} of ${all.length} playlists`;
      renderSavedLine();
      grid.replaceChildren(
        ...(visible.length > 0
          ? visible.map(({ playlist, facets }) => playlistCard(client, playlist, facets, keptKeys.has(playlist.key), savedMatches.get(playlist.key)))
          : all.length === 0
            ? [
                h(
                  'p',
                  { class: 'muted empty' },
                  cur.savedItems.length > 0
                    ? 'Every recommendation is already in your Spotify.'
                    : 'Not enough liked songs or listening history to suggest playlists yet.',
                ),
              ]
            : [h('div', { class: 'muted empty' }, h('p', {}, 'None of your recommendations match these filters.'), button('Clear filters', { class: 'ghost small' }, bar.clear))]),
      );
    };
    const onCriteria = () => {
      syncHomeUrl();
      renderGrid();
    };

    let heroEl = hero(state, cur.result);
    const bar = browseBar(state, onCriteria);
    bar.setItems(items());
    syncHomeUrl();

    /** How many recommendations are already saved, with a toggle to list them; or why that is unknown. */
    const renderSavedLine = () => {
      const n = cur.savedItems.length;
      const parts: Child[] = [];
      if (n > 0) {
        parts.push(
          `${n} ${n === 1 ? 'recommendation is' : 'recommendations are'} already in your Spotify${state.showSaved ? ' and marked below' : ' and hidden'}. `,
          button(state.showSaved ? 'Hide them' : 'Show them', { class: 'link-button', 'aria-pressed': String(state.showSaved) }, () => {
            state.showSaved = !state.showSaved;
            bar.setItems(items());
            renderGrid();
          }),
        );
      }
      if (state.saved.status === 'needs-consent') {
        parts.push(
          'To recognize playlists you saved in earlier sessions, Spotify needs to let this page read your playlists. ',
          button('Reconnect Spotify', { class: 'link-button' }, async () => location.assign(await auth.authorizeUrl())),
        );
      } else if (state.saved.status === 'error') {
        parts.push(`Could not read your playlists (${state.saved.error}), so recommendations saved in earlier sessions may show again.`);
      }
      savedLine.replaceChildren(...parts.filter((c): c is Node | string => !!c));
      savedLine.hidden = parts.length === 0;
    };

    renderProgress();
    const builder = builderPanel(state, buildChoices(state.library.liked, buildInputs()), {
      count: (c) => matchingTracks(state.library.liked, c, buildInputs()).length,
      save: saveBuild,
      build: () => {
        if (build(state.build.criteria)) {
          rememberHomeScroll();
          location.hash = playlistHref(BUILT_KEY);
        } else {
          render();
          app.querySelector<HTMLElement>('#builder-build')?.focus();
        }
      },
    });
    const recurate =
      cur.shown.length > 0 &&
      button([icon('shuffle'), 'Curate a different set'], { class: 'secondary' }, () => {
        const { curated, shown, keptKeys } = cur;
        recurateDialog(shown, keptKeys, (keep) => {
          state.kept = keepSelected(curated, keep);
          state.variant++;
          cache.set(SET_KEY, { variant: state.variant, kept: state.kept } satisfies SavedSet);
          render();
        });
      });
    show(
      topBar(auth),
      heroEl,
      createdList(),
      curationSection(state, cur.result, live, actions, recurate, builder.el),
      h(
        'section',
        { class: 'recs', 'aria-labelledby': 'recs-title' },
        h(
          'div',
          { class: 'recs-head' },
          h(
            'h2',
            { id: 'recs-title' },
            'Your recommendations',
            state.variant > 0 && h('span', { class: 'set-label' }, `Set ${state.variant + 1}`),
          ),
          count,
          savedLine,
        ),
        bar.el,
        grid,
      ),
    );
    renderGrid();
    fetchNeededTracks(cur);

    refresh = () => {
      cur = curateNow();
      builder.setChoices(buildChoices(state.library.liked, buildInputs()));
      const next = hero(state, cur.result);
      heroEl.replaceWith(next);
      heroEl = next;
      bar.setItems(items());
      syncHomeUrl();
      // Leave the cards alone while one has focus; the next refresh or render catches up.
      if (!grid.contains(document.activeElement)) renderGrid();
      else renderSavedLine();
      fetchNeededTracks(cur);
    };
  };

  const renderPlaylist = (key: string) => {
    const isBuilt = key === BUILT_KEY;
    const find = () => {
      const cur = curateNow();
      const built = isBuilt ? state.build.built : undefined;
      // Saved recommendations keep their page even while hidden from the grid.
      const builtPlaylist = built && removedStore.apply(built.playlist);
      const item = isBuilt
        ? builtPlaylist && { playlist: builtPlaylist, facets: playlistFacets(builtPlaylist, { artistGenres: cur.artistGenres, trackKeys: state.keys }) }
        : [...cur.freshItems, ...cur.savedItems].find((i) => i.playlist.key === key);
      const saved = cur.savedMatches.get(key);
      fetchNeededTracks(cur);
      return { cur, item, saved, signature: item ? `${trackSignature(item.playlist)}|${saved?.playlist.id ?? ''}` : '' };
    };
    let shown = find();
    const back = () => backToRecommendations(state.criteria);
    const edit = (change: () => void, focus: () => HTMLElement | null | undefined) => {
      change();
      shown = find();
      draw();
      (focus() ?? app.querySelector<HTMLElement>('.playlist-page h1'))?.focus();
    };
    const removeButton = (id: string) => app.querySelector<HTMLElement>(`button[data-remove="${CSS.escape(id)}"]`);
    const editing: TrackEditing = {
      remove: (t) => {
        // Focus moves to the track that takes its place, so several can be removed in a row.
        const tracks = shown.item?.playlist.tracks ?? [];
        const i = tracks.findIndex((x) => x.id === t.id);
        const neighbour = tracks[i + 1] ?? tracks[i - 1];
        edit(
          () => removedStore.remove(key, t.id),
          () => (neighbour ? removeButton(neighbour.id) : app.querySelector<HTMLElement>('.removed-tracks li button')),
        );
      },
      restore: (t) =>
        edit(
          () => removedStore.restore(key, t.id),
          () => removeButton(t.id),
        ),
      restoreAll: () =>
        edit(
          () => removedStore.restoreAll(key),
          () => null,
        ),
    };
    const draw = () => {
      const { cur, item, saved } = shown;
      const original = isBuilt ? state.build.built?.playlist : cur.curated.find((p) => p.key === key);
      const byId = new Map(original?.tracks.map((t) => [t.id, t]));
      const removed = removedStore
        .removed(key)
        .map((id) => byId.get(id))
        .filter((t): t is LikedTrack => !!t);
      show(
        topBar(auth),
        item
          ? playlistPage(
              client,
              item,
              { artistGenres: cur.artistGenres, trackKeys: state.keys, kept: cur.keptKeys.has(key), saved },
              { removed, ...editing },
              back,
              isBuilt && state.build.built && builtControls(state.build.built, retry),
            )
          : missingPlaylistPage(state, back, isBuilt),
      );
    };
    const retry = () => {
      const built = state.build.built;
      if (!built) return;
      build(built.criteria);
      shown = find();
      draw();
      app.querySelector<HTMLElement>('#builder-retry')?.focus();
    };
    draw();
    lastPlaylistKey = key;

    refresh = () => {
      const next = find();
      const changed = next.signature !== shown.signature;
      shown = next;
      // Redraw only when the tracks or saved match changed (e.g. genres landed), and not under a focused control.
      if (changed && !document.activeElement?.matches('#app :is(a, button)')) draw();
    };
  };

  const render = () => {
    if (!isCurrent()) return;
    if (route.name === 'playlist') renderPlaylist(route.key);
    else renderHome();
  };

  /** Mid-lookup redraw: progress and suggestions only, so open selects and focus survive. */
  const update = () => {
    if (!isCurrent()) return;
    renderProgress();
    refresh();
  };

  /** Draws the page for a new route, restoring the recommendations as the owner left them. */
  const navigate = (from: Route) => {
    if (!isCurrent()) return;
    if (route.name === 'home') {
      state.criteria = { ...route.criteria };
      render();
      // Only the query changed (typed or pasted): stay where the page is.
      if (from.name === 'home') return;
      window.scrollTo(0, savedHomeScroll());
      // A built playlist has no card; its way back lands on the builder.
      const card =
        lastPlaylistKey === BUILT_KEY
          ? app.querySelector<HTMLElement>('#builder-build')
          : lastPlaylistKey && app.querySelector<HTMLAnchorElement>(`a.card-link[href="${CSS.escape(playlistHref(lastPlaylistKey))}"]`);
      if (card) card.focus({ preventScroll: true });
      return;
    }
    render();
    window.scrollTo(0, 0);
    app.querySelector<HTMLElement>('.playlist-page h1')?.focus({ preventScroll: true });
  };

  return { render, renderProgress, update, navigate };
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
// Curation: what changes the recommendations themselves — a different set, and
// the two opt-in lookups that send data to outside services.

function curationSection(
  state: CuratorState,
  result: CurationResult,
  live: { spotifyGenres: HTMLElement; keyBar: HTMLProgressElement; keyText: HTMLElement; mbBar: HTMLProgressElement; mbText: HTMLElement },
  actions: Actions,
  recurate: HTMLElement | false,
  builder: HTMLElement,
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
    { class: 'curation', 'aria-labelledby': 'curation-title' },
    h(
      'div',
      { class: 'section-head' },
      h(
        'div',
        {},
        h('div', { class: 'eyebrow muted' }, 'Curation'),
        h('h2', { id: 'curation-title' }, 'Change what gets recommended'),
        h(
          'p',
          { class: 'muted' },
          'Playlists are picked from your Liked Songs and listening history. Curate a different set for new picks, build your own from the genres, decades, keys and artists you choose, or add musical keys and genres for more kinds of playlists.',
        ),
      ),
      recurate,
    ),
    builder,
    h('h3', { class: 'enrich-title' }, 'Make the suggestions smarter'),
    h(
      'p',
      { class: 'muted enrich-intro' },
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
      h('div', {}, h('h4', {}, c.title), h('div', { class: 'muted small' }, `via ${c.service}`)),
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
  custom: 'Your mix',
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

/** Sort and filter toolbar of the recommendations grid: it narrows what is shown and never curates. */
function browseBar(state: CuratorState, onChange: () => void): { el: HTMLElement; setItems: (items: Browsable[]) => void; clear: () => void } {
  const c = state.criteria;
  let options = filterOptions([]);

  const fills: (() => void)[] = [];
  const field = (label: string, select: HTMLSelectElement, hint?: () => string | undefined) => {
    const hintEl = h('span', { class: 'hint' });
    if (hint) fills.push(() => {
      hintEl.textContent = hint() ?? '';
      hintEl.hidden = !hintEl.textContent;
    });
    return h('label', { class: 'field' }, h('span', {}, label), select, hint && hintEl);
  };
  const controls: HTMLSelectElement[] = [];
  const select = (
    name: string,
    choices: () => { value: string; label: string }[],
    value: () => string,
    set: (v: string) => void,
    anyLabel?: string,
  ): HTMLSelectElement => {
    const el = h('select', { name }) as HTMLSelectElement;
    const fill = () => {
      // Rebuilding the options of the focused select would close it mid-choice, unless its value was dropped.
      if (el === document.activeElement && el.value === value()) return;
      const list = choices();
      el.replaceChildren(...(anyLabel ? [new Option(anyLabel, '')] : []), ...list.map((o) => new Option(o.label, o.value)));
      el.value = value();
      el.disabled = anyLabel !== undefined && list.length === 0;
    };
    fills.push(fill);
    el.addEventListener('blur', fill);
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

  const clearFilters = () => {
    Object.assign(c, { kind: '', decade: null, genre: '', key: '', artist: '', minTracks: 0 });
    for (const el of controls) if (el.name !== 'sort') el.value = '';
    clear.hidden = true;
    onChange();
  };
  const clear = button('Clear filters', { class: 'ghost small' }, clearFilters);

  const el = h(
    'div',
    { class: 'browse', role: 'group', 'aria-labelledby': 'browse-title', 'aria-describedby': 'browse-note' },
    h(
      'div',
      { class: 'browse-label' },
      h('span', { class: 'browse-title', id: 'browse-title' }, icon('filter'), 'Sort & filter these playlists'),
      h('span', { class: 'muted small', id: 'browse-note' }, 'Only changes which recommendations are shown here. It doesn’t create new playlists.'),
      clear,
    ),
    h('div', { class: 'browse-fields' }, field(
      'Sort by',
      select(
        'sort',
        () => (Object.keys(SORT_LABEL) as SortOrder[]).map((s) => ({ value: s, label: SORT_LABEL[s] })),
        () => c.sort,
        (v) => (c.sort = v as SortOrder),
      ),
    ),
    field(
      'Type',
      select('kind', () => options.kinds.map((o) => ({ value: o.id, label: KIND_LABEL[o.id] + n(o.count) })), () => c.kind ?? '', (v) => (c.kind = v as PlaylistKind | ''), 'All types'),
    ),
    field(
      'Decade',
      select('decade', () => options.decades.map((o) => ({ value: String(o.id), label: `${o.id}s${n(o.count)}` })), () => (c.decade == null ? '' : String(c.decade)), (v) => (c.decade = v ? Number(v) : null), 'Any decade'),
    ),
    field(
      'Genre',
      select('genre', () => options.genres.map((o) => ({ value: o.id, label: o.id + n(o.count) })), () => c.genre ?? '', (v) => (c.genre = v), 'Any genre'),
      () => (options.genres.length === 0 ? 'No genres yet' : undefined),
    ),
    field(
      'Key',
      select('key', () => options.keys.map((o) => ({ value: o.id, label: o.label + n(o.count) })), () => c.key ?? '', (v) => (c.key = v), 'Any key'),
      () => (options.keys.length === 0 ? 'Find musical keys first' : undefined),
    ),
    field(
      'Artist',
      select('artist', () => options.artists.map((o) => ({ value: o.id, label: o.label + n(o.count) })), () => c.artist ?? '', (v) => (c.artist = v), 'Any artist'),
    ),
    field(
      'Size',
      select('size', () => SIZE_OPTIONS.map((s) => ({ value: String(s), label: `${s}+ tracks` })), () => (c.minTracks ? String(c.minTracks) : ''), (v) => (c.minTracks = Number(v) || 0), 'Any size'),
    )),
  );

  const setItems = (items: Browsable[]) => {
    options = filterOptions(items);
    // Drop filters whose value no longer matches any suggestion (e.g. after a different set).
    if (c.kind && !options.kinds.some((o) => o.id === c.kind)) c.kind = '';
    if (c.decade != null && !options.decades.some((o) => o.id === c.decade)) c.decade = null;
    if (c.genre && !options.genres.some((o) => o.id === c.genre)) c.genre = '';
    if (c.key && !options.keys.some((o) => o.id === c.key)) c.key = '';
    if (c.artist && !options.artists.some((o) => o.id === c.artist)) c.artist = '';
    for (const fill of fills) fill();
    clear.hidden = !filtering();
  };
  return { el, setItems, clear: clearFilters };
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
// Build your own: a new playlist from the owner's choices (see src/builder.ts).
// It sits with the curation actions; the recommendations' filters only narrow what is shown.

/** Pickers left open, so a redraw (e.g. when genres finish loading) keeps them open. */
const openPickers = new Set<string>();
/** Most unchosen options a picker lists at once; typing in its search narrows the rest. */
const PICKER_LIMIT = 100;

interface PickerOption {
  value: string;
  label: string;
  count: number;
}

function builderPanel(
  state: CuratorState,
  initial: BuildChoices,
  on: { count: (c: BuildCriteria) => number; save: () => void; build: () => void },
): { el: HTMLElement; setChoices: (choices: BuildChoices) => void } {
  const c = state.build.criteria;
  let choices = initial;
  const status = h('p', { class: 'builder-status small', role: 'status' });
  const build = button('Build playlist', { class: 'primary', id: 'builder-build' }, on.build);
  const fills: (() => void)[] = [];

  const updateStatus = () => {
    const n = on.count(c);
    const songs = `${n.toLocaleString()} liked ${n === 1 ? 'song matches' : 'songs match'}`;
    build.disabled = n === 0;
    status.classList.toggle('error', n === 0 || !!state.build.noMatch);
    status.textContent =
      n === 0
        ? 'No liked songs match all of these choices. Choose more values, or fewer kinds of choices.'
        : n < c.count
          ? `${songs}, fewer than the ${c.count} you asked for, so all of them will be in.`
          : `${songs}; ${c.count} will be picked at random, spread across artists.`;
  };
  const changed = () => {
    state.build.noMatch = false;
    on.save();
    updateStatus();
  };

  const picker = (p: {
    name: string;
    title: string;
    any: string;
    options: () => PickerOption[];
    selected: () => string[];
    set: (values: string[]) => void;
    empty: string;
    searchable?: boolean;
  }): HTMLElement => {
    const details = h('details', { class: 'picker' }) as HTMLDetailsElement;
    details.open = openPickers.has(p.name);
    details.addEventListener('toggle', () => (details.open ? openPickers.add(p.name) : openPickers.delete(p.name)));
    const value = h('span', { class: 'picker-value' });
    const search = p.searchable
      ? (h('input', { type: 'search', class: 'picker-search', placeholder: `Find ${p.title.toLowerCase()}`, 'aria-label': `Find ${p.title.toLowerCase()}` }) as HTMLInputElement)
      : undefined;
    const list = h('ul', { class: 'picker-list', 'aria-label': p.title });
    const note = h('p', { class: 'muted small picker-note' });

    const summarize = () => {
      const labels = new Map(p.options().map((o) => [o.value, o.label]));
      const chosen = p.selected().map((v) => labels.get(v) ?? v);
      value.textContent = chosen.length === 0 ? p.any : chosen.length <= 2 ? chosen.join(', ') : `${chosen.slice(0, 2).join(', ')} +${chosen.length - 2}`;
    };
    const toggle = (v: string, checked: boolean) => {
      const values = p.selected().filter((x) => x !== v);
      p.set(checked ? [...values, v] : values);
      summarize();
      changed();
    };
    const fillList = () => {
      const all = p.options();
      const chosen = new Set(p.selected());
      const query = search?.value.trim().toLowerCase() ?? '';
      const known = new Map(all.map((o) => [o.value, o]));
      // Chosen values stay listed (first) whatever the search, so they can be unchosen.
      const first = [...chosen].map((v) => known.get(v) ?? { value: v, label: v, count: 0 });
      const rest = all.filter((o) => !chosen.has(o.value) && (!query || o.label.toLowerCase().includes(query)));
      list.replaceChildren(
        ...[...first, ...rest.slice(0, PICKER_LIMIT)].map((o) => {
          const box = h('input', { type: 'checkbox', value: o.value }) as HTMLInputElement;
          box.checked = chosen.has(o.value);
          box.addEventListener('change', () => toggle(o.value, box.checked));
          return h('li', {}, h('label', {}, box, h('span', { class: 'picker-option' }, o.label), h('span', { class: 'muted' }, o.count.toLocaleString())));
        }),
      );
      note.textContent =
        all.length === 0
          ? p.empty
          : rest.length > PICKER_LIMIT
            ? `Showing ${PICKER_LIMIT} of ${rest.length.toLocaleString()}; type to find more.`
            : query && rest.length === 0
              ? 'Nothing else matches.'
              : '';
      note.hidden = !note.textContent;
      if (search) search.hidden = all.length <= PICKER_LIMIT / 4;
    };
    search?.addEventListener('input', fillList);
    fills.push(() => {
      summarize();
      fillList();
    });
    details.append(h('summary', {}, h('span', { class: 'picker-title' }, p.title), value), h('div', { class: 'picker-body' }, search, list, note));
    return details;
  };

  const pickers = [
    picker({
      name: 'genres',
      title: 'Genres',
      any: 'Any genre',
      options: () => choices.genres.map((o) => ({ value: o.id, label: o.id, count: o.count })),
      selected: () => c.genres,
      set: (v) => (c.genres = v),
      empty: 'No genres are known yet. Find more genres below.',
      searchable: true,
    }),
    picker({
      name: 'decades',
      title: 'Decades',
      any: 'Any decade',
      options: () => choices.decades.map((o) => ({ value: String(o.id), label: `${o.id}s`, count: o.count })),
      selected: () => c.decades.map(String),
      set: (v) => (c.decades = v.map(Number)),
      empty: 'No release years are known.',
    }),
    picker({
      name: 'keys',
      title: 'Keys',
      any: 'Any key',
      options: () => choices.keys.map((o) => ({ value: o.id, label: o.label, count: o.count })),
      selected: () => c.keys,
      set: (v) => (c.keys = v),
      empty: 'No musical keys are known yet. Find musical keys below.',
    }),
    picker({
      name: 'artists',
      title: 'Artists',
      any: 'Any artist',
      options: () => choices.artists.map((o) => ({ value: o.id, label: o.label, count: o.count })),
      selected: () => c.artists,
      set: (v) => (c.artists = v),
      empty: 'No artists yet.',
      searchable: true,
    }),
  ];

  const count = h('input', {
    type: 'number',
    id: 'builder-count',
    min: String(BUILD_LIMITS.minCount),
    max: String(BUILD_LIMITS.maxCount),
    step: '1',
    inputmode: 'numeric',
  }) as HTMLInputElement;
  count.value = String(c.count);
  count.addEventListener('input', () => {
    if (count.value === '' || !Number.isFinite(count.valueAsNumber)) return;
    c.count = clampCount(count.valueAsNumber);
    changed();
  });
  count.addEventListener('change', () => (count.value = String(c.count)));

  const clear = button('Clear choices', { class: 'ghost small' }, () => {
    Object.assign(c, { genres: [], decades: [], keys: [], artists: [] });
    for (const fill of fills) fill();
    changed();
  });

  const built = state.build.built;
  const latest =
    built &&
    h(
      'p',
      { class: 'muted small' },
      'Latest: ',
      (() => {
        const link = h('a', { href: playlistHref(BUILT_KEY) }, built.playlist.name);
        link.addEventListener('click', rememberHomeScroll);
        return link;
      })(),
      ` · ${built.playlist.tracks.length} songs`,
    );

  const el = h(
    'div',
    { class: 'builder', role: 'group', 'aria-labelledby': 'builder-title', 'aria-describedby': 'builder-intro' },
    h('h3', { id: 'builder-title' }, 'Build your own playlist'),
    h(
      'p',
      { class: 'muted', id: 'builder-intro' },
      'Choose any mix of genres, decades, keys and artists, and how many songs you want. This makes a new playlist from your Liked Songs; the filters under Your recommendations only narrow the suggestions.',
    ),
    h(
      'div',
      { class: 'builder-fields' },
      ...pickers,
      h('label', { class: 'builder-count', for: 'builder-count' }, h('span', { class: 'picker-title' }, 'Songs'), count, h('span', { class: 'muted small' }, `${BUILD_LIMITS.minCount}–${BUILD_LIMITS.maxCount}`)),
    ),
    h('div', { class: 'builder-actions' }, build, clear, status),
    latest,
  );
  for (const fill of fills) fill();
  updateStatus();

  return {
    el,
    setChoices: (next) => {
      choices = next;
      // Leave the lists alone while the owner is using them; the next full render catches up.
      if (!el.contains(document.activeElement)) for (const fill of fills) fill();
      updateStatus();
    },
  };
}

/** Try again, and how the built playlist compares to what was asked for, on its page. */
function builtControls(built: BuiltState, onRetry: () => void): HTMLElement {
  const everyMatch = built.matched <= built.requested;
  return h(
    'div',
    { class: 'built-controls' },
    built.matched < built.requested &&
      h(
        'p',
        { class: 'shortfall' },
        `Only ${built.matched.toLocaleString()} of your liked songs match these choices, fewer than the ${built.requested} you asked for.`,
      ),
    h(
      'div',
      { class: 'built-actions' },
      button([icon('shuffle'), 'Try again'], { class: 'secondary', id: 'builder-retry', ...(everyMatch ? { disabled: '' } : {}) }, onRetry),
      h(
        'span',
        { class: 'muted small' },
        everyMatch
          ? 'Every matching song is already in, so another try would pick the same ones.'
          : `Picks a different ${built.requested} of the ${built.matched.toLocaleString()} matching songs, favoring ones not picked yet.`,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Playlist cards

function playlistCard(client: SpotifyClient, p: CuratedPlaylist, facets: Browsable['facets'], kept: boolean, saved?: SavedMatch): HTMLElement {
  // The title link covers the whole card (see .card-link in style.css); the create controls sit above it.
  const link = h('a', { class: 'card-link', href: playlistHref(p.key) }, p.name);
  link.addEventListener('click', rememberHomeScroll);
  const more = p.tracks.length - PREVIEW_COUNT;

  return h(
    'article',
    { class: `card kind-${p.kind}${saved ? ' is-saved' : ''}` },
    h(
      'div',
      { class: 'card-head' },
      cover(p),
      h(
        'div',
        { class: 'card-title' },
        badges(p, kept, !!saved),
        h('h3', {}, link),
        h('div', { class: 'meta' }, `${p.tracks.length} tracks · ${playlistLength(p)}`),
      ),
    ),
    h(
      'div',
      { class: 'card-body' },
      h('p', { class: 'reason' }, p.reason),
      facetChips(facets),
      trackList(p.tracks.slice(0, PREVIEW_COUNT)),
      h('span', { class: 'open-hint', 'aria-hidden': 'true' }, more > 0 ? `See all ${p.tracks.length} tracks →` : 'Open playlist →'),
      createControls(client, p, saved),
    ),
  );
}

function badges(p: CuratedPlaylist, kept: boolean, saved: boolean): HTMLElement {
  return h(
    'div',
    { class: 'badges' },
    h('span', { class: 'badge' }, KIND_LABEL[p.kind]),
    kept && h('span', { class: 'badge kept' }, 'Kept'),
    saved && h('span', { class: 'badge saved' }, 'In your Spotify'),
  );
}

function facetChips(facets: Browsable['facets']): HTMLElement | false {
  const chips = [
    ...(facets.decade != null ? [`${facets.decade}s`] : []),
    ...facets.genres.slice(0, 3),
    ...facets.keys.slice(0, 1).map((k) => k.label),
  ];
  return chips.length > 0 && h('ul', { class: 'chips', 'aria-label': 'Describes' }, ...chips.map((c) => h('li', {}, c)));
}

function playlistLength(p: CuratedPlaylist): string {
  const minutes = Math.round(p.tracks.reduce((sum, t) => sum + t.durationMs, 0) / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

// ---------------------------------------------------------------------------
// Playlist page (#/playlist/<key>)

function backButton(onBack: () => void, label = 'Back to recommendations'): HTMLElement {
  return h('nav', { class: 'page-nav', 'aria-label': 'Playlist' }, button([icon('back'), label], { class: 'ghost' }, onBack));
}

interface TrackEditing {
  remove: (t: LikedTrack) => void;
  restore: (t: LikedTrack) => void;
  restoreAll: () => void;
}

function playlistPage(
  client: SpotifyClient,
  { playlist: p, facets }: Browsable,
  known: { artistGenres: Record<string, string[]>; trackKeys: Record<string, TrackKey | null>; kept: boolean; saved?: SavedMatch },
  editing: TrackEditing & { removed: LikedTrack[] },
  onBack: () => void,
  extra?: HTMLElement | false,
): HTMLElement {
  return h(
    'article',
    { class: 'playlist-page', 'aria-labelledby': 'playlist-title' },
    backButton(onBack, p.kind === 'custom' ? 'Back to Build your own' : undefined),
    h(
      'header',
      { class: 'playlist-hero' },
      cover(p),
      h(
        'div',
        { class: 'playlist-info' },
        badges(p, known.kept, !!known.saved),
        h('h1', { id: 'playlist-title', tabindex: '-1' }, p.name),
        h('p', { class: 'reason' }, p.reason),
        h(
          'div',
          { class: 'meta' },
          `${p.tracks.length} tracks · ${playlistLength(p)}`,
          editing.removed.length > 0 && h('span', { class: 'muted' }, ` · ${editing.removed.length} removed`),
        ),
        facetChips(facets),
        createControls(client, p, known.saved),
        extra,
      ),
    ),
    p.tracks.length > 0
      ? trackTable(p.tracks, known, editing.remove)
      : h('p', { class: 'muted empty' }, 'You removed every track from this playlist. Restore some below to create it.'),
    editing.removed.length > 0 && removedTracks(editing),
  );
}

/** The tracks removed from this playlist, each one a click away from coming back. */
function removedTracks(editing: TrackEditing & { removed: LikedTrack[] }): HTMLElement {
  return h(
    'section',
    { class: 'removed-tracks', 'aria-labelledby': 'removed-title' },
    h(
      'div',
      { class: 'removed-head' },
      h('h2', { id: 'removed-title' }, `Removed from this playlist (${editing.removed.length})`),
      button('Restore all', { class: 'ghost small' }, editing.restoreAll),
    ),
    h(
      'ul',
      {},
      ...editing.removed.map((t) =>
        h(
          'li',
          {},
          h('div', { class: 't' }, h('div', { class: 'name' }, t.name), h('div', { class: 'sub' }, t.artists.map((a) => a.name).join(', '))),
          button('Restore', { class: 'ghost small', 'aria-label': `Restore ${t.name}` }, () => editing.restore(t)),
        ),
      ),
    ),
  );
}

function missingPlaylistPage(state: CuratorState, onBack: () => void, built: boolean): HTMLElement {
  if (built) {
    return h(
      'section',
      { class: 'playlist-page' },
      backButton(onBack, 'Back to Build your own'),
      h(
        'div',
        { class: 'panel missing' },
        h('h1', { tabindex: '-1' }, 'No playlist has been built in this tab yet'),
        h('p', { class: 'muted' }, 'Choose genres, decades, keys or artists under Build your own, then click Build playlist.'),
      ),
    );
  }
  const loading = !!state.genreProgress || state.mbRun.running || state.keyRun.running;
  return h(
    'section',
    { class: 'playlist-page' },
    backButton(onBack),
    h(
      'div',
      { class: 'panel missing' },
      h('h1', { tabindex: '-1' }, 'This playlist isn’t in your recommendations right now'),
      h(
        'p',
        { class: 'muted' },
        loading
          ? 'Genres or keys are still loading, and it may appear when they finish.'
          : 'It may have been part of a different set, or your library changed since the link was made.',
      ),
    ),
  );
}

function trackTable(
  tracks: LikedTrack[],
  known: { artistGenres: Record<string, string[]>; trackKeys: Record<string, TrackKey | null> },
  onRemove: (t: LikedTrack) => void,
): HTMLElement {
  const rows = tracks.map((t) => {
    const key = known.trackKeys[t.id];
    return {
      t,
      year: releaseYear(t),
      key: key ? `${keyName(key)} · ${camelot(key)}` : '',
      genres: [...trackGenres(t, known.artistGenres)].slice(0, 2).join(', '),
    };
  });
  const hasKey = rows.some((r) => r.key);
  const hasGenre = rows.some((r) => r.genres);
  const cell = (cls: string, ...children: Child[]) => h('td', { class: cls }, ...children);
  return h(
    'table',
    { class: 'track-table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { class: 'col-n', scope: 'col' }, '#'),
        h('th', { class: 'col-title', scope: 'col' }, 'Title'),
        h('th', { class: 'col-album', scope: 'col' }, 'Album'),
        h('th', { class: 'col-year', scope: 'col' }, 'Year'),
        hasKey && h('th', { class: 'col-key', scope: 'col' }, 'Key'),
        hasGenre && h('th', { class: 'col-genre', scope: 'col' }, 'Genre'),
        h('th', { class: 'col-remove' }, h('span', { class: 'visually-hidden' }, 'Remove')),
      ),
    ),
    h(
      'tbody',
      {},
      ...rows.map(({ t, year, key, genres }, i) =>
        h(
          'tr',
          {},
          cell('col-n', String(i + 1)),
          cell(
            'col-title',
            h(
              'div',
              { class: 'title-cell' },
              t.album.imageUrl ? h('img', { src: t.album.imageUrl, alt: '', loading: 'lazy' }) : h('div', { class: 'noart' }),
              h(
                'div',
                { class: 't' },
                h('div', { class: 'name', title: t.name }, t.name),
                h('div', { class: 'sub' }, t.artists.map((a) => a.name).join(', '), h('span', { class: 'narrow-album' }, ` · ${t.album.name}`)),
              ),
            ),
          ),
          cell('col-album', t.album.name),
          cell('col-year', year === null ? '' : String(year)),
          hasKey && cell('col-key', key),
          hasGenre && cell('col-genre', genres),
          cell(
            'col-remove',
            button(icon('close'), { class: 'icon-button remove', 'data-remove': t.id, 'aria-label': `Remove ${t.name} from this playlist`, title: 'Remove from this playlist' }, () =>
              onRemove(t),
            ),
          ),
        ),
      ),
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

function createControls(client: SpotifyClient, p: CuratedPlaylist, saved?: SavedMatch): HTMLElement {
  const box = h('div', { class: 'create' });
  const signature = trackSignature(p);
  const refresh = () => box.replaceChildren(...createControlsContent(client, p, signature, saved));
  createControlRefreshers.set(p.key, refresh);
  refresh();
  return box;
}

function createControlsContent(client: SpotifyClient, p: CuratedPlaylist, signature: string, saved?: SavedMatch): HTMLElement[] {
  const status = createdStore.status(p.key, signature);
  if (status.kind === 'created') return openLinks(status.playlist);

  if (p.tracks.length === 0) return [button('Create in Spotify', { class: 'primary', disabled: '' }, () => {}), h('span', { class: 'status' }, 'No tracks left to create.')];
  const create = button(saved ? 'Create again' : 'Create in Spotify', { class: saved ? 'ghost' : 'primary' }, () => {
    create.disabled = true;
    void createdStore.create(
      p.key,
      signature,
      (onProgress) =>
        client.createPlaylist(p.name, playlistDescription(p.reason), p.tracks.map((t) => t.uri), (added, total) =>
          onProgress(`Adding tracks… ${added} / ${total}`),
        ),
      p.name,
    );
  });
  if (status.kind === 'creating') {
    create.disabled = true;
    return [create, h('span', { class: 'status' }, status.progress)];
  }
  if (saved && !status.error) {
    const { playlist, by } = saved;
    return [
      h('a', { class: 'button primary', href: playlist.url, target: '_blank', rel: 'noopener' }, 'Open in Spotify ↗'),
      h('a', { class: 'button ghost', href: playlist.uri }, 'Open in app'),
      create,
      h('span', { class: 'status' }, by === 'name' ? 'Already in your Spotify.' : `Already in your Spotify as “${playlist.name}” (mostly the same tracks).`),
    ];
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

void start();
