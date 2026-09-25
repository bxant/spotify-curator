// Compact builders for fixture data used by the curation tests.

import { TIME_RANGES, type LikedTrack, type ListeningHistory, type PlayedTrackRef, type TimeRange } from '../../src/types';

export const NOW = new Date('2026-09-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** ISO timestamp `days` days (plus optional minutes) before NOW. */
export function daysAgo(days: number, minutes = 0): string {
  return new Date(NOW.getTime() - days * DAY + minutes * 60_000).toISOString();
}

export interface TrackSpec {
  id: string;
  artist?: string;
  album?: string;
  albumTracks?: number;
  release?: string;
  addedDaysAgo?: number;
  addedMinutes?: number;
  trackNumber?: number;
  name?: string;
  extraArtists?: string[];
}

export function track(spec: TrackSpec): LikedTrack {
  const artist = spec.artist ?? `artist-${spec.id}`;
  const album = spec.album ?? `album-${spec.id}`;
  return {
    id: spec.id,
    uri: `spotify:track:${spec.id}`,
    name: spec.name ?? `Song ${spec.id}`,
    artists: [artist, ...(spec.extraArtists ?? [])].map((a) => ({ id: a, name: a.toUpperCase() })),
    album: {
      id: album,
      name: `Album ${album}`,
      releaseDate: spec.release ?? '2015-05-01',
      albumType: 'album',
      totalTracks: spec.albumTracks ?? 1,
    },
    durationMs: 200_000,
    discNumber: 1,
    trackNumber: spec.trackNumber ?? 1,
    addedAt: daysAgo(spec.addedDaysAgo ?? 400, spec.addedMinutes ?? 0),
  };
}

/** An album liked whole in one sitting: `count` tracks added a minute apart. */
export function bulkAlbum(album: string, artist: string, count: number, opts: { albumTracks?: number; daysAgo?: number; release?: string } = {}): LikedTrack[] {
  return Array.from({ length: count }, (_, i) =>
    track({
      id: `${album}-t${i + 1}`,
      artist,
      album,
      albumTracks: opts.albumTracks ?? count,
      release: opts.release,
      addedDaysAgo: opts.daysAgo ?? 300,
      addedMinutes: i,
      trackNumber: i + 1,
    }),
  );
}

export function ref(t: LikedTrack | string): PlayedTrackRef {
  if (typeof t === 'string') return { id: t, name: `Song ${t}`, artistIds: [`artist-${t}`] };
  return { id: t.id, name: t.name, artistIds: t.artists.map((a) => a.id) };
}

export function history(parts: Partial<{ top: Partial<Record<TimeRange, PlayedTrackRef[]>>; recent: PlayedTrackRef[]; topArtists: Partial<Record<TimeRange, string[]>> }> = {}): ListeningHistory {
  const topTracks = {} as Record<TimeRange, PlayedTrackRef[]>;
  const topArtists = {} as Record<TimeRange, string[]>;
  for (const range of TIME_RANGES) {
    topTracks[range] = parts.top?.[range] ?? [];
    topArtists[range] = parts.topArtists?.[range] ?? [];
  }
  return { topTracks, topArtists, recentlyPlayed: parts.recent ?? [] };
}

/** In-memory Storage for auth and cache tests. */
export class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
}
