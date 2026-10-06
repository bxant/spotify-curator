// Pure "Build your own" playlist logic: the owner picks genres, decades, keys and
// artists (any combination, each optional) and a track count, and gets a playlist of
// liked songs matching all of the picked kinds (any value within a kind). No network,
// no DOM, no clock reads; "Try again" passes a new seed plus the earlier picks so the
// next selection prefers songs not picked yet.

import { camelotOrder, keyFacet, parseKey } from './browse';
import { keyName, releaseYear, seededRandom, titleCase, trackGenres } from './curate';
import type { CuratedPlaylist, LikedTrack, TrackKey } from './types';

export interface BuildCriteria {
  /** Any of these genres (lowercase, as `mergeGenres` keeps them); empty means any genre. */
  genres: string[];
  /** Any of these release decades, e.g. 1990; empty means any. */
  decades: number[];
  /** Any of these keys as "<pitch class>:<mode>" (e.g. "9:0"); empty means any. */
  keys: string[];
  /** Songs by or featuring any of these artist IDs; empty means any. */
  artists: string[];
  /** How many songs to pick. */
  count: number;
}

export const BUILD_LIMITS = {
  minCount: 5,
  maxCount: 100,
  defaultCount: 25,
  /** A played song is at most this many times as likely to be picked as an unplayed one. */
  maxPlayWeight: 3,
} as const;

/** Playlist key of the built playlist; there is one at a time, at `#/playlist/custom`. */
export const BUILT_KEY = 'custom';

export interface BuildInputs {
  /** Genres per artist ID (see `mergeGenres`). */
  artistGenres: Record<string, string[]>;
  /** Musical key per track ID; missing or null means unknown. */
  trackKeys: Record<string, TrackKey | null>;
  /** Play scores (see `playScores`); played songs are more likely picks. */
  scores: Map<string, number>;
}

export interface BuildRoll {
  /** Different seeds pick different selections from the same matches. */
  seed: number;
  /**
   * Track IDs of earlier picks for the same criteria, oldest first. Songs never picked come
   * first, then the ones picked longest ago, so each try differs from the last when it can.
   */
  previous?: readonly (readonly string[])[];
}

export interface BuildResult {
  playlist: CuratedPlaylist;
  /** Liked songs matching the criteria; fewer than `requested` means every match is in. */
  matched: number;
  requested: number;
}

export interface BuildChoices {
  /** Most songs first. */
  genres: { id: string; count: number }[];
  /** Oldest first. */
  decades: { id: number; count: number }[];
  /** Camelot order. */
  keys: { id: string; label: string; count: number }[];
  /** Most songs first; featured credits count. */
  artists: { id: string; label: string; count: number }[];
}

export function emptyCriteria(): BuildCriteria {
  return { genres: [], decades: [], keys: [], artists: [], count: BUILD_LIMITS.defaultCount };
}

/** A whole number within the allowed range; anything unreadable is the default. */
export function clampCount(n: number): number {
  if (!Number.isFinite(n)) return BUILD_LIMITS.defaultCount;
  return Math.min(BUILD_LIMITS.maxCount, Math.max(BUILD_LIMITS.minCount, Math.round(n)));
}

/** Deduplicated, sorted choices and a clamped count, so equal choices compare equal. */
export function normalizeCriteria(c: BuildCriteria): BuildCriteria {
  const unique = <T>(values: T[], cmp: (a: T, b: T) => number) => [...new Set(values)].sort(cmp);
  const text = (a: string, b: string) => a.localeCompare(b);
  return {
    genres: unique(c.genres, text),
    decades: unique(c.decades, (a, b) => a - b),
    keys: unique(c.keys, (a, b) => camelotOrder(a) - camelotOrder(b)),
    artists: unique(c.artists, text),
    count: clampCount(c.count),
  };
}

/** Identifies the choices regardless of selection order, e.g. to tell a retry from a new build. */
export function criteriaId(c: BuildCriteria): string {
  return JSON.stringify(normalizeCriteria(c));
}

