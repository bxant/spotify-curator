import { describe, expect, it } from 'vitest';
import { chordsUrl, isNonGuitarGenre, searchableTitle, showChordsLink } from '../src/chords';
import { track } from './fixtures/builders';

describe('chords link', () => {
  it('searches Google for the title, the primary artist and "chords"', () => {
    const t = track({ id: '4uLU6hMCjMI75M1A2tKUQC', artist: 'Rick Astley', extraArtists: ['Someone'], name: 'Never Gonna Give You Up' });
    const url = new URL(chordsUrl(t));
    expect(url.origin + url.pathname).toBe('https://www.google.com/search');
    expect([...url.searchParams.entries()]).toEqual([['q', 'Never Gonna Give You Up RICK ASTLEY chords']]);
  });

  it('encodes characters that would break the query', () => {
    const t = track({ id: 'x', artist: 'AC/DC & co', name: 'What? #1 = 100%' });
    expect(new URL(chordsUrl(t)).searchParams.get('q')).toBe('What? #1 = 100% AC/DC & CO chords');
  });

  it('drops remaster, live and featuring notes that only narrow the search', () => {
    expect(searchableTitle('Here Comes The Sun - Remastered 2009')).toBe('Here Comes The Sun');
    expect(searchableTitle('Wonderwall - Live at Knebworth')).toBe('Wonderwall');
    expect(searchableTitle('Stay (feat. Justin Bieber)')).toBe('Stay');
    expect(searchableTitle('Old Town Road [with Billy Ray Cyrus] - Remix')).toBe('Old Town Road');
    // Dashes that are part of the title stay.
    expect(searchableTitle('Ob-La-Di, Ob-La-Da')).toBe('Ob-La-Di, Ob-La-Da');
    expect(searchableTitle('Song - Part Two')).toBe('Song - Part Two');
  });
});

describe('which songs get a chords link', () => {
  it('treats hip hop, rap, electronic and dance genres as not guitar music', () => {
    for (const g of ['hip hop', 'southern hip hop', 'rap', 'trap', 'uk drill', 'electronic', 'edm', 'deep house', 'techno', 'dubstep', 'drum and bass']) {
      expect(isNonGuitarGenre(g), g).toBe(true);
    }
  });

  it('keeps guitar genres, including mixes like rap rock or folktronica', () => {
    for (const g of ['rock', 'indie pop', 'pop', 'jazz', 'rap rock', 'electronic rock', 'folktronica', 'country rap', 'nu metal']) {
      expect(isNonGuitarGenre(g), g).toBe(false);
    }
  });

  it('hides the link only when every genre of the song is clearly not guitar music', () => {
    expect(showChordsLink(['hip hop', 'rap'])).toBe(false);
    expect(showChordsLink(['techno', 'house'])).toBe(false);
    expect(showChordsLink(['hip hop', 'pop'])).toBe(true);
    expect(showChordsLink(['rock'])).toBe(true);
    // Unknown genres keep the link.
    expect(showChordsLink([])).toBe(true);
    expect(showChordsLink(new Set<string>())).toBe(true);
  });
});
