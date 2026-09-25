// Pure matching of suggestions against the playlists already in the user's Spotify
// account, so a suggestion saved in an earlier session is not offered again. No
// network, no DOM: the page passes in the user's own playlists (and, for the few that
// need it, their tracks) and gets back which suggestions are already saved.
//
// A playlist counts as created by this app when its description carries the app's
// tag (or the plain "Curated from Liked Songs." every earlier version wrote). Such a
// playlist matches the suggestion with the same name. Any other playlist, or an app
// playlist that was renamed, only matches when it holds mostly the same tracks.

import { trackKey } from './curate';
import type { CuratedPlaylist, SavedPlaylist, SavedTracks } from './types';

/** Playlist description limit on Spotify. */
export const DESCRIPTION_MAX = 300;
/** Ends the description of every playlist the app creates; `appTag` looks for it. */
export const APP_TAG = 'Curated from Liked Songs by spotify-curator.';
const APP_MARKER = 'spotify-curator';
/** What versions before the tag wrote at the end of every description. */
const LEGACY_MARKER = 'curated from liked songs';
/** Shared tracks, as a share of the larger of the two playlists, for a match by tracks. */
export const TRACK_OVERLAP_MIN = 0.6;

export type AppTag = 'tagged' | 'legacy';

export interface SavedMatch {
  playlist: SavedPlaylist;
  /** `name`: an app playlist with the suggestion's name; `tracks`: mostly the same tracks. */
  by: 'name' | 'tracks';
}

export interface SavedCheck {
  /** Saved playlist per suggestion key, for the suggestions that are already saved. */
  matches: Map<string, SavedMatch>;
  /** Playlists whose tracks would settle a match and are not in `tracks` yet. */
  needTracks: string[];
}

export interface SavedSuggestion {
  playlist: CuratedPlaylist;
  match: SavedMatch;
}

/** The description for a playlist the app creates: the suggestion's reason, then the app tag. */
export function playlistDescription(reason: string): string {
  const text = reason.replace(/\s+/g, ' ').trim();
  const room = DESCRIPTION_MAX - APP_TAG.length - 1;
  return `${text.length <= room ? text : `${text.slice(0, room - 1)}…`} ${APP_TAG}`;
}

/** Whether a description marks a playlist as created by this app, and by which version. */
export function appTag(description: string): AppTag | null {
  const text = decodeEntities(description).toLowerCase();
  if (text.includes(APP_MARKER)) return 'tagged';
  if (text.includes(LEGACY_MARKER)) return 'legacy';
  return null;
}

/** Compares playlist names ignoring case, spacing and Unicode compatibility forms. */
export function normalizeName(name: string): string {
  return decodeEntities(name).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Shared tracks as a share of the larger playlist; a relinked track counts by name and artist. */
export function trackOverlap(p: CuratedPlaylist, saved: SavedTracks): number {
  const size = Math.max(p.tracks.length, saved.ids.length);
  if (size === 0) return 0;
  const ids = new Set(saved.ids);
  const keys = new Set(saved.keys);
  const shared = p.tracks.filter((t) => ids.has(t.id) || keys.has(trackKey(t.name, t.artists[0]?.id))).length;
  return shared / size;
}

/** False when the sizes alone rule out a match by tracks, so its tracks need not be fetched. */
function sizesAllowMatch(p: CuratedPlaylist, trackCount: number | undefined): boolean {
  if (trackCount === undefined) return true;
  const small = Math.min(p.tracks.length, trackCount);
  const large = Math.max(p.tracks.length, trackCount);
  return large > 0 && small / large >= TRACK_OVERLAP_MIN;
}

/**
 * Finds the suggestions already saved among the user's own playlists. An app playlist
 * with the suggestion's name matches outright; otherwise a playlist with the same name,
 * or an app playlist renamed since, matches when at least `TRACK_OVERLAP_MIN` of the
 * tracks are shared. Tracks not in `tracks` yet are listed in `needTracks`.
 */
export function matchSaved(
  suggestions: CuratedPlaylist[],
  saved: SavedPlaylist[],
  tracks: Record<string, SavedTracks>,
): SavedCheck {
  const info = saved.map((playlist) => ({ playlist, name: normalizeName(playlist.name), tag: appTag(playlist.description) }));
  const names = new Set(suggestions.map((p) => normalizeName(p.name)));
  const renamed = info.filter((s) => s.tag && !names.has(s.name));
  const need = new Set<string>();
  const matches = new Map<string, SavedMatch>();

  const byTracks = (p: CuratedPlaylist, candidates: typeof info) => {
    for (const { playlist } of candidates) {
      if (!sizesAllowMatch(p, playlist.trackCount)) continue;
      const t = tracks[playlist.id];
      if (!t) need.add(playlist.id);
      else if (trackOverlap(p, t) >= TRACK_OVERLAP_MIN) return playlist;
    }
    return undefined;
  };

  for (const p of suggestions) {
    const name = normalizeName(p.name);
    const sameName = info.filter((s) => s.name === name);
    const app = sameName.find((s) => s.tag === 'tagged') ?? sameName.find((s) => s.tag === 'legacy');
    if (app) {
      matches.set(p.key, { playlist: app.playlist, by: 'name' });
      continue;
    }
    const hit = byTracks(p, sameName) ?? byTracks(p, renamed);
    if (hit) matches.set(p.key, { playlist: hit, by: 'tracks' });
  }
  return { matches, needTracks: [...need] };
}

/**
 * Curates without the saved suggestions: each round excludes the suggestions found saved
 * so far, so the next candidates take their place, until a round finds nothing new (or
 * `maxRounds` is reached). `findSaved` gets the IDs of saved playlists already matched,
 * which should not match again. Returns the fresh suggestions and the saved ones set aside.
 */
export function setAsideSaved(
  curateExcluding: (exclude: ReadonlySet<string>) => CuratedPlaylist[],
  findSaved: (playlists: CuratedPlaylist[], matched: ReadonlySet<string>) => Map<string, SavedMatch>,
  maxRounds = 4,
): { fresh: CuratedPlaylist[]; saved: SavedSuggestion[] } {
  const saved = new Map<string, SavedSuggestion>();
  const exclude = new Set<string>();
  for (let round = 1; ; round++) {
    const playlists = curateExcluding(exclude);
    const matched = new Set([...saved.values()].map((s) => s.match.playlist.id));
    const matches = findSaved(playlists.filter((p) => !saved.has(p.key)), matched);
    for (const p of playlists) {
      const match = matches.get(p.key);
      if (match) saved.set(p.key, { playlist: p, match });
    }
    const fresh = playlists.filter((p) => !saved.has(p.key));
    if (matches.size === 0 || round >= maxRounds) return { fresh, saved: [...saved.values()] };
    for (const key of saved.keys()) exclude.add(key);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

/** Spotify HTML-escapes some characters in descriptions; undo the common forms. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
    const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}
