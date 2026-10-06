// Pure sort and filter logic for the suggested playlists. Each playlist is described by
// facets (decade, genres, keys, artists, size) computed from its tracks and the known
// genres and keys, and the page sorts and filters on those. No DOM or network here.

import { camelot, keyName, releaseYear, trackGenres } from './curate';
import type { CuratedPlaylist, PlaylistKind, TrackKey } from './types';

/** A decade, genre or key describes a playlist when at least this share of its tracks has it. */
export const FACET_SHARE = 0.2;
/** Artists with at least this many tracks in a playlist are listed as featured in it. */
export const ARTIST_MIN_TRACKS = 2;

export interface FacetValue {
  id: string;
  label: string;
}

export interface PlaylistFacets {
  kind: PlaylistKind;
  trackCount: number;
  /** Decade of the median release year, e.g. 1990. */
  decade: number | null;
  /** Decades covering at least FACET_SHARE of the tracks. */
  decades: number[];
  /** Genres covering at least FACET_SHARE of the tracks, the defining genre of a genre playlist first. */
  genres: string[];
  /** Keys ("9:0") covering at least FACET_SHARE of the tracks, the defining key of a key playlist first. */
  keys: FacetValue[];
  /** Featured artists, the playlist's own artist (or its most frequent one) first. */
  artists: FacetValue[];
}

export interface FacetInputs {
  artistGenres: Record<string, string[]>;
  trackKeys: Record<string, TrackKey | null>;
}

export function playlistFacets(p: CuratedPlaylist, inputs: FacetInputs): PlaylistFacets {
  const n = p.tracks.length;
  const [bucketKind, bucketValue] = splitKey(p.key);

  const years = p.tracks.map(releaseYear).filter((y): y is number => y !== null).sort((a, b) => a - b);
  const median = years.length > 0 ? years[Math.floor((years.length - 1) / 2)] : null;
  const decadeCounts = countValues(years.map((y) => String(Math.floor(y / 10) * 10)));
  const decades = sharedValues(decadeCounts, n).map(Number);
  const eraDecade = bucketKind === 'era' ? Number(bucketValue) : null;

  const genreCounts = countValues(p.tracks.flatMap((t) => [...trackGenres(t, inputs.artistGenres)]));
  const genres = pinFirst(sharedValues(genreCounts, n), bucketKind === 'genre' ? bucketValue : null);

  const keyCounts = countValues(
    p.tracks.flatMap((t) => {
      const k = inputs.trackKeys[t.id];
      return k ? [`${k.key}:${k.mode}`] : [];
    }),
  );
  const keys = pinFirst(sharedValues(keyCounts, n), bucketKind === 'key' ? bucketValue : null).map(keyFacet);

  const artistNames = new Map<string, string>();
  const artistCounts = countValues(
    p.tracks.flatMap((t) =>
      [...new Map(t.artists.map((a) => [a.id, a])).values()].map((a) => (artistNames.set(a.id, a.name), a.id)),
    ),
  );
  const featured = [...artistCounts.entries()]
    .filter(([, count]) => count >= ARTIST_MIN_TRACKS)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  const artists = pinFirst(featured, bucketKind === 'artist' ? bucketValue : null).map((id) => ({
    id,
    label: artistNames.get(id) ?? id,
  }));

  return {
    kind: p.kind,
    trackCount: n,
    decade: eraDecade ?? (median === null ? null : Math.floor(median / 10) * 10),
    decades: eraDecade !== null ? pinFirst(decades, eraDecade) : decades,
    genres,
    keys,
    artists,
  };
}

export type SortOrder = 'recommended' | 'type' | 'decade' | 'genre' | 'key' | 'artist' | 'tracks';

export interface BrowseCriteria {
  sort: SortOrder;
  kind?: PlaylistKind | '';
  decade?: number | null;
  genre?: string;
  key?: string;
  artist?: string;
  minTracks?: number;
}

export const KIND_ORDER: readonly PlaylistKind[] = ['favorites', 'rediscover', 'best-of-albums', 'artist', 'genre', 'key', 'era'];

export interface Browsable {
  playlist: CuratedPlaylist;
  facets: PlaylistFacets;
}

