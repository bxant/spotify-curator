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
import { ICONS, button, h, icon, type Child } from './dom';
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
  type CurationResult,
} from './curate';
import {
  cachedEnrichment,
  enrichmentProgress,
  keysCovered,
  mergeEnrichment,
  openGenres,
  runEnrichment,
  type EnrichmentData,
  type EnrichmentProgress,
  type EnrichmentStatus,
} from './enrich';
import { loadLibrary, type LibrarySnapshot } from './library';
import { MusicBrainzClient } from './musicbrainz';
import { mapWithConcurrency } from './http';
import { ReccoBeatsClient } from './reccobeats';
import { seriesKey, showSuggestions } from './parts';
import { formatRoute, homeHref, parentRoute, parseRoute, playlistHref, type Route } from './route';
import { CACHE_PREFIX, SessionCache, browserCache } from './session-cache';
import { CreatedStore } from './created-store';
import { RemovedStore } from './removed-store';
import { APP_TAG, matchSaved, playlistDescription, type SavedMatch } from './saved';
import { SpotifyClient, type CreatedPlaylist } from './spotify';
import type { CuratedPlaylist, LikedTrack, PlaylistKind, SavedPlaylist, SavedTracks, TrackKey } from './types';
import { WikidataClient } from './wikidata';
import { withLookupLock, type Locks } from './shared-lookups';
import { chordsUrl, showChordsLink } from './chords';

const app = document.getElementById('app') as HTMLElement;
const cache = new SessionCache();
/** Key and genre lookups outlive the tab: they are public data and slow to look up again. */
const lookupCache = browserCache();
/** One client per service for every lookup, so throttles (and any 503 slowdown) carry across runs. */
const musicBrainz = new MusicBrainzClient();
const wikidata = new WikidataClient();
const reccoBeats = new ReccoBeatsClient();
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
/** While keys and genres arrive, the suggestions are re-curated at most this often. */
const RECURATE_MS = 3000;
/** The background status updates its count at most this often. */
const STATUS_MS = 400;
const THEME_KEY = 'curator.theme';
/** Bumped on every (re)load so enrichment from an older load cannot re-render the page. */
let generation = 0;
/** Aborted with each new generation so an older load's lookups stop making requests. */
let lookups = new AbortController();

function nextGeneration(): number {
  hideStatusDock();
  lookups.abort();
  lookups = new AbortController();
  activeView = undefined;
  return ++generation;
}

// ---------------------------------------------------------------------------
// Routing: the recommendations (#/, with sort and filters in the query) and one page per
// playlist (#/playlist/<key>). See src/route.ts.

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
  // Marks a playlist page opened from the page its Back button returns to, so Back can
  // step back there (with its sort, filters and scroll) even after a reload.
  const parent = parentRoute(route, DEFAULT_CRITERIA);
  if (parent) mergeHistoryState({ fromHome: from.name === parent.name });
  activeView?.navigate(from);
});

interface EntryState {
  /** Scroll position of the recommendations when a playlist was opened from them. */
  scrollY?: number;
  /** This playlist page was opened from the entry right before it, the recommendations its Back returns to. */
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

/** Back to the page a playlist page belongs to: a real history step when it is the previous page, else a new one. */
function backToParent(criteria: BrowseCriteria) {
  const parent = parentRoute(route, criteria);
  if (historyState().fromHome) history.back();
  else location.hash = parent ? formatRoute(parent) : homeHref(criteria);
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
    const back = takeReturnHash();
    try {
      await auth.handleCallback(location.search);
    } catch (err) {
      history.replaceState(null, '', '/');
      showSignIn(auth, errorText(err));
      return;
    }
    history.replaceState(null, '', `/${back}`);
    route = parseRoute(location.hash);
  }

  if (!auth.isSignedIn()) {
    showSignIn(auth);
    return;
  }
  await showCurator(auth);
}

function lookupLocks(): Locks | undefined {
  return 'locks' in navigator ? navigator.locks : undefined;
}

/** The page to come back to after signing in, since Spotify redirects to /callback. */
const RETURN_HASH_KEY = 'curator.return-hash';

function rememberReturnHash() {
  try {
    sessionStorage.setItem(RETURN_HASH_KEY, location.hash);
  } catch {
    // Signing in lands on the recommendations instead.
  }
}

function takeReturnHash(): string {
  try {
    const hash = sessionStorage.getItem(RETURN_HASH_KEY) ?? '';
    sessionStorage.removeItem(RETURN_HASH_KEY);
    return hash.startsWith('#/') ? hash : '';
  } catch {
    return '';
  }
}