export function matchesCriteria(t: LikedTrack, c: BuildCriteria, inputs: Omit<BuildInputs, 'scores'>): boolean {
  if (c.genres.length > 0) {
    const genres = trackGenres(t, inputs.artistGenres);
    if (!c.genres.some((g) => genres.has(g))) return false;
  }
  if (c.decades.length > 0) {
    const year = releaseYear(t);
    if (year === null || !c.decades.includes(decadeOf(year))) return false;
  }
  if (c.keys.length > 0) {
    const k = inputs.trackKeys[t.id];
    if (!k || !c.keys.includes(keyId(k))) return false;
  }
  if (c.artists.length > 0 && !t.artists.some((a) => c.artists.includes(a.id))) return false;
  return true;
}

/** Liked songs (each once) matching every kind of choice made. */
export function matchingTracks(liked: LikedTrack[], c: BuildCriteria, inputs: Omit<BuildInputs, 'scores'>): LikedTrack[] {
  const seen = new Set<string>();
  return liked.filter((t) => !seen.has(t.id) && (seen.add(t.id), matchesCriteria(t, c, inputs)));
}

/**
 * Builds a playlist of up to `count` matching liked songs, or null when nothing matches.
 * Picks are random (seeded by `roll.seed`) with played songs more likely, spread across
 * artists: each pick goes to the artist with the fewest picks so far.
 */
export function buildPlaylist(liked: LikedTrack[], criteria: BuildCriteria, inputs: BuildInputs, roll: BuildRoll): BuildResult | null {
  const c = normalizeCriteria(criteria);
  const matches = matchingTracks(liked, c, inputs);
  if (matches.length === 0) return null;
  const tracks = pickSpread(matches, c.count, inputs.scores, roll);
  const names = artistNames(liked);
  return {
    playlist: { key: BUILT_KEY, kind: 'custom', name: buildName(c, names), reason: buildReason(c, names, matches.length, tracks), tracks },
    matched: matches.length,
    requested: c.count,
  };
}

function pickSpread(matches: LikedTrack[], count: number, scores: Map<string, number>, roll: BuildRoll): LikedTrack[] {
  const rand = seededRandom(`build:${roll.seed}`);
  // Weighted random order (Efraimidis–Spirakis): a higher weight tends to come earlier.
  const rank = new Map(matches.map((t) => [t.id, rand() ** (1 / playWeight(scores.get(t.id)))]));
  const byRank = (a: LikedTrack, b: LikedTrack) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) || a.id.localeCompare(b.id);

  // Never picked (-1) first, then by the latest earlier roll that picked the song.
  const lastPicked = new Map<string, number>();
  (roll.previous ?? []).forEach((ids, i) => ids.forEach((id) => lastPicked.set(id, i)));
  const tiers = new Map<number, LikedTrack[]>();
  for (const t of matches) {
    const tier = lastPicked.get(t.id) ?? -1;
    const list = tiers.get(tier);
    if (list) list.push(t);
    else tiers.set(tier, [t]);
  }

  const perArtist = new Map<string, number>();
  const picked: LikedTrack[] = [];
  for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
    const queues = new Map<string, LikedTrack[]>();
    for (const t of [...(tiers.get(tier) as LikedTrack[])].sort(byRank)) {
      const queue = queues.get(primaryArtist(t));
      if (queue) queue.push(t);
      else queues.set(primaryArtist(t), [t]);
    }
    while (picked.length < count && queues.size > 0) {
      // The artist with the fewest picks so far; among those, the best-ranked next song.
      let best: [string, LikedTrack[]] | undefined;
      for (const entry of queues) {
        if (!best) {
          best = entry;
          continue;
        }
        const diff = (perArtist.get(entry[0]) ?? 0) - (perArtist.get(best[0]) ?? 0);
        if (diff < 0 || (diff === 0 && byRank(entry[1][0], best[1][0]) < 0)) best = entry;
      }
      const [artist, queue] = best as [string, LikedTrack[]];
      picked.push(queue.shift() as LikedTrack);
      perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
      if (queue.length === 0) queues.delete(artist);
    }
    if (picked.length >= count) break;
  }
  return picked;
}

