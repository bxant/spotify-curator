// Pure curation logic: turns Liked Songs plus listening history into playlist
// suggestions. No network, no DOM, no clock reads; everything it needs is passed in,
// so it can be unit tested with fixture data.
//
// Spotify exposes no per-track play counts, so "played" is approximated from the
// user's top tracks (three time ranges) and recently played tracks. A liked track
// that appears in neither has no play signal.

import {
  TIME_RANGES,
  type CuratedPlaylist,
  type LikedTrack,
  type ListeningHistory,
  type PlayedTrackRef,
  type TimeRange,
  type TrackKey,
} from './types';

export interface CurationOptions {
  /** Reference time for age-based rules (e.g. "liked more than 90 days ago"). */
  now: Date;
  /** Genres per artist ID from Spotify. Artists missing here (or with []) have no known genre. */
  artistGenres?: Record<string, string[]>;
  /** Extra genres per artist ID from Wikidata and MusicBrainz; merged with Spotify's. */
  openGenres?: Record<string, string[]>;
  /** Musical key per track ID; missing or null means unknown. */
  trackKeys?: Record<string, TrackKey | null>;
  /**
   * 0 is the default set. Any other number curates an alternative set from the same
   * library: different genre, key and artist picks where there are more candidates than
   * fit, and a different (seeded, so still deterministic) selection and order of tracks.
   */
  variant?: number;
  /**
   * Suggestion keys to leave out, e.g. ones already saved in Spotify. Artist, genre and
   * key picks fill up with the next candidates instead, so fresh suggestions take their place.
   */
  exclude?: ReadonlySet<string>;
}

export interface CurationStats {
  likedCount: number;
  /** Liked tracks that appear in top tracks or recently played. */
  withPlaySignal: number;
  /** Albums that look liked in bulk (most of the album liked in one sitting). */
  stackedAlbums: number;
  /** Liked tracks that came in through those bulk album likes. */
  stackedTracks: number;
  /** Liked tracks with at least one known artist genre. */
  tracksWithGenres: number;
  /** Liked tracks with a known musical key. */
  tracksWithKey: number;
}

export interface CurationResult {
  playlists: CuratedPlaylist[];
  stats: CurationStats;
}

export const LIMITS = {
  /** Largest suggested playlist, except best-of-albums which is already thinned. */
  maxTracks: 100,
  /** Rediscover is a listening session, not an archive. */
  rediscoverTracks: 50,
  /** Smallest playlist worth suggesting for favorites / rediscover / best-of. */
  minTracks: 5,
  /** Smallest genre or era bucket worth a playlist. */
  minBucketTracks: 15,
  maxGenrePlaylists: 8,
  maxKeyPlaylists: 6,
  maxArtistPlaylists: 6,
  /** Smallest number of (album-thinned) liked songs by an artist worth a playlist. */
  minArtistTracks: 8,
  artistTracks: 50,
  /** Genre playlists sharing this share of tracks with an earlier one are dropped. */
  genreOverlap: 0.7,
  perArtistRediscover: 2,
  perArtistBucket: 4,
  /** Only songs liked at least this long ago count as forgotten. */
  rediscoverMinAgeDays: 90,
  /** Album likes within this window count as one bulk "like the whole album". */
  bulkWindowMs: 60 * 60 * 1000,
  bulkMinTracks: 4,
  bulkMinAlbumShare: 0.4,
} as const;