/** Signs this tab out: stops its work and clears the session cache, lookup results and token. */
function signOutHere(auth: SpotifyAuth) {
  nextGeneration();
  createdStore.reset();
  cache.clear();
  lookupCache.clear();
  auth.signOut();
  showSignIn(auth);
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
    rememberReturnHash();
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
      h(
        'p',
        { class: 'muted small' },
        'Once your library is loaded, the page looks up musical keys and genres from free outside services ' +
          '(ReccoBeats, Wikidata and MusicBrainz), because Spotify no longer offers them to apps like this one. ' +
          'They receive only Spotify track and artist IDs, artist names and recording codes, never your account.',
      ),
    ),
  );
}

interface CuratorState {
  library: LibrarySnapshot;
  /** Keys and genres found so far; filled in place by the background lookups. */
  enrich: EnrichmentData;
  /**
   * The keys the suggestions are curated with: those known when the page loaded, then all
   * of them once a key lookup ends. Keys arrive in no useful order, so curating with part of
   * them would keep swapping which key playlists are shown.
   */
  curatedKeys: Record<string, TrackKey | null>;
  status: EnrichmentStatus;
  /** Stops the running background lookups; unset when none run. */
  stop?: () => void;
  /** 0 is the default set; each "Curate a different set" moves to the next one. */
  variant: number;
  /** Suggestions the owner kept when curating a different set, exactly as they were. */
  kept: CuratedPlaylist[];
  /** Parts shown per suggestion (series key), for the ones "More like this" revealed more of; 1 when missing. */
  revealed: Record<string, number>;
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
  revealed?: Record<string, number>;
}

