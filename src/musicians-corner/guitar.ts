// Musicians Corner, pure guitar helpers: capo hints, the "easy guitar keys" filter and the
// outbound play-along links. No network, DOM or clock reads; tested in test/musicians-corner.test.ts.
//
// The app never fetches, scrapes or embeds chord data: "Chords ↗" only opens an Ultimate
// Guitar search in a new tab, and "Play ↗" opens the track on open.spotify.com.

import { keyName } from '../curate';
import type { CuratedPlaylist, LikedTrack, TrackKey } from '../types';

/** A chord shape family a beginner plays in open position, and the key it sounds in without a capo. */
interface OpenShape {
  name: string;
  key: TrackKey;
}

/** Open-position shapes: G, C, D, A, E major and Em, Am, Dm minor. */
export const OPEN_SHAPES: readonly OpenShape[] = [
  { name: 'G', key: { key: 7, mode: 1 } },
  { name: 'C', key: { key: 0, mode: 1 } },
  { name: 'D', key: { key: 2, mode: 1 } },
  { name: 'A', key: { key: 9, mode: 1 } },
  { name: 'E', key: { key: 4, mode: 1 } },
  { name: 'Em', key: { key: 4, mode: 0 } },
  { name: 'Am', key: { key: 9, mode: 0 } },
  { name: 'Dm', key: { key: 2, mode: 0 } },
];

/** Highest capo fret worth suggesting; above it the neck gets cramped. */
export const MAX_CAPO = 7;

export interface CapoHint {
  /** Fret to put the capo on; 0 means no capo. */
  capo: number;
  /** The open shapes to play, e.g. "E" or "Am". */
  shape: string;
}

/**
 * Every way to play a key with open shapes and a capo at most `MAX_CAPO`, lowest fret first.
 * A shape sounds `capo` semitones higher than written, so the capo fret is the distance up
 * from the shape's key to the song's key. Only shapes of the same mode count.
 */
export function capoOptions(k: TrackKey): CapoHint[] {
  return OPEN_SHAPES.filter((s) => s.key.mode === k.mode)
    .map((s) => ({ capo: (k.key - s.key.key + 12) % 12, shape: s.name }))
    .filter((o) => o.capo <= MAX_CAPO)
    .sort((a, b) => a.capo - b.capo);
}

/** The lowest-fret way to play a key with open shapes (every key has one within 4 frets). */
export function capoHint(k: TrackKey): CapoHint {
  return capoOptions(k)[0];
}

/** Playable in open shapes without a capo: G, C, D, A, E major, or E, A, D minor. */
export function isEasyKey(k: TrackKey | null | undefined): boolean {
  return !!k && capoHint(k).capo === 0;
}

/** Short label for a track row or card, e.g. "No capo · G shapes" or "Capo 1 · E shapes". */
export function capoLabel(k: TrackKey): string {
  const { capo, shape } = capoHint(k);
  return `${capo === 0 ? 'No capo' : `Capo ${capo}`} · ${shape} shapes`;
}

/**
 * A sentence spelling the hint out, including the transposition it implies, e.g.
 * "F major: capo on fret 1, then play the chords a semitone lower, as E shapes. Or capo 3 with D shapes."
 */
export function capoAdvice(k: TrackKey): string {
  const [best, ...others] = capoOptions(k);
  const name = keyName(k);
  const main =
    best.capo === 0
      ? `${name}: no capo needed, play it with open ${best.shape} shapes.`
      : `${name}: capo on fret ${best.capo}, then play the chords ${semitones(best.capo)} lower, as ${best.shape} shapes.`;
  // An easy key needs no alternative; for the others, the next-lowest capo is worth knowing.
  const alt = best.capo > 0 ? others[0] : undefined;
  return alt ? `${main} Or capo ${alt.capo} with ${alt.shape} shapes.` : main;
}

function semitones(n: number): string {
  return n === 1 ? 'a semitone' : `${n} semitones`;
}

/** Key playlists from the suggestions, in the order given; with `easyOnly`, only those in an easy key. */
export function keyPlaylists<T extends CuratedPlaylist>(playlists: T[], easyOnly: boolean): T[] {
  return playlists.filter((p) => p.kind === 'key' && (!easyOnly || isEasyKey(playlistKey(p))));
}

/** The key a key playlist is named for, from its stable key ("key:<pitch>:<mode>"); null for other playlists. */
export function playlistKey(p: CuratedPlaylist): TrackKey | null {
  const m = /^key:(\d{1,2}):([01])$/.exec(p.key);
  if (!m) return null;
  const key = Number(m[1]);
  return key < 12 ? { key, mode: Number(m[2]) as 0 | 1 } : null;
}

// ---------------------------------------------------------------------------
// Play-along links (opened in a new tab with rel="noopener noreferrer")

const ULTIMATE_GUITAR_SEARCH = 'https://www.ultimate-guitar.com/search.php';

/**
 * Drops what Spotify adds to a title that would only narrow a chord search:
 * " - Remastered 2011", " - Live", "(feat. …)", "[with …]".
 */
export function searchableTitle(name: string): string {
  return name
    .replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*\b(?:remaster(?:ed)?|version|edit|mono|stereo|live|mix|remix|deluxe|bonus|demo|acoustic)\b.*$/i, '')
    .trim();
}

/** Ultimate Guitar search for a track's chords and tabs: primary artist plus title. */
export function chordsUrl(t: LikedTrack): string {
  const value = [t.artists[0]?.name ?? '', searchableTitle(t.name)].filter(Boolean).join(' ');
  return `${ULTIMATE_GUITAR_SEARCH}?${new URLSearchParams({ search_type: 'title', value })}`;
}

/** The track on the Spotify web player. */
export function playUrl(t: LikedTrack): string {
  return `https://open.spotify.com/track/${encodeURIComponent(t.id)}`;
}