const RANGE_WEIGHT: Record<TimeRange, number> = {
  short_term: 3,
  medium_term: 2,
  long_term: 1.5,
};
const RECENT_PLAY_WEIGHT = 1;
const RECENT_PLAY_CAP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function curate(
  liked: LikedTrack[],
  history: ListeningHistory,
  options: CurationOptions,
): CurationResult {
  const tracks = dedupeById(liked);
  const scores = playScores(tracks, history);
  const stacks = detectAlbumStacks(tracks);
  const thinned = thinAlbumStacks(tracks, stacks, scores);
  const openGenres = options.openGenres;
  const genres = mergeGenres(options.artistGenres ?? {}, openGenres ?? {});
  const genreSource = openGenres && Object.keys(openGenres).length > 0 ? 'on Spotify, Wikidata or MusicBrainz' : '';
  const keys = options.trackKeys ?? {};
  const mix = new Mix(options.variant ?? 0);
  const exclude = options.exclude ?? new Set<string>();

  const playlists = [
    favoritesPlaylist(tracks, scores, mix),
    rediscoverPlaylist(tracks, stacks, scores, options.now, mix),
    bestOfAlbumsPlaylist(stacks, scores, mix),
    ...artistPlaylists(thinned, history, scores, mix, exclude),
    ...genrePlaylists(thinned, genres, scores, mix, genreSource, exclude),
    ...keyPlaylists(thinned, keys, scores, mix, exclude),
    ...eraPlaylists(thinned, scores, mix),
  ].filter((p): p is CuratedPlaylist => p !== null && !exclude.has(p.key));

  let stackedTracks = 0;
  for (const stack of stacks.values()) stackedTracks += stack.bulk.length;

  return {
    playlists,
    stats: {
      likedCount: tracks.length,
      withPlaySignal: scores.size,
      stackedAlbums: stacks.size,
      stackedTracks,
      tracksWithGenres: tracks.filter((t) => trackGenres(t, genres).size > 0).length,
      tracksWithKey: tracks.filter((t) => keys[t.id]).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Play signal

/** Fallback identity for relinked tracks whose ID differs between endpoints. */
export function trackKey(name: string, primaryArtistId: string | undefined): string {
  return `${name.trim().toLowerCase().replace(/\s+/g, ' ')}|${primaryArtistId ?? ''}`;
}

/**
 * Scores liked tracks by how much listening evidence exists for them. Only tracks
 * with evidence appear in the returned map, so `scores.has(id)` means "played".
 */
export function playScores(liked: LikedTrack[], history: ListeningHistory): Map<string, number> {
  const byId = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const t of liked) {
    byId.set(t.id, t.id);
    const key = trackKey(t.name, t.artists[0]?.id);
    if (!byKey.has(key)) byKey.set(key, t.id);
  }
  const resolve = (ref: PlayedTrackRef): string | undefined =>
    byId.get(ref.id) ?? byKey.get(trackKey(ref.name, ref.artistIds[0]));

  const scores = new Map<string, number>();
  const add = (id: string, amount: number) => scores.set(id, (scores.get(id) ?? 0) + amount);

  for (const range of TIME_RANGES) {
    const top = history.topTracks[range] ?? [];
    top.forEach((ref, rank) => {
      const id = resolve(ref);
      // Higher ranks earn up to double the range weight.
      if (id) add(id, RANGE_WEIGHT[range] * (1 + (top.length - rank) / top.length));
    });
  }

  const recentCounts = new Map<string, number>();
  for (const ref of history.recentlyPlayed) {
    const id = resolve(ref);
    if (id) recentCounts.set(id, (recentCounts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of recentCounts) {
    add(id, RECENT_PLAY_WEIGHT * Math.min(count, RECENT_PLAY_CAP));
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Album stacks

export interface AlbumStack {
  albumId: string;
  /** Tracks liked together in one bulk "like the whole album" sitting. */
  bulk: LikedTrack[];
  /** Tracks from the same album liked on their own, before or after the bulk like. */
  separate: LikedTrack[];
  /** Time of the latest add in the bulk sitting (ms since epoch). */
  bulkAddedAt: number;
}

/**
 * Finds albums that were liked (nearly) whole: at least `bulkMinTracks` tracks,
 * covering at least `bulkMinAlbumShare` of the album, added within `bulkWindowMs`.
 */
export function detectAlbumStacks(liked: LikedTrack[]): Map<string, AlbumStack> {
  const byAlbum = groupBy(liked, (t) => t.album.id);
  const stacks = new Map<string, AlbumStack>();

  for (const [albumId, albumTracks] of byAlbum) {
    if (albumTracks.length < LIMITS.bulkMinTracks) continue;
    const sorted = [...albumTracks].sort((a, b) => time(a.addedAt) - time(b.addedAt));

    // Largest group of adds that fits in the bulk window (two-pointer sweep).
    let bestStart = 0;
    let bestEnd = 0;
    for (let start = 0, end = 0; end < sorted.length; end++) {
      while (time(sorted[end].addedAt) - time(sorted[start].addedAt) > LIMITS.bulkWindowMs) start++;
      if (end - start > bestEnd - bestStart) {
        bestStart = start;
        bestEnd = end;
      }
    }
    const bulk = sorted.slice(bestStart, bestEnd + 1);
    const total = Math.max(albumTracks[0].album.totalTracks, albumTracks.length);
    if (bulk.length < LIMITS.bulkMinTracks || bulk.length < total * LIMITS.bulkMinAlbumShare) continue;

    stacks.set(albumId, {
      albumId,
      bulk,
      separate: [...sorted.slice(0, bestStart), ...sorted.slice(bestEnd + 1)],
      bulkAddedAt: time(bulk[bulk.length - 1].addedAt),
    });
  }
  return stacks;
}

/** Tracks from a stacked album that earned their place: played, or liked on their own. */
function albumKeepers(stack: AlbumStack, scores: Map<string, number>): LikedTrack[] {
  return [...stack.bulk.filter((t) => scores.has(t.id)), ...stack.separate].sort(byAlbumOrder);
}

/**
 * The library with bulk album likes thinned: stacked albums contribute only their
 * keepers, or a single stable representative when nothing from them has been played.
 */
export function thinAlbumStacks(
  liked: LikedTrack[],
  stacks: Map<string, AlbumStack>,
  scores: Map<string, number>,
): LikedTrack[] {
  const allowed = new Set<string>();
  for (const stack of stacks.values()) {
    const keepers = albumKeepers(stack, scores);
    const chosen = keepers.length > 0 ? keepers : [stableRepresentative(stack.bulk)];
    for (const t of chosen) allowed.add(t.id);
  }
  return liked.filter((t) => !stacks.has(t.album.id) || allowed.has(t.id));
}

function stableRepresentative(tracks: LikedTrack[]): LikedTrack {
  return tracks.reduce((best, t) => (hash(t.id) < hash(best.id) ? t : best));
}

// ---------------------------------------------------------------------------
// Playlists

function favoritesPlaylist(liked: LikedTrack[], scores: Map<string, number>, mix: Mix): CuratedPlaylist | null {
  const played = mix.byPlays(liked.filter((t) => scores.has(t.id)), scores, 'favorites');
  if (played.length < LIMITS.minTracks) return null;
  const tracks = played.slice(0, LIMITS.maxTracks);
  let reason = `${played.length} of your liked songs show up in your top tracks or recent plays`;
  if (mix.fresh) {
    reason += played.length > tracks.length ? `; a fresh mix of ${tracks.length}, weighted toward the most played.` : ', in a fresh order weighted toward the most played.';
  } else {
    reason += played.length > tracks.length ? `; these are the ${tracks.length} most played.` : ', most played first.';
  }
  return { key: 'favorites', kind: 'favorites', name: 'Real Favorites', reason, tracks };
}

function rediscoverPlaylist(
  liked: LikedTrack[],
  stacks: Map<string, AlbumStack>,
  scores: Map<string, number>,
  now: Date,
  mix: Mix,
): CuratedPlaylist | null {
  const bulkIds = new Set<string>();
  for (const stack of stacks.values()) for (const t of stack.bulk) bulkIds.add(t.id);
  const cutoff = now.getTime() - LIMITS.rediscoverMinAgeDays * DAY_MS;

  // Songs liked one by one (not via a whole-album like) that never show up as played.
  const candidates = liked
    .filter((t) => !scores.has(t.id) && !bulkIds.has(t.id) && time(t.addedAt) <= cutoff)
    .sort((a, b) => time(a.addedAt) - time(b.addedAt));
  const sampled = spreadSample(
    capPerArtist(candidates, LIMITS.perArtistRediscover),
    LIMITS.rediscoverTracks,
    mix.phase('rediscover'),
  );
  const tracks = mix.fresh ? mix.shuffle(sampled, 'rediscover:order') : sampled;
  if (tracks.length < LIMITS.minTracks) return null;
  return {
    key: 'rediscover',
    kind: 'rediscover',
    name: 'Rediscover: Liked, Then Forgotten',
    reason:
      `${candidates.length} songs you liked one by one over ${LIMITS.rediscoverMinAgeDays} days ago never show up ` +
      `in your top tracks or recent plays; ${tracks.length} picked across the years you liked them, ` +
      `at most ${LIMITS.perArtistRediscover} per artist${mix.fresh ? ', shuffled' : ''}.`,
    tracks,
  };
}

function bestOfAlbumsPlaylist(
  stacks: Map<string, AlbumStack>,
  scores: Map<string, number>,
  mix: Mix,
): CuratedPlaylist | null {
  const byRecency = [...stacks.values()].sort((a, b) => b.bulkAddedAt - a.bulkAddedAt);
  // An alternative set plays the same keepers with the albums in a different order.
  const ordered = mix.fresh ? mix.shuffle(byRecency, 'best-of-albums') : byRecency;
  let bulkTracks = 0;
  let albumsWithKeepers = 0;
  const tracks: LikedTrack[] = [];
  for (const stack of ordered) {
    bulkTracks += stack.bulk.length + stack.separate.length;
    const keepers = albumKeepers(stack, scores);
    if (keepers.length > 0) albumsWithKeepers++;
    tracks.push(...keepers);
  }
  if (tracks.length < LIMITS.minTracks) return null;
  return {
    key: 'best-of-albums',
    kind: 'best-of-albums',
    name: 'Best of Each Album',
    reason:
      `You liked ${stacks.size} albums nearly whole (${bulkTracks} liked tracks); this keeps only the ` +
      `${tracks.length} tracks from ${albumsWithKeepers} of them that you actually play or liked on their own` +
      (mix.fresh ? ', albums in a shuffled order.' : '.'),
    tracks,
  };
}

function artistPlaylists(
  thinned: LikedTrack[],
  history: ListeningHistory,
  scores: Map<string, number>,
  mix: Mix,
  exclude: ReadonlySet<string>,
): CuratedPlaylist[] {
  const byArtist = new Map<string, { name: string; tracks: LikedTrack[] }>();
  for (const t of thinned) {
    for (const a of new Map(t.artists.map((x) => [x.id, x])).values()) {
      const entry = byArtist.get(a.id);
      if (entry) entry.tracks.push(t);
      else byArtist.set(a.id, { name: a.name, tracks: [t] });
    }
  }
  const topBonus = new Map<string, number>();
  for (const range of TIME_RANGES) {
    const top = history.topArtists[range] ?? [];
    top.forEach((id, rank) => topBonus.set(id, (topBonus.get(id) ?? 0) + RANGE_WEIGHT[range] * (1 + (top.length - rank) / top.length)));
  }

  const candidates = [...byArtist.entries()]
    .filter(([, e]) => e.tracks.length >= LIMITS.minArtistTracks)
    .map(([id, e]) => {
      let plays = topBonus.get(id) ?? 0;
      for (const t of e.tracks) plays += scores.get(t.id) ?? 0;
      return { id, ...e, plays };
    });
  if (candidates.length === 0) return [];
  // Most-liked and most-played count equally: each is scaled to the library's top artist.
  const maxLiked = Math.max(...candidates.map((c) => c.tracks.length));
  const maxPlays = Math.max(1, ...candidates.map((c) => c.plays));
  const rank = (c: (typeof candidates)[number]) => c.tracks.length / maxLiked + c.plays / maxPlays;
  candidates.sort((a, b) => rank(b) - rank(a) || b.tracks.length - a.tracks.length || a.id.localeCompare(b.id));

  return mix
    .rotate(candidates, LIMITS.maxArtistPlaylists)
    .filter((c) => !exclude.has(`artist:${c.id}`))
    .slice(0, LIMITS.maxArtistPlaylists)
    .map((c) => {
      const key = `artist:${c.id}`;
      const tracks = pickTracks(c.tracks, scores, LIMITS.artistTracks, Infinity, mix, key);
      const played = c.tracks.filter((t) => scores.has(t.id)).length;
      const why = topBonus.has(c.id)
        ? ', one of your top artists'
        : played > 0
          ? `, ${played} of them in your top tracks or recent plays`
          : '';
      return {
        key,
        kind: 'artist' as const,
        name: `Artist: ${c.name}`,
        reason: `${c.tracks.length} of your liked songs are by ${c.name}${why}; ${tracks.length} picked, ${pickedText(mix)}.`,
        tracks,
      };
    });
}

function genrePlaylists(
  thinned: LikedTrack[],
  artistGenres: Record<string, string[]>,
  scores: Map<string, number>,
  mix: Mix,
  source: string,
  exclude: ReadonlySet<string>,
): CuratedPlaylist[] {
  const byGenre = new Map<string, LikedTrack[]>();
  for (const t of thinned) {
    for (const genre of trackGenres(t, artistGenres)) {
      const list = byGenre.get(genre);
      if (list) list.push(t);
      else byGenre.set(genre, [t]);
    }
  }

  const candidates = [...byGenre.entries()]
    .filter(([, list]) => list.length >= LIMITS.minBucketTracks)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const chosen: { ids: Set<string>; playlist: CuratedPlaylist }[] = [];
  // Excluded genres do not use up a slot, but a genre that mostly repeats one still counts as redundant.
  const excluded: Set<string>[] = [];
  for (const [genre, list] of mix.rotate(candidates, LIMITS.maxGenrePlaylists)) {
    if (chosen.length >= LIMITS.maxGenrePlaylists) break;
    const ids = new Set(list.map((t) => t.id));
    const redundant = [...chosen.map((c) => c.ids), ...excluded].some((other) => overlap(ids, other) >= LIMITS.genreOverlap);
    if (redundant) continue;
    const key = `genre:${genre}`;
    if (exclude.has(key)) {
      excluded.push(ids);
      continue;
    }
    const tracks = pickTracks(list, scores, LIMITS.maxTracks, LIMITS.perArtistBucket, mix, key);
    chosen.push({
      ids,
      playlist: {
        key,
        kind: 'genre',
        name: `Genre: ${titleCase(genre)}`,
        reason:
          `${list.length} of your liked songs are by artists tagged "${genre}"${source ? ` ${source}` : ''}; ` +
          `${tracks.length} picked, ${pickedText(mix)}, at most ${LIMITS.perArtistBucket} per artist.`,
        tracks,
      },
    });
  }
  return chosen.map((c) => c.playlist);
}

function keyPlaylists(
  thinned: LikedTrack[],
  trackKeys: Record<string, TrackKey | null>,
  scores: Map<string, number>,
  mix: Mix,
  exclude: ReadonlySet<string>,
): CuratedPlaylist[] {
  const byKey = groupBy(
    thinned.filter((t) => trackKeys[t.id]),
    (t) => {
      const k = trackKeys[t.id] as TrackKey;
      return `${k.key}:${k.mode}`;
    },
  );
  const candidates = [...byKey.entries()]
    .filter(([, list]) => list.length >= LIMITS.minBucketTracks)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  return mix
    .rotate(candidates, LIMITS.maxKeyPlaylists)
    .filter(([id]) => !exclude.has(`key:${id}`))
    .slice(0, LIMITS.maxKeyPlaylists)
    .map(([id, list]) => {
      const k = trackKeys[list[0].id] as TrackKey;
      const name = keyName(k);
      const tracks = pickTracks(list, scores, LIMITS.maxTracks, LIMITS.perArtistBucket, mix, `key:${id}`);
      return {
        key: `key:${id}`,
        kind: 'key' as const,
        name: `Key of ${titleCase(name)}`,
        reason:
          `${list.length} of your liked songs are in ${name} (Camelot ${camelot(k)}), so they blend harmonically; ` +
          `${tracks.length} picked, ${pickedText(mix)}, at most ${LIMITS.perArtistBucket} per artist.`,
        tracks,
      };
    });
}

const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** "A minor", "E♭ major", … */
export function keyName(k: TrackKey): string {
  return `${PITCH_NAMES[k.key]} ${k.mode === 1 ? 'major' : 'minor'}`;
}

/** Camelot wheel code DJs use for harmonic mixing, e.g. C major = 8B, A minor = 8A. */
export function camelot(k: TrackKey): string {
  const major = k.mode === 1 ? k.key : (k.key + 3) % 12; // minor keys share their relative major's number
  return `${((major * 7 + 7) % 12) + 1}${k.mode === 1 ? 'B' : 'A'}`;
}

function eraPlaylists(thinned: LikedTrack[], scores: Map<string, number>, mix: Mix): CuratedPlaylist[] {
  const byDecade = groupBy(
    thinned.filter((t) => releaseYear(t) !== null),
    (t) => String(Math.floor((releaseYear(t) as number) / 10) * 10),
  );
  return [...byDecade.entries()]
    .filter(([, list]) => list.length >= LIMITS.minBucketTracks)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([decade, list]) => {
      const picked = pickTracks(list, scores, LIMITS.maxTracks, LIMITS.perArtistBucket, mix, `era:${decade}`);
      // The default set plays a decade in release order; an alternative set shuffles it.
      const tracks = mix.fresh
        ? mix.shuffle(picked, `era:${decade}:order`)
        : picked.sort((a, b) => a.album.releaseDate.localeCompare(b.album.releaseDate) || byAlbumOrder(a, b));
      return {
        key: `era:${decade}`,
        kind: 'era' as const,
        name: `The ${decade}s`,
        reason:
          `${list.length} of your liked songs were released in the ${decade}s; ` +
          `${tracks.length} picked, ${pickedText(mix)}, at most ${LIMITS.perArtistBucket} per artist, ` +
          (mix.fresh ? 'shuffled.' : 'in release order.'),
        tracks,
      };
    });
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * Picks up to `max` tracks: played tracks by score first, then unplayed tracks spread
 * evenly across when they were liked, never more than `perArtist` per primary artist.
 * An alternative `mix` loosens the play order and shifts which unplayed tracks are sampled.
 */
export function pickTracks(
  tracks: LikedTrack[],
  scores: Map<string, number>,
  max: number,
  perArtist: number,
  mix: Mix = DEFAULT_MIX,
  salt = '',
): LikedTrack[] {
  const played = capPerArtist(mix.byPlays(tracks.filter((t) => scores.has(t.id)), scores, salt), perArtist);
  const picked = played.slice(0, max);
  const counts = countByArtist(picked);
  const unplayed = tracks
    .filter((t) => !scores.has(t.id))
    .sort((a, b) => time(a.addedAt) - time(b.addedAt));
  const eligible = capPerArtist(unplayed, perArtist, counts);
  const sampled = spreadSample(eligible, max - picked.length, mix.phase(salt));
  return [...picked, ...(mix.fresh ? mix.shuffle(sampled, `${salt}:order`) : sampled)];
}

/**
 * Seeded choices for one curated set. Variant 0 is the default set and makes no random
 * choices; other variants derive every choice from the variant number and a per-playlist
 * salt, so an alternative set is different from the default but still reproducible.
 */
export class Mix {
  constructor(readonly variant: number) {}

  get fresh(): boolean {
    return this.variant !== 0;
  }

  /** Played tracks, most played first; an alternative mix weights plays by a random factor. */
  byPlays(tracks: LikedTrack[], scores: Map<string, number>, salt: string): LikedTrack[] {
    const exact = byScore(scores);
    if (!this.fresh) return [...tracks].sort(exact);
    const rand = this.random(salt);
    const weight = new Map(tracks.map((t) => [t.id, (scores.get(t.id) ?? 0) * (0.35 + rand())]));
    return [...tracks].sort((a, b) => (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0) || exact(a, b));
  }

  /** Offset in [0, 1) for spreadSample; 0 for the default set. */
  phase(salt: string): number {
    return this.fresh ? this.random(`${salt}:phase`)() : 0;
  }

  shuffle<T>(items: T[], salt: string): T[] {
    const out = [...items];
    const rand = this.random(salt);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /**
   * Ranked candidates rotated so each variant starts `count` further down the list;
   * with more candidates than fit, an alternative set picks different ones.
   */
  rotate<T>(ranked: T[], count: number): T[] {
    if (ranked.length === 0) return ranked;
    const start = (this.variant * count) % ranked.length;
    return [...ranked.slice(start), ...ranked.slice(0, start)];
  }

  private random(salt: string): () => number {
    // mulberry32, seeded from the variant and the salt.
    let a = hash(`${this.variant}:${salt}`);
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}

const DEFAULT_MIX = new Mix(0);

function pickedText(mix: Mix): string {
  return mix.fresh ? 'a fresh mix, played favorites weighted first' : 'played favorites first';
}

/** Keeps at most `max` tracks per primary artist, preserving order. */
export function capPerArtist(
  tracks: LikedTrack[],
  max: number,
  counts: Map<string, number> = new Map(),
): LikedTrack[] {
  const seen = new Map(counts);
  return tracks.filter((t) => {
    const artist = t.artists[0]?.id ?? '';
    const n = seen.get(artist) ?? 0;
    if (n >= max) return false;
    seen.set(artist, n + 1);
    return true;
  });
}

/**
 * Picks `n` items evenly spaced through the list (the whole list if it is short enough).
 * `phase` in [0, 1) shifts every pick by that fraction of the spacing.
 */
export function spreadSample<T>(items: T[], n: number, phase = 0): T[] {
  if (n <= 0) return [];
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.floor(((i + phase) * items.length) / n)]);
}

/** Unions two per-artist genre maps, lowercasing names so both sources share one genre. */
export function mergeGenres(...sources: Record<string, string[]>[]): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const source of sources) {
    for (const [artist, genres] of Object.entries(source)) {
      const set = new Set(merged[artist] ?? []);
      for (const g of genres) set.add(g.trim().toLowerCase());
      set.delete('');
      merged[artist] = [...set];
    }
  }
  return merged;
}

export function trackGenres(t: LikedTrack, artistGenres: Record<string, string[]>): Set<string> {
  const genres = new Set<string>();
  for (const a of t.artists) for (const g of artistGenres[a.id] ?? []) genres.add(g);
  return genres;
}

export function releaseYear(t: LikedTrack): number | null {
  const year = Number.parseInt(t.album.releaseDate.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}

function countByArtist(tracks: LikedTrack[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tracks) {
    const artist = t.artists[0]?.id ?? '';
    counts.set(artist, (counts.get(artist) ?? 0) + 1);
  }
  return counts;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const id of a) if (b.has(id)) shared++;
  return shared / Math.min(a.size, b.size);
}

function byScore(scores: Map<string, number>) {
  return (a: LikedTrack, b: LikedTrack) =>
    (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || time(b.addedAt) - time(a.addedAt);
}

function byAlbumOrder(a: LikedTrack, b: LikedTrack): number {
  return a.discNumber - b.discNumber || a.trackNumber - b.trackNumber;
}

function dedupeById(tracks: LikedTrack[]): LikedTrack[] {
  const seen = new Set<string>();
  return tracks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function titleCase(s: string): string {
  return s.replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

function time(iso: string): number {
  return Date.parse(iso);
}

/** FNV-1a; only used to pick a stable, arbitrary representative. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Identifies a playlist's exact track list, so a created copy is only matched while it is unchanged. */
export function trackSignature(p: CuratedPlaylist): string {
  return p.tracks.map((t) => t.uri).join(' ');
}

// ---------------------------------------------------------------------------
// Curating a different set

/**
 * The suggestions to show after curating a different set: the kept playlists exactly as
 * they were, then the fresh set minus anything that would duplicate a kept playlist.
 */
export function withKept(kept: CuratedPlaylist[], fresh: CuratedPlaylist[]): CuratedPlaylist[] {
  const keys = new Set(kept.map((p) => p.key));
  const signatures = new Set(kept.map(trackSignature));
  return [...kept, ...fresh.filter((p) => !keys.has(p.key) && !signatures.has(trackSignature(p)))];
}

/** Snapshots the shown playlists the owner chose to keep, in the order they were shown. */
export function keepSelected(shown: CuratedPlaylist[], keepKeys: ReadonlySet<string>): CuratedPlaylist[] {
  return shown.filter((p) => keepKeys.has(p.key));
}