async function showCurator(auth: SpotifyAuth, forceReload = false) {
  const current = nextGeneration();
  const signal = lookups.signal;
  const client = new SpotifyClient({ getToken: (force) => auth.getAccessToken(force) });
  const status = h('p', { class: 'muted' }, 'Connecting to Spotify…');
  show(h('section', { class: 'panel center' }, brand(), h('h1', {}, 'Reading your library'), h('div', { class: 'spinner', 'aria-hidden': 'true' }), status));

  let library: LibrarySnapshot;
  try {
    library = await loadLibrary(client, cache, (message) => (status.textContent = message), forceReload, lookupCache);
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
  // Refresh data goes back to the default set and drops the playlist built from the old library.
  if (forceReload) {
    cache.set(SET_KEY, null);
    const stale = cache.get<BuildState>(BUILD_KEY);
    if (stale) cache.set(BUILD_KEY, { criteria: stale.criteria } satisfies BuildState);
    removedStore.restoreAll(BUILT_KEY);
  }
  const set = cache.get<SavedSet>(SET_KEY);
  const enrich = cachedEnrichment(lookupCache);
  const state: CuratorState = {
    library,
    enrich,
    curatedKeys: enrich.keys,
    // Lookups start right after the first render, so it must not claim there are no keys or genres.
    status: { keys: { state: 'running', errors: [] }, genres: { state: 'running', errors: [] } },
    variant: set?.variant ?? 0,
    kept: set?.kept ?? [],
    revealed: set?.revealed ?? {},
    criteria: route.name === 'home' ? { ...route.criteria } : { ...DEFAULT_CRITERIA },
    saved,
    showSaved: false,
    build: cache.get<BuildState>(BUILD_KEY) ?? { criteria: emptyCriteria() },
  };

  // Keys and genres start on their own: playlists that need neither are already on the
  // page, and key and genre playlists fill in as results arrive.
  const findKeysAndGenres = () => {
    if (state.stop) return;
    const stop = new AbortController();
    state.stop = () => stop.abort();
    state.status = { keys: { state: 'running', errors: [] }, genres: { state: 'running', errors: [] } };
    const clients = { spotify: client, reccoBeats, wikidata, musicBrainz };
    // One tab at a time runs the lookups (src/shared-lookups.ts); while
    // another one does, this tab takes in the results it saves to the shared cache.
    let ran = false;
    const pickUp = () => {
      mergeEnrichment(state.enrich, cachedEnrichment(lookupCache));
      if (state.status.keys.state === 'running' && keysCovered(library.liked, state.enrich.keys)) state.status.keys = { state: 'done', errors: [] };
    };
    const onStorage = (e: StorageEvent) => {
      if (ran || !e.key?.startsWith(CACHE_PREFIX)) return;
      pickUp();
      view.changed();
    };
    window.addEventListener('storage', onStorage);
    pickUp();
    void withLookupLock(lookupLocks(), AbortSignal.any([signal, stop.signal]), async () => {
      ran = true;
      mergeEnrichment(state.enrich, cachedEnrichment(lookupCache));
      await runEnrichment(library.liked, lookupCache, clients, state.enrich, state.status, view.changed, {
        teardown: signal,
        stop: stop.signal,
      });
    }).then((didRun) => {
      window.removeEventListener('storage', onStorage);
      if (signal.aborted) return;
      // Stopped while another tab had the lookups: nothing ran here.
      if (!didRun) state.status = { keys: { state: 'stopped', errors: [] }, genres: { state: 'stopped', errors: [] } };
      state.stop = undefined;
      view.changed();
    });
    view.changed();
  };

  const view = createCuratorView(auth, client, state, () => current === generation, { findKeysAndGenres });
  activeView = view;
  view.render();
  findKeysAndGenres();
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
  /** Starts (or resumes) the background key and genre lookups; does nothing while they run. */
  findKeysAndGenres: () => void;
}

function createCuratorView(
  auth: SpotifyAuth,
  client: SpotifyClient,
  state: CuratorState,
  isCurrent: () => boolean,
  actions: Actions,
) {
  const dock = statusDock(actions);

  const curateNow = (want?: string) => {
    const { enrich, curatedKeys } = state;
    const open = openGenres(enrich);
    const options = {
      now: new Date(),
      artistGenres: enrich.spotify,
      openGenres: open,
      trackKeys: curatedKeys,
      variant: state.variant,
    };
    let result = curate(state.library.liked, state.library.history, options);
    const savedList = savedPlaylists(state);
    const needTracks = new Set<string>();
    // Suggestions are shown in parts of 25 (src/parts.ts). A saved part is set aside and
    // the suggestion's next part fills in; once every part is saved, the next candidate
    // does. A card created from this page keeps showing its own Open links instead.
    // Matching and Create both see the tracks as shown, without the ones the owner removed.
    const { fresh, saved, more, revealed } = showSuggestions(
      (used) => {
        if (used.size > 0) result = curate(state.library.liked, state.library.history, { ...options, exclude: used });
        return result.playlists;
      },
      state.kept,
      state.revealed,
      (playlists, matched) => {
        const check = matchSaved(
          playlists.filter((p) => !createdStore.hasRecord(p.key)).map((p) => removedStore.apply(p)),
          savedList.filter((s) => !matched.has(s.id)),
          state.saved.tracks,
        );
        for (const id of check.needTracks) needTracks.add(id);
        return check.matches;
      },
      want,
    );
    /** As curated (kept suggestions carry these, so a removal can still be undone after a new set). */
    const curated = [...fresh, ...saved.map((s) => s.playlist)];
    /** As shown and created: without the tracks the owner removed. */
    const shown = fresh.map((p) => removedStore.apply(p));
    const artistGenres = mergeGenres(enrich.spotify, open);
    const facetInputs = { artistGenres, trackKeys: curatedKeys };
    const browsable = (playlist: CuratedPlaylist): Browsable => ({ playlist, facets: playlistFacets(playlist, facetInputs) });
    return {
      result,
      curated,
      shown,
      freshItems: shown.map(browsable),
      savedItems: saved.map((s) => browsable(removedStore.apply(s.playlist))),
      savedMatches: new Map(saved.map((s) => [s.playlist.key, s.match])),
      /** The next part of a suggestion, keyed by the last part of it on show. */
      more,
      revealed,
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
      if (isCurrent()) refresh();
    });
  };

  const scores = playScores(state.library.liked, state.library.history);
  const buildInputs = () => ({
    artistGenres: mergeGenres(state.enrich.spotify, openGenres(state.enrich)),
    trackKeys: state.enrich.keys,
    scores,
  });
  const saveBuild = () => cache.set(BUILD_KEY, state.build);
  const saveSet = () => cache.set(SET_KEY, { variant: state.variant, kept: state.kept, revealed: state.revealed } satisfies SavedSet);

  /** "More like this": shows the next part of the suggestion `p` belongs to. */
  const revealMore = (p: CuratedPlaylist) => {
    const series = seriesKey(p);
    state.revealed = { ...state.revealed, [series]: (state.revealed[series] ?? 1) + 1 };
    saveSet();
  };

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
    /**
     * Cards by playlist key. A card is reused while it shows the same thing, so updates as
     * keys and genres arrive only add, replace or move the cards that changed, and the
     * browser keeps the cards in view where they are.
     */
    let cards = new Map<string, { sig: string; el: HTMLElement }>();
    const renderGrid = (background = false) => {
      const { keptKeys, savedMatches, more } = cur;
      const all = items();
      const visible = browse(all, state.criteria);
      renderSavedLine();
      const wanted = visible.map(({ playlist, facets }) => {
        const kept = keptKeys.has(playlist.key);
        const saved = savedMatches.get(playlist.key);
        const next = saved ? undefined : more.get(playlist.key);
        return { playlist, facets, kept, saved, next, sig: cardSignature(playlist, facets, kept, saved, next) };
      });
      // Leave the cards alone while the focused one would change; the next update catches up.
      const focused = grid.contains(document.activeElement) ? document.activeElement?.closest<HTMLElement>('.card') : null;
      if (focused && !wanted.some((w) => cards.get(w.playlist.key)?.el === focused && cards.get(w.playlist.key)?.sig === w.sig)) return;

      count.textContent =
        visible.length === all.length ? `All ${all.length} playlists` : `${visible.length} of ${all.length} playlists`;
      if (visible.length === 0) {
        cards = new Map();
        grid.replaceChildren(
          all.length === 0
            ? h(
                'p',
                { class: 'muted empty' },
                cur.savedItems.length > 0
                  ? 'Every recommendation is already in your Spotify.'
                  : 'Not enough liked songs or listening history to suggest playlists yet.',
              )
            : h('div', { class: 'muted empty' }, h('p', {}, 'None of your recommendations match these filters.'), button('Clear filters', { class: 'ghost small' }, bar.clear)),
        );
        return;
      }
      const next = new Map<string, { sig: string; el: HTMLElement }>();
      for (const { playlist, facets, kept, saved, next: nextPart, sig } of wanted) {
        const old = cards.get(playlist.key);
        const el = old?.sig === sig ? old.el : playlistCard(client, playlist, facets, kept, saved, nextPart && { ...nextPart, reveal: () => showMore(playlist, nextPart.next) });
        // Playlists that appear while the page is open (e.g. once keys arrive) fade in, once.
        if (!old && background && cards.size > 0) {
          el.classList.add('fresh');
          el.addEventListener('animationend', () => el.classList.remove('fresh'), { once: true });
        }
        next.set(playlist.key, { sig, el });
      }
      cards = next;
      placeChildren(grid, [...next.values()].map((c) => c.el));
    };
    const onCriteria = () => {
      syncHomeUrl();
      renderGrid();
    };
    /** Reveals the next part as its own card, right after this one, and moves focus to it. */
    const showMore = (p: CuratedPlaylist, next: CuratedPlaylist) => {
      revealMore(p);
      // The grid leaves a focused card alone while it would change, and this one loses its button.
      (document.activeElement as HTMLElement | null)?.blur();
      refresh();
      app.querySelector<HTMLElement>(`a.card-link[href="${CSS.escape(playlistHref(next.key))}"]`)?.focus();
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
          button('Reconnect Spotify', { class: 'link-button' }, async () => {
            rememberReturnHash();
            location.assign(await auth.authorizeUrl());
          }),
        );
      } else if (state.saved.status === 'error') {
        parts.push(`Could not read your playlists (${state.saved.error}), so recommendations saved in earlier sessions may show again.`);
      }
      savedLine.replaceChildren(...parts.filter((c): c is Node | string => !!c));
      savedLine.hidden = parts.length === 0;
    };

    const builder = builderPanel(state, buildChoices(state.library.liked, buildInputs()), {
      count: (c) => matchingTracks(state.library.liked, c, buildInputs()).length,
      save: saveBuild,
      build: () => {
        if (build(state.build.criteria)) {
          rememberHomeScroll();
          location.hash = playlistHref(BUILT_KEY);
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
          state.revealed = {};
          saveSet();
          render();
        });
      });
    show(
      topBar(auth),
      heroEl,
      createdList(),
      curationSection(recurate, builder.el),
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
      if (!heroEl.contains(document.activeElement)) {
        const next = hero(state, cur.result);
        heroEl.replaceWith(next);
        heroEl = next;
      }
      bar.setItems(items());
      syncHomeUrl();
      renderGrid(true);
      fetchNeededTracks(cur);
    };
  };

  const renderPlaylist = (key: string) => {
    const isBuilt = key === BUILT_KEY;
    const find = () => {
      const cur = curateNow(isBuilt ? undefined : key);
      // A link to a part not revealed yet (e.g. from another session) reveals it.
      if (cur.revealed !== state.revealed) {
        state.revealed = { ...cur.revealed };
        saveSet();
      }
      const built = isBuilt ? state.build.built : undefined;
      // Saved recommendations keep their page even while hidden from the grid.
      const builtPlaylist = built && removedStore.apply(built.playlist);
      const item = isBuilt
        ? builtPlaylist && { playlist: builtPlaylist, facets: playlistFacets(builtPlaylist, { artistGenres: cur.artistGenres, trackKeys: state.enrich.keys }) }
        : [...cur.freshItems, ...cur.savedItems].find((i) => i.playlist.key === key);
      const saved = cur.savedMatches.get(key);
      const next = saved || isBuilt ? undefined : cur.more.get(key);
      fetchNeededTracks(cur);
      return {
        cur,
        item,
        saved,
        next,
        signature: item ? `${trackSignature(item.playlist)}|${saved?.playlist.id ?? ''}|${next?.next.key ?? ''}` : '',
      };
    };
    let shown = find();
    /** Offers the playlist as newly curated, instead of changing its tracks under the reader. */
    const notice = h('div', { class: 'update-notice', role: 'status', hidden: '' });
    const back = () => backToParent(state.criteria);
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
      const { cur, item, saved, next } = shown;
      const original = isBuilt ? state.build.built?.playlist : cur.curated.find((p) => p.key === key);
      const byId = new Map(original?.tracks.map((t) => [t.id, t]));
      const removed = removedStore
        .removed(key)
        .map((id) => byId.get(id))
        .filter((t): t is LikedTrack => !!t);
      notice.hidden = true;
      show(
        topBar(auth),
        notice,
        item
          ? playlistPage(
              client,
              item,
              { artistGenres: cur.artistGenres, trackKeys: state.enrich.keys, kept: cur.keptKeys.has(key), saved },
              { removed, ...editing },
              back,
              isBuilt ? state.build.built && builtControls(state.build.built, retry) : next && moreButton(next, () => openMore(item.playlist, next.next)),
            )
          : missingPlaylistPage(state, back, isBuilt),
      );
    };
    /** Reveals the next part and opens its page. */
    const openMore = (p: CuratedPlaylist, nextPart: CuratedPlaylist) => {
      revealMore(p);
      location.hash = playlistHref(nextPart.key);
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
      if (next.signature === shown.signature) {
        shown = next;
        notice.hidden = true;
        return;
      }
      // A playlist that was missing just appears (unless a control has focus); one on the
      // page keeps its tracks (and saved match) until the owner asks for the update.
      if (!shown.item) {
        if (!document.activeElement?.matches('#app :is(a, button)')) {
          shown = next;
          draw();
        }
        return;
      }
      notice.replaceChildren(
        h('span', {}, next.item ? 'Newly found keys and genres changed this playlist.' : 'Newly found keys and genres replaced this playlist.'),
        button('Show the update', { class: 'ghost small' }, () => {
          shown = find();
          draw();
          app.querySelector<HTMLElement>('.playlist-page h1')?.focus();
        }),
      );
      notice.hidden = false;
    };
  };

  const render = () => {
    if (!isCurrent()) return;
    if (route.name === 'playlist') renderPlaylist(route.key);
    else renderHome();
  };

  /**
   * Called on every bit of background progress. The status dock catches up every
   * STATUS_MS, and the suggestions are re-curated at most every RECURATE_MS (when the
   * browser is idle), or right away when a lookup finishes or stops.
   */
  let lanes = '';
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let curateTimer: ReturnType<typeof setTimeout> | undefined;
  let curatedAt = 0;
  const showStatus = () => {
    statusTimer = undefined;
    if (isCurrent()) dock.update(state, enrichmentProgress(state.library.liked, state.enrich, state.status));
  };
  const recurate = () => {
    curateTimer = undefined;
    whenIdle(() => {
      if (!isCurrent()) return;
      curatedAt = performance.now();
      refresh();
    });
  };
  const changed = () => {
    if (!isCurrent()) return;
    if (state.status.keys.state !== 'running') state.curatedKeys = state.enrich.keys;
    const now = `${state.status.keys.state} ${state.status.genres.state}`;
    const settled = now !== lanes;
    lanes = now;
    if (settled) {
      clearTimeout(statusTimer);
      clearTimeout(curateTimer);
      curateTimer = undefined;
      showStatus();
      // Starting needs no new suggestions; a lookup that finished or stopped does.
      if (now !== 'running running') recurate();
      return;
    }
    statusTimer ??= setTimeout(showStatus, STATUS_MS);
    curateTimer ??= setTimeout(recurate, Math.max(0, curatedAt + RECURATE_MS - performance.now()));
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

  return { render, changed, navigate };
}

