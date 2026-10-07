import { describe, expect, it } from 'vitest';
import {
  MAX_CAPO,
  capoAdvice,
  capoHint,
  capoLabel,
  capoOptions,
  chordsUrl,
  isEasyKey,
  keyPlaylists,
  playUrl,
  playlistKey,
  searchableTitle,
} from '../src/musicians-corner/guitar';
import type { CuratedPlaylist, TrackKey } from '../src/types';
import { track } from './fixtures/builders';

const major = (key: number): TrackKey => ({ key, mode: 1 });
const minor = (key: number): TrackKey => ({ key, mode: 0 });

describe('capo hints', () => {
  it('needs no capo for the open-shape keys', () => {
    expect(capoHint(major(7))).toEqual({ capo: 0, shape: 'G' });
    expect(capoHint(major(0))).toEqual({ capo: 0, shape: 'C' });
    expect(capoHint(major(2))).toEqual({ capo: 0, shape: 'D' });
    expect(capoHint(major(9))).toEqual({ capo: 0, shape: 'A' });
    expect(capoHint(major(4))).toEqual({ capo: 0, shape: 'E' });
    expect(capoHint(minor(4))).toEqual({ capo: 0, shape: 'Em' });
    expect(capoHint(minor(9))).toEqual({ capo: 0, shape: 'Am' });
    expect(capoHint(minor(2))).toEqual({ capo: 0, shape: 'Dm' });
  });

  it('puts the capo where an open shape sounds in the song key, lowest fret first', () => {
    // F major: E shapes one fret up.
    expect(capoHint(major(5))).toEqual({ capo: 1, shape: 'E' });
    // B♭ major: A shapes one fret up, or G shapes three up.
    expect(capoOptions(major(10)).slice(0, 2)).toEqual([
      { capo: 1, shape: 'A' },
      { capo: 3, shape: 'G' },
    ]);
    // F♯ minor: Em shapes at fret 2. C minor: Am shapes at fret 3.
    expect(capoHint(minor(6))).toEqual({ capo: 2, shape: 'Em' });
    expect(capoHint(minor(0))).toEqual({ capo: 3, shape: 'Am' });
    // C♯ minor: Am shapes at fret 4 (Em would need fret 9).
    expect(capoHint(minor(1))).toEqual({ capo: 4, shape: 'Am' });
  });

  it('only suggests shapes of the same mode, within reach on the neck', () => {
    for (let key = 0; key < 12; key++) {
      for (const k of [major(key), minor(key)]) {
        const options = capoOptions(k);
        expect(options.length).toBeGreaterThan(0);
        for (const o of options) {
          expect(o.capo).toBeLessThanOrEqual(MAX_CAPO);
          expect(o.shape.endsWith('m')).toBe(k.mode === 0);
        }
        expect(options.map((o) => o.capo)).toEqual([...options.map((o) => o.capo)].sort((a, b) => a - b));
      }
    }
  });

  it('labels and explains the hint, including the transposition', () => {
    expect(capoLabel(major(7))).toBe('No capo · G shapes');
    expect(capoLabel(major(5))).toBe('Capo 1 · E shapes');
    expect(capoAdvice(major(5))).toBe('F major: capo on fret 1, then play the chords a semitone lower, as E shapes. Or capo 3 with D shapes.');
    expect(capoAdvice(minor(0))).toBe('C minor: capo on fret 3, then play the chords 3 semitones lower, as Am shapes.');
    expect(capoAdvice(major(7))).toBe('G major: no capo needed, play it with open G shapes.');
  });
});

describe('easy guitar keys', () => {
  it('are exactly G, C, D, A, E major and E, A, D minor', () => {
    const easy: string[] = [];
    for (let key = 0; key < 12; key++) {
      if (isEasyKey(major(key))) easy.push(`${key}:1`);
      if (isEasyKey(minor(key))) easy.push(`${key}:0`);
    }
    expect(easy.sort()).toEqual(['0:1', '2:0', '2:1', '4:0', '4:1', '7:1', '9:0', '9:1']);
    expect(isEasyKey(null)).toBe(false);
    expect(isEasyKey(undefined)).toBe(false);
  });

  const playlist = (key: string, kind: CuratedPlaylist['kind'] = 'key'): CuratedPlaylist => ({ key, kind, name: key, reason: '', tracks: [] });

  it('reads a key playlist key from its stable key', () => {
    expect(playlistKey(playlist('key:9:0'))).toEqual(minor(9));
    expect(playlistKey(playlist('key:10:1'))).toEqual(major(10));
    expect(playlistKey(playlist('key:12:1'))).toBeNull();
    expect(playlistKey(playlist('genre:key:9:0', 'genre'))).toBeNull();
  });

  it('keeps only key playlists, and with the filter only those in easy keys, in order', () => {
    const all = [playlist('favorites', 'favorites'), playlist('key:5:1'), playlist('key:7:1'), playlist('genre:rock', 'genre'), playlist('key:9:0')];
    expect(keyPlaylists(all, false).map((p) => p.key)).toEqual(['key:5:1', 'key:7:1', 'key:9:0']);
    expect(keyPlaylists(all, true).map((p) => p.key)).toEqual(['key:7:1', 'key:9:0']);
  });
});

describe('play-along links', () => {
  it('searches Ultimate Guitar by title for the primary artist and the song', () => {
    const t = track({ id: '4uLU6hMCjMI75M1A2tKUQC', artist: 'Rick Astley', extraArtists: ['Someone'], name: 'Never Gonna Give You Up' });
    const url = new URL(chordsUrl(t));
    expect(url.origin + url.pathname).toBe('https://www.ultimate-guitar.com/search.php');
    expect(url.searchParams.get('search_type')).toBe('title');
    expect(url.searchParams.get('value')).toBe('RICK ASTLEY Never Gonna Give You Up');
  });

  it('encodes characters that would break the query', () => {
    const t = track({ id: 'x', artist: 'AC/DC & co', name: 'What? #1 = 100%' });
    expect(new URL(chordsUrl(t)).searchParams.get('value')).toBe('AC/DC & CO What? #1 = 100%');
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

  it('opens the track on the Spotify web player', () => {
    expect(playUrl(track({ id: '4uLU6hMCjMI75M1A2tKUQC' }))).toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  });
});
