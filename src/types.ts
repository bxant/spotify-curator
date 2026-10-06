// Plain data shapes shared by the Spotify client and the curation module.
// The curation module only ever sees these, never raw Spotify responses.

export interface ArtistRef {
  id: string;
  name: string;
}

export interface AlbumInfo {
  id: string;
  name: string;
  /** "YYYY", "YYYY-MM" or "YYYY-MM-DD" depending on Spotify's precision. */
  releaseDate: string;
  albumType: string;
  totalTracks: number;
  /** Small cover (at least 64px) for track rows. */
  imageUrl?: string;
  /** Larger cover (at least 300px) for playlist artwork. */
  coverUrl?: string;
}

export interface LikedTrack {
  id: string;
  uri: string;
  name: string;
  artists: ArtistRef[];
  album: AlbumInfo;
  durationMs: number;
  discNumber: number;
  trackNumber: number;
  /** ISO timestamp of when the track was added to Liked Songs. */
  addedAt: string;
  /** International Standard Recording Code, when Spotify has one (used to match MusicBrainz). */
  isrc?: string;
}

/** Minimal reference to a track that shows up in listening history. */
export interface PlayedTrackRef {
  id: string;
  name: string;
  artistIds: string[];
}

export type TimeRange = 'short_term' | 'medium_term' | 'long_term';

export const TIME_RANGES: readonly TimeRange[] = ['short_term', 'medium_term', 'long_term'];

export interface ListeningHistory {
  /** The user's top tracks per time range, most-played first. */
  topTracks: Record<TimeRange, PlayedTrackRef[]>;
  /** The user's top artist IDs per time range, most-played first. */
  topArtists: Record<TimeRange, string[]>;
  /** Recently played tracks (Spotify returns at most the last 50 plays). */
  recentlyPlayed: PlayedTrackRef[];
}

/** Musical key as a pitch class (0 = C, 1 = C♯/D♭ … 11 = B) plus mode (1 = major, 0 = minor). */
export interface TrackKey {
  key: number;
  mode: 0 | 1;
}

/** `custom` is a playlist built from the owner's own choices (src/builder.ts), never a recommendation. */
export type PlaylistKind = 'favorites' | 'rediscover' | 'best-of-albums' | 'artist' | 'genre' | 'key' | 'era' | 'custom';

export interface CuratedPlaylist {
  /** Stable identifier, e.g. "favorites", "artist:<id>", "genre:indie rock", "key:9:0" or "custom". */
  key: string;
  kind: PlaylistKind;
  name: string;
  /** One-sentence explanation of why these tracks were chosen. */
  reason: string;
  tracks: LikedTrack[];
}

/** One of the signed-in user's own playlists, as far as matching saved suggestions needs it. */
export interface SavedPlaylist {
  id: string;
  name: string;
  /** As Spotify returns it, which may HTML-escape some characters. */
  description: string;
  uri: string;
  url: string;
  /** Number of items in the playlist, when Spotify reported it. */
  trackCount?: number;
}

/** A saved playlist's tracks: IDs plus name/artist keys (see `trackKey`) for relinked tracks. */
export interface SavedTracks {
  ids: string[];
  keys: string[];
}
