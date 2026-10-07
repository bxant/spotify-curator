// Hash routes for the page, so back/forward and reload work without a server:
//   #/                            the recommendations, sorted and filtered as the owner left them
//   #/?sort=decade&genre=rock     (sort and filters live in the query so they survive a reload)
//   #/playlist/<key>              one recommended playlist (or part of one) on its own page
// Pure: no DOM or history access here.

import { KIND_ORDER, type BrowseCriteria, type SortOrder } from './browse';
import { PART_SIZE } from './parts';
import type { PlaylistKind } from './types';

export type Route = { name: 'home'; criteria: BrowseCriteria } | { name: 'playlist'; key: string };

export const SORT_ORDERS: readonly SortOrder[] = ['recommended', 'type', 'decade', 'genre', 'key', 'artist', 'tracks'];

const PLAYLIST_PREFIX = '#/playlist/';

export function parseRoute(hash: string): Route {
  if (hash.startsWith(PLAYLIST_PREFIX)) {
    const key = safeDecode(hash.slice(PLAYLIST_PREFIX.length));
    if (key) return { name: 'playlist', key };
  }
  const query = hash.startsWith('#/?') ? hash.slice(3) : '';
  return { name: 'home', criteria: criteriaFromQuery(new URLSearchParams(query)) };
}

export function formatRoute(route: Route): string {
  if (route.name === 'playlist') return PLAYLIST_PREFIX + encodeURIComponent(route.key);
  const query = criteriaToQuery(route.criteria).toString();
  return query ? `#/?${query}` : '#/';
}

export function playlistHref(key: string): string {
  return formatRoute({ name: 'playlist', key });
}

export function homeHref(criteria: BrowseCriteria): string {
  return formatRoute({ name: 'home', criteria });
}

/** The page a page's Back button returns to. */
export function parentRoute(route: Route, criteria: BrowseCriteria): Route | null {
  return route.name === 'playlist' ? { name: 'home', criteria } : null;
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
  if (size && /^[1-9]\d?$/.test(size) && Number(size) <= PART_SIZE) c.minTracks = Number(size);
  return c;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}
