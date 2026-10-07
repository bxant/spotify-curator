// Hash routes for the page, so back/forward and reload work without a server:
//   #/                            the recommendations, sorted and filtered as the owner left them
//   #/?sort=decade&genre=rock     (sort and filters live in the query so they survive a reload)
//   #/playlist/<key>              one recommended playlist on its own page
//   #/musicians                   the Musicians Corner: key playlists to play along to
//   #/musicians?easy=1            … only those in easy guitar keys
//   #/musicians/playlist/<key>    one of them on its own page, with chords and play links
// Pure: no DOM or history access here.

import { KIND_ORDER, type BrowseCriteria, type SortOrder } from './browse';
import type { PlaylistKind } from './types';

export type Route =
  | { name: 'home'; criteria: BrowseCriteria }
  | { name: 'playlist'; key: string }
  | { name: 'musicians'; easy: boolean }
  | { name: 'musicians-playlist'; key: string; easy: boolean };

export const SORT_ORDERS: readonly SortOrder[] = ['recommended', 'type', 'decade', 'genre', 'key', 'artist', 'tracks'];

const PLAYLIST_PREFIX = '#/playlist/';
const MUSICIANS = '#/musicians';
const MUSICIANS_PLAYLIST_PREFIX = '#/musicians/playlist/';

export function parseRoute(hash: string): Route {
  if (hash.startsWith(MUSICIANS_PLAYLIST_PREFIX)) {
    const [path, query = ''] = hash.slice(MUSICIANS_PLAYLIST_PREFIX.length).split('?');
    const key = safeDecode(path);
    if (key) return { name: 'musicians-playlist', key, easy: easyFromQuery(query) };
  }
  if (hash === MUSICIANS || hash.startsWith(`${MUSICIANS}?`)) {
    return { name: 'musicians', easy: easyFromQuery(hash.slice(MUSICIANS.length + 1)) };
  }
  if (hash.startsWith(PLAYLIST_PREFIX)) {
    const key = safeDecode(hash.slice(PLAYLIST_PREFIX.length));
    if (key) return { name: 'playlist', key };
  }
  const query = hash.startsWith('#/?') ? hash.slice(3) : '';
  return { name: 'home', criteria: criteriaFromQuery(new URLSearchParams(query)) };
}

export function formatRoute(route: Route): string {
  if (route.name === 'playlist') return PLAYLIST_PREFIX + encodeURIComponent(route.key);
  if (route.name === 'musicians') return MUSICIANS + easyQuery(route.easy);
  if (route.name === 'musicians-playlist') return MUSICIANS_PLAYLIST_PREFIX + encodeURIComponent(route.key) + easyQuery(route.easy);
  const query = criteriaToQuery(route.criteria).toString();
  return query ? `#/?${query}` : '#/';
}

export function playlistHref(key: string): string {
  return formatRoute({ name: 'playlist', key });
}

export function homeHref(criteria: BrowseCriteria): string {
  return formatRoute({ name: 'home', criteria });
}

export function musiciansHref(easy: boolean): string {
  return formatRoute({ name: 'musicians', easy });
}

export function musiciansPlaylistHref(key: string, easy: boolean): string {
  return formatRoute({ name: 'musicians-playlist', key, easy });
}

/** The page a page's Back button returns to. */
export function parentRoute(route: Route, criteria: BrowseCriteria): Route | null {
  if (route.name === 'playlist') return { name: 'home', criteria };
  if (route.name === 'musicians-playlist') return { name: 'musicians', easy: route.easy };
  return null;
}

/** Whether a route belongs to the Musicians Corner. */
export function isMusiciansRoute(route: Route): boolean {
  return route.name === 'musicians' || route.name === 'musicians-playlist';
}

function easyQuery(easy: boolean): string {
  return easy ? '?easy=1' : '';
}

function easyFromQuery(query: string): boolean {
  return new URLSearchParams(query).get('easy') === '1';
}

/** Only set, valid criteria are written, in a fixed order, so equal criteria give equal URLs. */
function criteriaToQuery(c: BrowseCriteria): URLSearchParams {
  const q = new URLSearchParams();
  if (c.sort !== 'recommended') q.set('sort', c.sort);
  if (c.kind) q.set('type', c.kind);
  if (c.decade != null) q.set('decade', String(c.decade));
  if (c.genre) q.set('genre', c.genre);
  if (c.key) q.set('key', c.key);
  if (c.artist) q.set('artist', c.artist);
  if (c.minTracks) q.set('size', String(c.minTracks));
  return q;
}

/** Unknown or malformed values are ignored rather than trusted. */
function criteriaFromQuery(q: URLSearchParams): BrowseCriteria {
  const c: BrowseCriteria = { sort: 'recommended' };
  const sort = q.get('sort');
  if (sort && (SORT_ORDERS as readonly string[]).includes(sort)) c.sort = sort as SortOrder;
  const kind = q.get('type');
  if (kind && (KIND_ORDER as readonly string[]).includes(kind)) c.kind = kind as PlaylistKind;
  const decade = q.get('decade');
  if (decade && /^\d{4}$/.test(decade)) c.decade = Number(decade);
  const genre = q.get('genre');
  if (genre) c.genre = genre;
  const key = q.get('key');
  if (key && /^\d{1,2}:[01]$/.test(key)) c.key = key;
  const artist = q.get('artist');
  if (artist) c.artist = artist;
  const size = q.get('size');
  if (size && /^[1-9]\d{0,3}$/.test(size)) c.minTracks = Number(size);
  return c;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}