/** Runs `fn` when the browser is idle (or within a second), off the path of input and scrolling. */
function whenIdle(fn: () => void) {
  if ('requestIdleCallback' in window) requestIdleCallback(() => fn(), { timeout: 1000 });
  else setTimeout(fn, 0);
}

function topBar(auth: SpotifyAuth): HTMLElement {
  // Refetches likes and listening history; key and genre lookups stay cached and
  // only newly liked songs and artists are looked up.
  const refresh = button('Refresh data', { class: 'ghost', title: 'Refetch Liked Songs and listening history' }, () => {
    createdStore.reset();
    void showCurator(auth, true);
  });
  const signOut = button('Sign out', { class: 'ghost' }, () => {
    signOutHere(auth);
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

  const notes: string[] = [];
  const { keys, genres } = state.status;
  if (genres.state === 'done' && genres.errors.length === 0 && s.likedCount > 0 && s.tracksWithGenres === 0) {
    notes.push('Neither Spotify, Wikidata nor MusicBrainz had genres for your artists, so there are no genre playlists.');
  }
  if (keys.state === 'done' && keys.errors.length === 0 && s.likedCount > 0 && s.tracksWithKey === 0) {
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

function curationSection(recurate: HTMLElement | false, builder: HTMLElement): HTMLElement {
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
          'Playlists are picked from your Liked Songs and listening history, with musical keys and genres looked up in the background. ' +
            'Curate a different set for new picks, or build your own from the genres, decades, keys and artists you choose.',
        ),
      ),
      recurate,
    ),
    builder,
    h('h3', { class: 'sources-title', id: 'data-sources' }, 'Data sources'),
    dataSources(),
  );
}