/** Filters, then sorts; ties (and "recommended") keep the curated order. */
export function browse(items: Browsable[], c: BrowseCriteria): Browsable[] {
  const matches = items.filter(({ facets: f }) => {
    if (c.kind && f.kind !== c.kind) return false;
    if (c.decade != null && !f.decades.includes(c.decade)) return false;
    if (c.genre && !f.genres.includes(c.genre)) return false;
    if (c.key && !f.keys.some((k) => k.id === c.key)) return false;
    if (c.artist && !f.artists.some((a) => a.id === c.artist)) return false;
    if (c.minTracks && f.trackCount < c.minTracks) return false;
    return true;
  });
  const order = new Map(items.map((item, i) => [item, i]));
  const compare = comparator(c.sort);
  return matches.sort((a, b) => compare(a.facets, b.facets) || (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** The filter choices that match at least one playlist, with how many they match. */
export interface FilterOptions {
  kinds: { id: PlaylistKind; count: number }[];
  decades: { id: number; count: number }[];
  genres: { id: string; count: number }[];
  keys: (FacetValue & { count: number })[];
  artists: (FacetValue & { count: number })[];
}

export function filterOptions(items: Browsable[]): FilterOptions {
  const kinds = new Map<PlaylistKind, number>();
  const decades = new Map<number, number>();
  const genres = new Map<string, number>();
  const keys = new Map<string, FacetValue & { count: number }>();
  const artists = new Map<string, FacetValue & { count: number }>();
  const bump = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const { facets: f } of items) {
    bump(kinds, f.kind);
    for (const d of f.decades) bump(decades, d);
    for (const g of f.genres) bump(genres, g);
    for (const k of f.keys) keys.set(k.id, { ...k, count: (keys.get(k.id)?.count ?? 0) + 1 });
    for (const a of f.artists) artists.set(a.id, { ...a, count: (artists.get(a.id)?.count ?? 0) + 1 });
  }
  return {
    kinds: KIND_ORDER.filter((k) => kinds.has(k)).map((id) => ({ id, count: kinds.get(id) as number })),
    decades: [...decades.entries()].sort((a, b) => a[0] - b[0]).map(([id, count]) => ({ id, count })),
    genres: [...genres.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, count]) => ({ id, count })),
    keys: [...keys.values()].sort((a, b) => camelotOrder(a.id) - camelotOrder(b.id)),
    artists: [...artists.values()].sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function comparator(sort: SortOrder): (a: PlaylistFacets, b: PlaylistFacets) => number {
  switch (sort) {
    case 'type':
      return (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    case 'decade':
      return missingLast((f) => f.decade, (a, b) => a - b);
    case 'genre':
      return missingLast((f) => f.genres[0], (a, b) => a.localeCompare(b));
    case 'key':
      return missingLast((f) => f.keys[0]?.id, (a, b) => camelotOrder(a) - camelotOrder(b));
    case 'artist':
      return missingLast((f) => f.artists[0]?.label, (a, b) => a.localeCompare(b));
    case 'tracks':
      return (a, b) => b.trackCount - a.trackCount;
    case 'recommended':
      return () => 0;
  }
}

function missingLast<T>(get: (f: PlaylistFacets) => T | null | undefined, cmp: (a: T, b: T) => number) {
  return (a: PlaylistFacets, b: PlaylistFacets): number => {
    const x = get(a);
    const y = get(b);
    if (x == null || y == null) return (x == null ? 1 : 0) - (y == null ? 1 : 0);
    return cmp(x, y);
  };
}

/** Position on the Camelot wheel (1A, 1B, 2A, …) so harmonically close keys sort together. */
export function camelotOrder(id: string): number {
  const code = camelot(parseKey(id));
  return Number.parseInt(code, 10) * 2 + (code.endsWith('B') ? 1 : 0);
}

/** "9:0" → { key: 9, mode: 0 }. */
export function parseKey(id: string): TrackKey {
  const [key, mode] = id.split(':').map(Number);
  return { key, mode: mode === 1 ? 1 : 0 };
}

/** A key id ("9:0") with its label, e.g. "A minor (8A)". */
export function keyFacet(id: string): FacetValue {
  const k = parseKey(id);
  return { id, label: `${keyName(k)} (${camelot(k)})` };
}

/** "genre:indie rock" → ["genre", "indie rock"]; keys may themselves contain colons. */
function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

/** Values covering at least FACET_SHARE of `total`, most common first. */
function sharedValues(counts: Map<string, number>, total: number): string[] {
  return [...counts.entries()]
    .filter(([, count]) => total > 0 && count / total >= FACET_SHARE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
}

function pinFirst<T>(values: T[], first: T | null): T[] {
  return first === null || first === '' ? values : [first, ...values.filter((v) => v !== first)];
}
