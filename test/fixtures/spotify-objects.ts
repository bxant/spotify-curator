// Minimal raw Spotify Web API objects, shaped like real responses.

export function rawTrack(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    uri: `spotify:track:${id}`,
    name: `Song ${id}`,
    type: 'track',
    is_local: false,
    duration_ms: 180000,
    disc_number: 1,
    track_number: 3,
    artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
    album: {
      id: `album-${id}`,
      name: `Album ${id}`,
      album_type: 'album',
      release_date: '2011-06-01',
      total_tracks: 11,
      images: [
        { url: `https://i.scdn.co/image/${id}-640`, width: 640 },
        { url: `https://i.scdn.co/image/${id}-64`, width: 64 },
        { url: `https://i.scdn.co/image/${id}-300`, width: 300 },
      ],
    },
    ...overrides,
  };
}

export function savedPage(offset: number, count: number, total: number) {
  return {
    href: '',
    limit: 50,
    offset,
    total,
    next: offset + count < total ? `https://api.spotify.com/v1/me/tracks?offset=${offset + count}&limit=50` : null,
    items: Array.from({ length: count }, (_, i) => ({
      added_at: '2024-01-01T00:00:00Z',
      track: rawTrack(`t${offset + i}`),
    })),
  };
}