interface DataSource {
  icon: keyof typeof ICONS;
  name: string;
  url: string;
  gives: string;
  receives: string;
}

const DATA_SOURCES: DataSource[] = [
  {
    icon: 'note',
    name: 'Spotify',
    url: 'https://developer.spotify.com/documentation/web-api',
    gives: 'Your profile, Liked Songs, top items and recent plays, any artist genres it still has, and the playlists you create.',
    receives: 'Your sign-in, and the playlists you choose to create.',
  },
  {
    icon: 'bars',
    name: 'ReccoBeats',
    url: 'https://reccobeats.com',
    gives: 'Musical keys, for key playlists and key filters.',
    receives: 'The Spotify track IDs of your liked songs.',
  },
  {
    icon: 'tag',
    name: 'Wikidata',
    url: 'https://www.wikidata.org',
    gives: 'Artist genres, and the MusicBrainz ID of each artist it knows. Hundreds of artists per request, so it goes first.',
    receives: 'Spotify artist IDs.',
  },
  {
    icon: 'tag',
    name: 'MusicBrainz',
    url: 'https://musicbrainz.org',
    gives: 'Genres for artists Wikidata has none for, at the one request a second it asks for.',
    receives: 'Spotify artist IDs, artist names, MusicBrainz artist IDs, and the ISRC recording codes of liked songs.',
  },
  {
    icon: 'note',
    name: 'Google Search',
    url: 'https://www.google.com',
    gives: 'Nothing to this page: Chords ↗ next to a song on a playlist page opens a Google search for its chords in a new tab.',
    receives: 'Only when you click Chords ↗: that song’s title and artist, in the search address.',
  },
];

