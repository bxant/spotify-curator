// The per-song "Chords ↗" link on playlist pages: a Google search for the song's chords,
// opened in a new tab. The app never fetches, scrapes or embeds chord data. No network or
// DOM here; tested in test/chords.test.ts.
//
// Whether chord sheets exist cannot be checked, so the link is hidden only for songs
// whose genres are all clearly not guitar music (hip hop and rap, electronic and dance),
// using the genres the page already looked up. Unknown genres keep the link.

import type { LikedTrack } from './types';

const GOOGLE_SEARCH = 'https://www.google.com/search';

/** Genre words that mark a genre as one that rarely has guitar chords. */
const NON_GUITAR = /\b(?:hip[\s-]?hop|rap|trap|drill|grime|electronic|electronica|edm|house|techno|trance|dubstep|drum and bass|dnb|jungle|breakbeat|hardstyle|electro|idm|phonk)\b/i;
/** Words that win over NON_GUITAR, so "rap rock", "electronic rock" or "folktronica" keep the link. */
const GUITAR = /rock|metal|punk|folk|country|blues|grunge|emo|indie|acoustic|singer-songwriter|bluegrass|americana|surf|ska/i;

/** Whether a genre is clearly not guitar music: a NON_GUITAR word and no GUITAR word. */
export function isNonGuitarGenre(genre: string): boolean {
  return NON_GUITAR.test(genre) && !GUITAR.test(genre);
}

/** Show the chords link unless the song has genres and every one is clearly not guitar music. */
export function showChordsLink(genres: Iterable<string>): boolean {
  const list = [...genres];
  return list.length === 0 || !list.every(isNonGuitarGenre);
}

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

/** Google search for a song's chords: title, primary artist, then "chords". */
export function chordsUrl(t: LikedTrack): string {
  const q = [searchableTitle(t.name), t.artists[0]?.name ?? '', 'chords'].filter(Boolean).join(' ');
  return `${GOOGLE_SEARCH}?${new URLSearchParams({ q })}`;
}