function playWeight(score: number | undefined): number {
  return 1 + Math.min(score ?? 0, 2 * (BUILD_LIMITS.maxPlayWeight - 1)) / 2;
}

/** "Your Mix: Rock + Indie · 1990s", or "Your Mix" with no choices. */
export function buildName(c: BuildCriteria, names: Map<string, string>): string {
  const short = (values: string[]) => (values.length <= 2 ? values.join(' + ') : `${values.slice(0, 2).join(', ')} + ${values.length - 2} more`);
  const parts = [
    c.genres.map(titleCase),
    c.decades.map((d) => `${d}s`),
    c.keys.map((id) => keyName(parseKey(id))),
    c.artists.map((id) => names.get(id) ?? id),
  ]
    .filter((values) => values.length > 0)
    .map(short);
  return parts.length > 0 ? `Your Mix: ${parts.join(' · ')}` : 'Your Mix';
}

function buildReason(c: BuildCriteria, names: Map<string, string>, matched: number, tracks: LikedTrack[]): string {
  const conditions = [
    c.genres.length > 0 && `tagged ${or(c.genres)}`,
    c.decades.length > 0 && `from the ${or(c.decades.map((d) => `${d}s`))}`,
    c.keys.length > 0 && `in ${or(c.keys.map((id) => keyName(parseKey(id))))}`,
    c.artists.length > 0 && `by ${or(c.artists.map((id) => names.get(id) ?? id))}`,
  ].filter((s): s is string => !!s);
  const which = conditions.length > 0 ? `${matched} of your liked songs are ${and(conditions)}` : `You have ${matched} liked songs`;
  const artists = new Set(tracks.map(primaryArtist)).size;
  const spread = artists === 1 ? 'all by one artist' : `spread across ${artists} artists`;
  if (matched < c.count) {
    return `${which}, fewer than the ${c.count} you asked for, so all of them are in, ${spread}.`;
  }
  return `${which}; ${tracks.length} picked at random, played favorites more likely, ${spread}.`;
}

/** What the builder can offer: every genre, decade, key and artist in the liked songs, with song counts. */
export function buildChoices(liked: LikedTrack[], inputs: Omit<BuildInputs, 'scores'>): BuildChoices {
  const genres = new Map<string, number>();
  const decades = new Map<number, number>();
  const keys = new Map<string, number>();
  const artists = new Map<string, { label: string; count: number }>();
  const bump = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
  const seen = new Set<string>();
  for (const t of liked) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    for (const g of trackGenres(t, inputs.artistGenres)) bump(genres, g);
    const year = releaseYear(t);
    if (year !== null) bump(decades, decadeOf(year));
    const k = inputs.trackKeys[t.id];
    if (k) bump(keys, keyId(k));
    for (const a of new Map(t.artists.map((x) => [x.id, x])).values()) {
      const entry = artists.get(a.id);
      if (entry) entry.count++;
      else artists.set(a.id, { label: a.name, count: 1 });
    }
  }
  return {
    genres: [...genres.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, count]) => ({ id, count })),
    decades: [...decades.entries()].sort((a, b) => a[0] - b[0]).map(([id, count]) => ({ id, count })),
    keys: [...keys.entries()]
      .sort((a, b) => camelotOrder(a[0]) - camelotOrder(b[0]))
      .map(([id, count]) => ({ id, label: keyFacet(id).label, count })),
    artists: [...artists.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
      .map(([id, { label, count }]) => ({ id, label, count })),
  };
}

function artistNames(liked: LikedTrack[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const t of liked) for (const a of t.artists) if (!names.has(a.id)) names.set(a.id, a.name);
  return names;
}

function primaryArtist(t: LikedTrack): string {
  return t.artists[0]?.id ?? '';
}

function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

function keyId(k: TrackKey): string {
  return `${k.key}:${k.mode}`;
}

function or(values: string[]): string {
  return values.length <= 1 ? values.join('') : `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

function and(values: string[]): string {
  return values.length <= 1 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}
