// The signed-in user's own playlists, shaped like `SpotifyClient.getOwnPlaylists` returns
// them: two saved by earlier versions of the app (plain "Curated from Liked Songs."), one
// saved with the app tag, one app playlist the owner renamed, and the owner's own lists.

import type { SavedPlaylist } from '../../src/types';

function playlist(id: string, name: string, description: string, trackCount?: number): SavedPlaylist {
  return {
    id,
    name,
    description,
    uri: `spotify:playlist:${id}`,
    url: `https://open.spotify.com/playlist/${id}`,
    ...(trackCount === undefined ? {} : { trackCount }),
  };
}

export const legacyRediscover = playlist(
  'pl-rediscover',
  'Rediscover: Liked, Then Forgotten',
  '812 songs you liked one by one over 90 days ago never show up in your top tracks or recent plays; 50 picked across the years you liked them, at most 2 per artist. Curated from Liked Songs.',
  50,
);

export const legacyBestOf = playlist(
  'pl-best-of',
  'Best of Each Album',
  'You liked 14 albums nearly whole (160 liked tracks); this keeps only the 31 tracks from 12 of them that you actually play or liked on their own. Curated from Liked Songs.',
  31,
);

/** Spotify HTML-escapes the quotes in a genre reason. */
export const taggedGenre = playlist(
  'pl-genre',
  'Genre: Indie Rock',
  '120 of your liked songs are by artists tagged &quot;indie rock&quot;; 100 picked. Curated from Liked Songs by spotify-curator.',
  100,
);

/** An app playlist the owner renamed; only its tracks tell which suggestion it was. */
export const renamedApp = playlist('pl-renamed', 'Road trip', 'Picked. Curated from Liked Songs by spotify-curator.', 10);

/** The owner's own playlist that happens to share a suggestion's name. */
export const ownSameName = playlist('pl-own-favorites', 'Real Favorites', 'my picks', 10);

/** The owner's own huge playlist with a suggestion's name; too big to be that suggestion. */
export const ownHuge = playlist('pl-own-decade', 'The 1990s', '', 900);

export const ownUnrelated = playlist('pl-own-gym', 'Gym', 'lifting', 40);

export const savedPlaylists: SavedPlaylist[] = [legacyRediscover, legacyBestOf, taggedGenre, renamedApp, ownSameName, ownHuge, ownUnrelated];
