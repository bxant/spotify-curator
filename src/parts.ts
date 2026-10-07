// Pure splitting of long suggestions into parts. A suggestion is curated with up to
// LIMITS.maxTracks songs, but a card shows and creates at most PART_SIZE of them: the
// rest wait as further parts ("Rock - Part 2", songs 26-50, …) that "More like this"
// reveals one at a time, each its own playlist with its own key, page, removals,
// saved-in-Spotify match and Create in Spotify. No DOM or network; tested in test/parts.test.ts.

import type { CuratedPlaylist } from './types';

/** Most songs a suggested playlist shows and creates. */
export const PART_SIZE = 25;

/** Key of the part `number` of a series; part 1 keeps the series key, so links and saves from before parts still match. */
export function partKey(series: string, number: number): string {
  return number <= 1 ? series : `${series}|part:${number}`;
}

/** The key of the suggestion a playlist was split from (its own key when it was not split). */
export function seriesKey(p: CuratedPlaylist): string {
  return p.part?.series ?? p.key;
}

/** Splits a suggestion into parts of at most `size` songs; one that fits is returned as it is. */
export function splitParts(p: CuratedPlaylist, size = PART_SIZE): CuratedPlaylist[] {
  if (p.tracks.length <= size) return [p];
  const of = Math.ceil(p.tracks.length / size);
  return Array.from({ length: of }, (_, i) => {
    const number = i + 1;
    const tracks = p.tracks.slice(i * size, (i + 1) * size);
    const part = { series: p.key, number, of };
    if (number === 1) return { ...p, tracks, part };
    const first = i * size + 1;
    return {
      ...p,
      key: partKey(p.key, number),
      name: `${p.name} - Part ${number}`,
      reason: `${p.reason} Part ${number} of ${of}: songs ${first}–${first + tracks.length - 1}.`,
      tracks,
      part,
    };
  });
}

export interface ShownParts {
  /** The parts on show, series in curated order and each series' parts in order. */
  shown: CuratedPlaylist[];
  /** For the last part shown of a series with more to come: the next part and how many are left. */
  more: Map<string, { next: CuratedPlaylist; left: number }>;
  /** Series all of whose parts are excluded, so a different suggestion can take their place. */
  used: Set<string>;
}

/**
 * Which parts of each suggestion to show. Excluded parts (e.g. already saved in Spotify)
 * are skipped, so the next part takes their place; of the rest, the first
 * `revealed[series]` (default 1) are shown and the others wait for "More like this".
 */
export function showParts(
  series: CuratedPlaylist[],
  revealed: Readonly<Record<string, number>>,
  exclude: ReadonlySet<string> = new Set(),
): ShownParts {
  const shown: CuratedPlaylist[] = [];
  const more = new Map<string, { next: CuratedPlaylist; left: number }>();
  const used = new Set<string>();
  for (const p of series) {
    const open = splitParts(p).filter((part) => !exclude.has(part.key));
    if (open.length === 0) {
      used.add(p.key);
      continue;
    }
    const count = Math.max(1, Math.floor(revealed[p.key] ?? 1));
    const visible = open.slice(0, count);
    shown.push(...visible);
    const rest = open.slice(count);
    if (rest.length > 0) more.set(visible[visible.length - 1].key, { next: rest[0], left: rest.length });
  }
  return { shown, more, used };
}
