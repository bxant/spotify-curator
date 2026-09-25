import './style.css';
import { AuthError, SpotifyAuth } from './auth';
import { REDIRECT_URI, configuredClientId } from './config';
import { curate, trackSignature, type CurationResult } from './curate';
import { loadGenres, loadKeys, loadLibrary, type LibrarySnapshot } from './library';
import { ReccoBeatsClient } from './reccobeats';
import { SessionCache } from './session-cache';
import { SpotifyClient, type CreatedPlaylist } from './spotify';
import type { CuratedPlaylist, LikedTrack, TrackKey } from './types';

const app = document.getElementById('app') as HTMLElement;
const cache = new SessionCache();

/** Playlist description limit on Spotify. */
const DESCRIPTION_MAX = 300;
const PREVIEW_COUNT = 5;
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

function show(...nodes: Child[]) {
  app.replaceChildren(...nodes.filter((n): n is Node | string => !!n));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function start() {
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

function showSetup() {
  show(
    h(
      'section',
      { class: 'panel center' },
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
  const button = h('button', { class: 'primary', type: 'button' }, 'Connect Spotify') as HTMLButtonElement;
  button.addEventListener('click', async () => {
    button.disabled = true;
    location.assign(await auth.authorizeUrl());
  });
  show(
    h(
      'section',
      { class: 'panel center' },
      h('h1', {}, 'Liked Songs Curator'),
      h(
        'p',
        {},
        'Suggests playlists from your Liked Songs — real favorites, forgotten likes, the best of albums you liked whole, ' +
          'genres, musical keys and decades — and creates the ones you pick as private playlists in your Spotify account.',
      ),
      error && h('p', { class: 'error' }, error),
      button,
      h(
        'p',
        { class: 'muted' },
        'Read-only access to your library, top items and recent plays, plus permission to create private playlists. ' +
          'Nothing is stored outside this browser tab.',
      ),
    ),
  );
}

interface CuratorState {
  library: LibrarySnapshot;
  genres: Record<string, string[]>;
  keys: Record<string, TrackKey | null>;
  notes: string[];
  genreProgress: string;
  keyProgress: string;
  created: Record<string, CreatedEntry>;
}

/** A created playlist and the track list it was created from. */
type CreatedEntry = CreatedPlaylist & { signature: string };

async function showCurator(auth: SpotifyAuth, forceReload = false) {
  const current = nextGeneration();
  const signal = lookups.signal;
  const client = new SpotifyClient({ getToken: (force) => auth.getAccessToken(force) });
  const status = h('p', { class: 'muted' }, 'Connecting to Spotify…');
  show(h('section', { class: 'panel center' }, h('h1', {}, 'Reading your library'), status));

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
        retryButton(() => showCurator(auth, forceReload)),
      ),
    );
    return;
  }

  if (current !== generation) return;
  const state: CuratorState = {
    library,
    genres: cache.get<Record<string, string[]>>('genres') ?? {},
    keys: cache.get<Record<string, TrackKey | null>>('keys') ?? {},
    notes: [],
    genreProgress: '',
    keyProgress: '',
    created: cache.get<Record<string, CreatedEntry>>('created') ?? {},
  };

  // Key lookups send track IDs to ReccoBeats, so they only start when the owner asks.
  const findKeys = () => {
    state.keyProgress = 'Looking up musical keys (ReccoBeats)…';
    view.render();
    void loadKeys(
      new ReccoBeatsClient(),
      library.liked,
      cache,
      (done, total) => {
        state.keyProgress = `Looking up musical keys (ReccoBeats)… ${done} / ${total}`;
        view.renderProgress();
      },
      signal,
    ).then((result) => {
      if (signal.aborted) return;
      state.keys = result.data;
      state.keyProgress = '';
      if (result.error) state.notes.push(`Musical key lookup stopped early (${result.error}); key playlists use what loaded.`);
      view.render();
    });
  };

  const view = createCuratorView(auth, client, state, () => current === generation, findKeys);
  view.render();

  // Re-curate when genres finish so genre playlists appear.
  const result = await loadGenres(
    client,
    library.liked,
    cache,
    (done, total) => {
      state.genreProgress = `Looking up artist genres… ${done} / ${total}`;
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

function retryButton(onClick: () => void): HTMLElement {
  const button = h('button', { type: 'button' }, 'Try again');
  button.addEventListener('click', onClick);
  return button;
}

function createCuratorView(
  auth: SpotifyAuth,
  client: SpotifyClient,
  state: CuratorState,
  isCurrent: () => boolean,
  onFindKeys: () => void,
) {
  const progress = h('div', { class: 'progress muted' });

  const renderProgress = () => {
    if (!isCurrent()) return;
    const lines = [state.genreProgress, state.keyProgress].filter(Boolean);
    progress.replaceChildren(...lines.map((line) => h('div', {}, line)));
  };

  const render = () => {
    if (!isCurrent()) return;
    // Keep expanded track lists open across re-renders.
    const open = new Set(
      [...app.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.dataset.key ?? ''),
    );
    const result = curate(state.library.liked, state.library.history, {
      now: new Date(),
      artistGenres: state.genres,
      trackKeys: state.keys,
    });
    renderProgress();
    show(
      header(auth, state, result, progress, onFindKeys),
      h('h2', { class: 'section-title' }, `${result.playlists.length} suggested playlists`),
      result.playlists.length === 0
        ? h('p', { class: 'muted' }, 'Not enough liked songs or listening history to suggest playlists yet.')
        : h('div', { class: 'grid' }, ...result.playlists.map((p) => playlistCard(client, state, p, open.has(p.key)))),
    );
  };

  return { render, renderProgress };
}

function header(
  auth: SpotifyAuth,
  state: CuratorState,
  result: CurationResult,
  progress: HTMLElement,
  onFindKeys: () => void,
): HTMLElement {
  const { profile, fetchedAt } = state.library;
  const avatar = profile.imageUrl
    ? h('img', { class: 'avatar', src: profile.imageUrl, alt: '' })
    : h('div', { class: 'avatar', 'aria-hidden': 'true' }, profile.displayName.slice(0, 1).toUpperCase());

  const refresh = h('button', { type: 'button', title: 'Refetch Liked Songs and listening history' }, 'Refresh data');
  // Refetches likes and listening history; genre and key lookups stay cached and
  // only newly liked tracks' artists (and, on request, keys) are looked up.
  refresh.addEventListener('click', () => {
    cache.set('created', {});
    void showCurator(auth, true);
  });
  const signOut = h('button', { type: 'button' }, 'Sign out');
  signOut.addEventListener('click', () => {
    nextGeneration();
    cache.clear();
    auth.signOut();
    showSignIn(auth);
  });

  const s = result.stats;
  const stat = (value: number, label: string) => h('li', {}, h('strong', {}, value.toLocaleString()), ` ${label}`);
  const notes = [...state.notes];
  if (!state.genreProgress && s.likedCount > 0 && s.tracksWithGenres === 0) {
    notes.push('Spotify returned no artist genres (the field is deprecated for new apps), so there are no genre playlists.');
  }
  const keysMissing = state.library.liked.some((t) => !(t.id in state.keys));
  if (!state.keyProgress && !keysMissing && s.likedCount > 0 && s.tracksWithKey === 0) {
    notes.push('No musical keys were available from ReccoBeats, so there are no key playlists.');
  }
  let findKeys: HTMLElement | null = null;
  if (!state.keyProgress && keysMissing) {
    const button = h('button', { type: 'button' }, 'Find musical keys');
    button.addEventListener('click', onFindKeys);
    findKeys = h(
      'p',
      { class: 'muted' },
      'Key playlists need musical keys from ReccoBeats, a third-party service. ',
      'Finding them sends the Spotify track IDs of your liked songs to ReccoBeats. ',
      button,
    );
  }

  return h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'profile' },
      avatar,
      h(
        'div',
        { class: 'who' },
        h('div', { class: 'muted' }, 'Curating the Liked Songs of'),
        h('h1', {}, profile.displayName),
        profile.profileUrl &&
          h('a', { href: profile.profileUrl, target: '_blank', rel: 'noopener' }, 'Spotify profile ↗'),
      ),
      h('div', { class: 'actions' }, refresh, signOut),
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
    h('div', { class: 'muted' }, `Library fetched ${new Date(fetchedAt).toLocaleString()}.`),
    progress,
    findKeys,
    notes.length > 0 && h('ul', { class: 'notes' }, ...notes.map((n) => h('li', {}, n))),
  );
}

const KIND_LABEL: Record<CuratedPlaylist['kind'], string> = {
  favorites: 'Favorites',
  rediscover: 'Rediscover',
  'best-of-albums': 'Album thinning',
  genre: 'Genre',
  key: 'Musical key',
  era: 'Decade',
};

function playlistCard(client: SpotifyClient, state: CuratorState, p: CuratedPlaylist, open: boolean): HTMLElement {
  const minutes = Math.round(p.tracks.reduce((sum, t) => sum + t.durationMs, 0) / 60_000);
  const duration = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  const rest = p.tracks.slice(PREVIEW_COUNT);
  const details = rest.length > 0 ? (h('details', { 'data-key': p.key }) as HTMLDetailsElement) : null;
  if (details) {
    details.open = open;
    details.append(h('summary', {}, `Show all ${p.tracks.length} tracks`), trackList(rest));
  }

  return h(
    'article',
    { class: 'card' },
    h('div', {}, h('div', { class: 'badge' }, KIND_LABEL[p.kind]), h('h3', {}, p.name)),
    h('div', { class: 'meta' }, `${p.tracks.length} tracks · ${duration}`),
    h('p', { class: 'reason' }, p.reason),
    trackList(p.tracks.slice(0, PREVIEW_COUNT)),
    details,
    createControls(client, state, p),
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

function createControls(client: SpotifyClient, state: CuratorState, p: CuratedPlaylist): HTMLElement {
  const box = h('div', { class: 'create' });
  const signature = trackSignature(p);
  const created = state.created[p.key];
  if (created?.signature === signature) {
    box.append(...openLinks(created));
    return box;
  }

  const button = h('button', { class: 'primary', type: 'button' }, 'Create in Spotify') as HTMLButtonElement;
  const status = h('span', { class: 'status' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.className = 'status';
    status.textContent = 'Creating playlist…';
    try {
      const playlist = await client.createPlaylist(
        p.name,
        playlistDescription(p),
        p.tracks.map((t) => t.uri),
        (added, total) => (status.textContent = `Adding tracks… ${added} / ${total}`),
      );
      state.created[p.key] = { ...playlist, signature };
      cache.set('created', state.created);
      box.replaceChildren(...openLinks(playlist));
    } catch (err) {
      button.disabled = false;
      status.className = 'status error';
      status.textContent = `Could not create the playlist: ${errorText(err)}`;
    }
  });
  box.append(button, status);
  return box;
}

function openLinks(playlist: CreatedPlaylist): HTMLElement[] {
  return [
    h('a', { class: 'button primary', href: playlist.url, target: '_blank', rel: 'noopener' }, 'Open in Spotify ↗'),
    h('a', { class: 'button', href: playlist.uri }, 'Open in app'),
    h('span', { class: 'status' }, 'Created as a private playlist.'),
  ];
}

function playlistDescription(p: CuratedPlaylist): string {
  const text = `${p.reason} Curated from Liked Songs.`.replace(/\s+/g, ' ');
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 1)}…`;
}

void start();
