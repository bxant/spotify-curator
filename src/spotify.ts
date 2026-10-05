// Thin Spotify Web API client. Only uses endpoints available to Development Mode
// apps after Spotify's February 2026 changes (see README "Spotify API usage").

import {
  TIME_RANGES,
  type AlbumInfo,
  type LikedTrack,
  type ListeningHistory,
  type PlayedTrackRef,
  type TimeRange,
} from './types';
import { defaultSleep, mapWithConcurrency, retryAfterMs } from './http';

export const API_BASE = 'https://api.spotify.com/v1';

/** Spotify's documented maximum page size for the paged endpoints used here. */
const PAGE_LIMIT = 50;
/** Add Items to Playlist accepts at most 100 URIs per request. */
export const ADD_ITEMS_BATCH = 100;
/** Top items only go ~100 deep per time range in practice. */
const TOP_ITEMS_MAX = 100;

export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

/** Spotify asked us to back off for longer than we are willing to wait. */
export class RateLimitError extends SpotifyApiError {
  constructor(readonly retryAfterMs: number) {
    super(429, `Spotify rate limit: asked to wait ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitError';
  }
}

export interface SpotifyClientOptions {
  /** Returns a valid access token; `forceRefresh` is set after a 401. */
  getToken: (forceRefresh?: boolean) => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Longest Retry-After we wait out; longer ones throw RateLimitError. */
  maxRetryAfterMs?: number;
  /** Called whenever the client waits on a 429. */
  onRateLimited?: (waitMs: number) => void;
}

export interface UserProfile {
  id: string;
  displayName: string;
  imageUrl?: string;
  profileUrl?: string;
}

export interface CreatedPlaylist {
  id: string;
  uri: string;
  url: string;
}

const MAX_ATTEMPTS = 6;

export class SpotifyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetryAfterMs: number;

  constructor(private readonly options: SpotifyClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 120_000;
  }

  /** Performs a request, retrying 429 (honoring Retry-After), 5xx, and one 401 refresh. */
  async request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.options.getToken(false);
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.options.getToken(true);
        continue;
      }
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const waitMs = retryAfterMs(res.headers.get('Retry-After'));
        if (waitMs > this.maxRetryAfterMs) throw new RateLimitError(waitMs);
        this.options.onRateLimited?.(waitMs);
        await this.sleep(waitMs);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status === 429) throw new RateLimitError(retryAfterMs(res.headers.get('Retry-After')));
      throw new SpotifyApiError(res.status, await errorMessage(res));
    }
  }

  /** GET /me: the signed-in profile (display name and image need no extra scope). */
  async getCurrentUser(): Promise<UserProfile> {
    const me = await this.request<{
      id: string;
      display_name: string | null;
      images?: { url: string; width: number | null }[];
      external_urls?: { spotify?: string };
    }>('GET', '/me');
    const images = [...(me.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    return {
      id: me.id,
      displayName: me.display_name || me.id,
      imageUrl: images[0]?.url,
      profileUrl: me.external_urls?.spotify,
    };
  }

  /**
   * Pages through all Liked Songs (GET /me/tracks). The first page reveals the
   * total; the remaining pages are fetched a few at a time.
   */
  async getLikedTracks(onProgress?: (loaded: number, total: number) => void): Promise<LikedTrack[]> {
    const first = await this.request<Paging<SavedTrackItem>>('GET', `/me/tracks?limit=${PAGE_LIMIT}&offset=0`);
    const total = first.total;
    let loaded = first.items.length;
    onProgress?.(loaded, total);

    const offsets: number[] = [];
    for (let offset = PAGE_LIMIT; offset < total; offset += PAGE_LIMIT) offsets.push(offset);
    const pages = await mapWithConcurrency(offsets, 4, async (offset) => {
      const page = await this.request<Paging<SavedTrackItem>>(
        'GET',
        `/me/tracks?limit=${PAGE_LIMIT}&offset=${offset}`,
      );
      loaded += page.items.length;
      onProgress?.(Math.min(loaded, total), total);
      return page.items;
    });

    return [first.items, ...pages]
      .flat()
      .map(toLikedTrack)
      .filter((t): t is LikedTrack => t !== null);
  }

  async getListeningHistory(): Promise<{ history: ListeningHistory; topArtistGenres: Record<string, string[]> }> {
    const topTracks = {} as Record<TimeRange, PlayedTrackRef[]>;
    const topArtists = {} as Record<TimeRange, string[]>;
    const topArtistGenres: Record<string, string[]> = {};

    for (const range of TIME_RANGES) {
      const tracks = await this.getTopItems<TrackObject>('tracks', range);
      topTracks[range] = tracks.map(toPlayedRef);
      const artists = await this.getTopItems<ArtistObject>('artists', range);
      topArtists[range] = artists.map((a) => a.id);
      for (const a of artists) topArtistGenres[a.id] = a.genres ?? [];
    }

    const recent = await this.request<Paging<{ track: TrackObject | null }>>(
      'GET',
      `/me/player/recently-played?limit=${PAGE_LIMIT}`,
    );
    const recentlyPlayed = recent.items
      .map((item) => item.track)
      .filter((t): t is TrackObject => t !== null && t.type === 'track')
      .map(toPlayedRef);

    return { history: { topTracks, topArtists, recentlyPlayed }, topArtistGenres };
  }

  private async getTopItems<T>(type: 'tracks' | 'artists', range: TimeRange): Promise<T[]> {
    const items: T[] = [];
    for (let offset = 0; offset < TOP_ITEMS_MAX; offset += PAGE_LIMIT) {
      const page = await this.request<Paging<T>>(
        'GET',
        `/me/top/${type}?time_range=${range}&limit=${PAGE_LIMIT}&offset=${offset}`,
      );
      items.push(...page.items);
      if (!page.next || page.items.length < PAGE_LIMIT) break;
    }
    return items;
  }

  /**
   * Genres per artist via single-artist lookups (GET /artists/{id}); the batch
   * "Get Several Artists" endpoint is not available to Development Mode apps.
   * Artists for which `skip` returns true when their turn comes are not requested.
   */
  async getArtistGenres(
    artistIds: string[],
    onProgress?: (done: number, total: number, genres: Record<string, string[]>) => void,
    signal?: AbortSignal,
    concurrency = 3,
    skip?: (id: string) => boolean,
  ): Promise<Record<string, string[]>> {
    const genres: Record<string, string[]> = {};
    let done = 0;
    await mapWithConcurrency(artistIds, concurrency, async (id) => {
      if (!skip?.(id)) {
        const artist = await this.request<ArtistObject>('GET', `/artists/${encodeURIComponent(id)}`);
        genres[id] = artist.genres ?? [];
      }
      done++;
      onProgress?.(done, artistIds.length, genres);
    }, signal);
    return genres;
  }

  /** Creates a private playlist for the signed-in user and adds the tracks in batches. */
  async createPlaylist(
    name: string,
    description: string,
    trackUris: string[],
    onProgress?: (added: number, total: number) => void,
  ): Promise<CreatedPlaylist> {
    const playlist = await this.request<{ id: string; uri: string; external_urls: { spotify: string } }>(
      'POST',
      '/me/playlists',
      { name, description, public: false },
    );
    for (let i = 0; i < trackUris.length; i += ADD_ITEMS_BATCH) {
      const uris = trackUris.slice(i, i + ADD_ITEMS_BATCH);
      await this.request('POST', `/playlists/${encodeURIComponent(playlist.id)}/items`, { uris });
      onProgress?.(i + uris.length, trackUris.length);
    }
    return { id: playlist.id, uri: playlist.uri, url: playlist.external_urls.spotify };
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; error_description?: string };
    if (typeof body.error === 'object' && body.error?.message) return `${res.status}: ${body.error.message}`;
    if (body.error_description) return `${res.status}: ${body.error_description}`;
  } catch {
    // Fall through to the status text.
  }
  return `${res.status}: ${res.statusText || 'Spotify request failed'}`;
}

// ---------------------------------------------------------------------------
// Raw response shapes (only the fields we read) and mapping to our types.

interface Paging<T> {
  items: T[];
  total: number;
  next: string | null;
}

interface ArtistObject {
  id: string;
  name: string;
  genres?: string[];
}

interface TrackObject {
  id: string | null;
  uri: string;
  name: string;
  type: string;
  is_local?: boolean;
  duration_ms: number;
  disc_number: number;
  track_number: number;
  artists: { id: string | null; name: string }[];
  external_ids?: { isrc?: string };
  album: {
    id: string | null;
    name: string;
    album_type: string;
    release_date: string;
    total_tracks: number;
    images?: { url: string; width: number | null }[];
  };
}

interface SavedTrackItem {
  added_at: string;
  track: TrackObject | null;
}

export function toLikedTrack(item: SavedTrackItem): LikedTrack | null {
  const t = item.track;
  // Local files and unavailable tracks have no ID and cannot be added to playlists.
  if (!t || !t.id || t.is_local) return null;
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: t.artists.filter((a) => a.id).map((a) => ({ id: a.id as string, name: a.name })),
    album: toAlbum(t.album),
    durationMs: t.duration_ms,
    discNumber: t.disc_number,
    trackNumber: t.track_number,
    addedAt: item.added_at,
    ...(t.external_ids?.isrc ? { isrc: t.external_ids.isrc.toUpperCase() } : {}),
  };
}

function toAlbum(a: TrackObject['album']): AlbumInfo {
  const images = [...(a.images ?? [])].sort((x, y) => (x.width ?? 0) - (y.width ?? 0));
  // Prefer the smallest image that is still big enough for where it is shown.
  const atLeast = (px: number) => (images.find((i) => (i.width ?? 0) >= px) ?? images.at(-1))?.url;
  return {
    id: a.id ?? `unknown:${a.name}`,
    name: a.name,
    albumType: a.album_type,
    releaseDate: a.release_date ?? '',
    totalTracks: a.total_tracks,
    imageUrl: atLeast(64),
    coverUrl: atLeast(300),
  };
}

function toPlayedRef(t: TrackObject): PlayedTrackRef {
  return {
    id: t.id ?? '',
    name: t.name,
    artistIds: t.artists.map((a) => a.id).filter((id): id is string => !!id),
  };
}