/** Who the page talks to, what each one gets, and why outside services are involved at all. */
function dataSources(): HTMLElement {
  return h(
    'div',
    { class: 'sources' },
    h(
      'p',
      { class: 'muted' },
      'Spotify has closed musical keys (audio features) to new developer apps and deprecated artist genres, so this page fills those gaps ' +
        'from free, open services that need no account or API key. They never receive your Spotify account, sign-in or listening history. ' +
        'Results are kept in this browser, so later visits only look up new songs and artists; Sign out clears them.',
    ),
    h(
      'ul',
      { class: 'source-list' },
      ...DATA_SOURCES.map((d) =>
        h(
          'li',
          {},
          h('span', { class: 'source-icon', 'aria-hidden': 'true' }, icon(d.icon)),
          h(
            'div',
            {},
            h('a', { href: d.url, target: '_blank', rel: 'noopener' }, d.name),
            h('p', { class: 'small' }, d.gives),
            h('p', { class: 'small muted' }, h('strong', {}, 'Receives: '), d.receives),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Background status: a small dock, on every page, that says the playlists shown are ready
// while keys and genres are still being looked up, and how far that has got.

interface Dock {
  el: HTMLElement;
  /** Announced to screen readers; changes only when the lookups start, finish or stop. */
  live: HTMLElement;
  toggle: HTMLButtonElement;
  body: HTMLElement;
  title: HTMLElement;
  bar: HTMLProgressElement;
  detail: HTMLElement;
  action: HTMLElement;
  mode?: string;
}

let dock: Dock | undefined;
/** What the dock shows and acts on: the state and actions of the current page. */
let dockState: { state: CuratorState; actions: Actions } | undefined;
/** The dock is shrunk to its icon; remembered for the tab's session. */
let dockCollapsed = false;

function hideStatusDock() {
  dock?.el.remove();
  dock = undefined;
  dockState = undefined;
}

function statusDock(actions: Actions) {
  return {
    update: (state: CuratorState, progress: EnrichmentProgress) => {
      dockState = { state, actions };
      drawStatusDock(progress);
    },
  };
}

function createDock(): Dock {
  const toggle = button('', { class: 'dock-toggle' }, () => {
    dockCollapsed = !dockCollapsed;
    if (dock) dock.mode = undefined;
    if (lastProgress) drawStatusDock(lastProgress);
  });
  const d: Dock = {
    el: h('aside', { class: 'dock', 'aria-label': 'Background lookups' }),
    live: h('p', { class: 'visually-hidden', role: 'status' }),
    toggle,
    body: h('div', { class: 'dock-body' }),
    title: h('p', { class: 'dock-title' }),
    bar: h('progress', { 'aria-label': 'Songs checked' }) as HTMLProgressElement,
    detail: h('p', { class: 'dock-detail small muted' }),
    action: h('span', { class: 'dock-action' }),
  };
  // Built once and left alone, so it stays open (and keeps focus) while the counts change.
  const sources = h('details', { class: 'dock-sources' }, h('summary', {}, 'Data sources'), dataSources());
  d.body.append(d.title, d.bar, d.detail, h('div', { class: 'dock-actions' }, d.action, sources));
  d.el.append(toggle, d.live, d.body);
  document.body.append(d.el);
  return d;
}

let lastProgress: EnrichmentProgress | undefined;

function drawStatusDock(progress: EnrichmentProgress) {
  if (!dockState) return;
  lastProgress = progress;
  const { state } = dockState;
  dock ??= createDock();
  const d = dock;
  const { keys, genres } = state.status;
  const running = keys.state === 'running' || genres.state === 'running';
  const stopped = !running && (keys.state === 'stopped' || genres.state === 'stopped');
  const errors = [...keys.errors, ...genres.errors];
  const n = (x: number) => x.toLocaleString();
  const counts = `${n(progress.withKey)} with a key · ${n(progress.withGenres)} with genres`;

  let mode: 'running' | 'stopped' | 'partial' | 'done';
  let title: string;
  let detail: string;
  if (running) {
    mode = 'running';
    title = 'Your playlists are ready. Finding keys and genres in the background…';
    detail = `${n(progress.settled)} of ${n(progress.songs)} songs`;
  } else if (stopped) {
    mode = 'stopped';
    title = 'Stopped finding keys and genres. Playlists use what was found.';
    detail = `${n(progress.settled)} of ${n(progress.songs)} songs checked · ${counts}`;
  } else if (errors.length > 0) {
    mode = 'partial';
    title = 'Some lookups could not finish. Playlists use what was found.';
    detail = `${errors.join(' · ')} · ${counts}`;
  } else {
    mode = 'done';
    title = 'Keys and genres are up to date.';
    detail = `${counts}, of ${n(progress.songs)} songs`;
  }
  const summary = running ? 'Finding keys and genres in the background' : title;

  d.title.textContent = title;
  d.detail.textContent = detail;
  d.bar.hidden = !running;
  d.bar.max = Math.max(1, progress.songs);
  d.bar.value = progress.settled;
  if (d.live.textContent !== summary) d.live.textContent = summary;
  d.toggle.title = dockCollapsed ? `${summary} (show details)` : 'Hide';
  d.toggle.setAttribute('aria-label', dockCollapsed ? `Show background lookups: ${summary}` : 'Hide background lookups');
  d.toggle.setAttribute('aria-expanded', String(!dockCollapsed));
  d.body.hidden = dockCollapsed;
  if (d.mode === mode) return;

  // Buttons are only rebuilt when the lookups change state, so focus stays on them meanwhile.
  d.mode = mode;
  d.el.className = `dock ${mode}${dockCollapsed ? ' collapsed' : ''}`;
  d.toggle.replaceChildren(icon(mode === 'running' ? 'note' : mode === 'done' ? 'check' : 'tag'));
  const hadFocus = d.action.contains(document.activeElement);
  d.action.replaceChildren(
    mode === 'running'
      ? button('Stop', { class: 'ghost small' }, () => dockState?.state.stop?.())
      : mode === 'done'
        ? ''
        : button(mode === 'stopped' ? 'Resume' : 'Try again', { class: 'ghost small' }, () => dockState?.actions.findKeysAndGenres()),
  );
  if (hadFocus) (d.action.querySelector('button') ?? d.toggle).focus();
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

/** Suggestions show at most PART_SIZE (25) songs, so the size filter stops there. */
const SIZE_OPTIONS = [10, 20, 25];

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
      () => (options.keys.length > 0 ? undefined : state.stop ? 'Keys are still loading' : 'No keys yet'),
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
    status.classList.toggle('error', n === 0);
    status.textContent =
      n === 0
        ? 'No liked songs match all of these choices. Choose more values, or fewer kinds of choices.'
        : n < c.count
          ? `${songs}, fewer than the ${c.count} you asked for, so all of them will be in.`
          : `${songs}; ${c.count} will be picked at random, spread across artists.`;
  };
  const changed = () => {
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
      empty: 'No genres are known yet; they are still being looked up or none were found.',
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
      empty: 'No musical keys are known yet; they are still being looked up or none were found.',
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

/** The next part of a suggestion, and how to reveal it. */
interface NextPart {
  next: CuratedPlaylist;
  left: number;
  reveal: () => void;
}

function playlistCard(
  client: SpotifyClient,
  p: CuratedPlaylist,
  facets: Browsable['facets'],
  kept: boolean,
  saved?: SavedMatch,
  next?: NextPart,
): HTMLElement {
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
      next && moreButton(next, next.reveal),
    ),
  );
}

/** What a card shows, so an unchanged card can stay on the page as it is. */
function cardSignature(p: CuratedPlaylist, facets: Browsable['facets'], kept: boolean, saved: SavedMatch | undefined, next?: { next: CuratedPlaylist; left: number }): string {
  return JSON.stringify([trackSignature(p), p.name, p.reason, kept, saved?.playlist.id, facets.decade, facets.genres.slice(0, 3), facets.keys[0]?.id, next?.next.key, next?.left]);
}

/** "More like this": reveals the suggestion's next part as a playlist of its own. */
function moreButton(next: { next: CuratedPlaylist; left: number }, onClick: () => void): HTMLElement {
  const n = next.next.tracks.length;
  const later = next.left > 1 ? ` · ${next.left - 1} more after it` : '';
  return h(
    'div',
    { class: 'more-like-this' },
    button('More like this', { class: 'ghost small', 'aria-label': `More like this: show ${next.next.name}, ${n} more songs` }, onClick),
    h('span', { class: 'muted small' }, `${next.next.part ? `Part ${next.next.part.number}` : next.next.name} · ${n} songs${later}`),
  );
}

/** Makes `els` the children of `parent` in order, leaving children already in place untouched. */
function placeChildren(parent: HTMLElement, els: HTMLElement[]) {
  els.forEach((el, i) => {
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
  });
  while (parent.children.length > els.length) parent.lastElementChild?.remove();
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
  const loading = !!state.stop;
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
    const genres = trackGenres(t, known.artistGenres);
    return {
      t,
      year: releaseYear(t),
      key: key ? `${keyName(key)} · ${camelot(key)}` : '',
      genres: [...genres].slice(0, 2).join(', '),
      chords: showChordsLink(genres),
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
        h('th', { class: 'col-chords', scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Chords')),
        h('th', { class: 'col-remove' }, h('span', { class: 'visually-hidden' }, 'Remove')),
      ),
    ),
    h(
      'tbody',
      {},
      ...rows.map(({ t, year, key, genres, chords }, i) =>
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
          cell('col-chords', chords && chordsLink(t)),
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

/** A Google search for the song's chords, in a new tab (see src/chords.ts). */
function chordsLink(t: LikedTrack): HTMLElement {
  const label = `Search Google for the chords of ${t.name} (opens in a new tab)`;
  return h('a', { class: 'button ghost small chords-link', href: chordsUrl(t), target: '_blank', rel: 'noopener noreferrer', 'aria-label': label, title: label }, 'Chords ↗');
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
