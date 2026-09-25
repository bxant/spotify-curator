import { describe, expect, it } from 'vitest';
import {
  ARTIST_CHUNK,
  GenreServiceError,
  MIN_INTERVAL_MS,
  MusicBrainzClient,
  SLOW_INTERVAL_MS,
  USER_AGENT,
  genresFromTags,
  matchByIsrc,
  matchByName,
  normalizeName,
  phrase,
  type ArtistGenreMatch,
  type MbRecording,
} from '../src/musicbrainz';
import { fakeFetch, json } from './fixtures/fake-fetch';

const recording = (isrcs: string[], credits: [string, string, string?][]): MbRecording => ({
  isrcs,
  'artist-credit': credits.map(([name, id, artistName]) => ({ name, artist: { id, name: artistName ?? name } })),
});

describe('normalizeName', () => {
  it('ignores case, accents, punctuation and "&" versus "and"', () => {
    expect(normalizeName('Beyoncé')).toBe(normalizeName('BEYONCE'));
    expect(normalizeName('Simon & Garfunkel')).toBe(normalizeName('Simon and Garfunkel'));
    expect(normalizeName('AC/DC')).toBe('ac dc');
    expect(normalizeName('Sigur Rós')).toBe('sigur ros');
  });
});

describe('matchByIsrc', () => {
  it('matches the artist credited under the same name on recordings with the ISRC', () => {
    const recs = [
      recording(['GBAYE0601498'], [['The Beatles', 'mb-beatles']]),
      recording(['USUM71703861'], [['Carly Rae Jepsen', 'mb-crj']]),
    ];
    expect(matchByIsrc({ id: 'sp', name: 'the beatles', isrc: 'gbaye0601498' }, recs)).toEqual({ mbid: 'mb-beatles', via: 'isrc' });
  });

  it('matches a featured artist among several credits, by credited or canonical name', () => {
    const recs = [recording(['X1'], [['Lead', 'mb-lead'], ['Guest', 'mb-guest', 'Guest Artist']])];
    expect(matchByIsrc({ id: 'sp', name: 'Guest', isrc: 'X1' }, recs)).toEqual({ mbid: 'mb-guest', via: 'isrc' });
    expect(matchByIsrc({ id: 'sp', name: 'Guest Artist', isrc: 'X1' }, recs)).toEqual({ mbid: 'mb-guest', via: 'isrc' });
  });

  it('is ambiguous when recordings with the ISRC credit different artists with that name', () => {
    const recs = [recording(['X1'], [['Nirvana', 'mb-us']]), recording(['X1'], [['Nirvana', 'mb-uk']])];
    expect(matchByIsrc({ id: 'sp', name: 'Nirvana', isrc: 'X1' }, recs)).toBe('ambiguous');
  });

  it('finds nothing without an ISRC, a recording carrying it, or a credit with the name', () => {
    const recs = [recording(['X1'], [['Someone Else', 'mb-1']])];
    expect(matchByIsrc({ id: 'sp', name: 'Band' }, recs)).toBe('none');
    expect(matchByIsrc({ id: 'sp', name: 'Band', isrc: 'X2' }, recs)).toBe('none');
    expect(matchByIsrc({ id: 'sp', name: 'Band', isrc: 'X1' }, recs)).toBe('none');
  });
});

describe('matchByName', () => {
  it('matches exactly one artist with the exact name', () => {
    const results = [
      { id: 'mb-1', name: 'Radiohead' },
      { id: 'mb-2', name: 'Radiohead Tribute Band' },
    ];
    expect(matchByName('radiohead', results)).toEqual({ mbid: 'mb-1', via: 'name' });
  });

  it('skips names shared by several artists, and names with no exact match', () => {
    const results = [
      { id: 'mb-1', name: 'Nirvana' },
      { id: 'mb-2', name: 'Nirvana' },
    ];
    expect(matchByName('Nirvana', results)).toBe('ambiguous');
    expect(matchByName('Nirvana UK', results)).toBe('none');
    expect(matchByName('!!!', [{ id: 'x', name: '???' }])).toBe('none');
  });
});

describe('genresFromTags', () => {
  const genres = new Set(['rock', 'pop', 'psychedelic rock', 'heavy metal', 'progressive rock']);

  it('keeps well-voted tags that are MusicBrainz genres, most voted first', () => {
    const tags = [
      { name: 'rock', count: 50 },
      { name: 'british', count: 24 },
      { name: 'Pop', count: 31 },
      { name: 'heavy metal', count: -5 },
      { name: 'psychedelic rock', count: 12 },
      { name: 'progressive rock', count: 2 },
    ];
    expect(genresFromTags(tags, genres)).toEqual(['rock', 'pop', 'psychedelic rock']);
    expect(genresFromTags(undefined, genres)).toEqual([]);
  });
});

describe('phrase', () => {
  it('quotes and escapes a Lucene phrase', () => {
    expect(phrase('Guns N\' Roses')).toBe('"Guns N\' Roses"');
    expect(phrase('say "hi" \\o/')).toBe('"say \\"hi\\" \\\\o/"');
  });
});

/** A fake clock that sleep advances, to observe request spacing. */
function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

describe('MusicBrainzClient', () => {
  it('identifies itself and spaces requests at least a second apart', async () => {
    const c = clock();
    const times: number[] = [];
    const { fetch, calls } = fakeFetch(() => {
      times.push(c.now());
      return json({ recordings: [] });
    });
    const mb = new MusicBrainzClient({ fetch, sleep: c.sleep, now: c.now });
    await mb.searchRecordingsByIsrc(['A']);
    await mb.searchRecordingsByIsrc(['B']);
    await mb.searchRecordingsByIsrc(['C']);
    expect(calls[0].headers['user-agent']).toBe(USER_AGENT);
    expect(calls[0].url).toBe('https://musicbrainz.org/ws/2/recording?query=isrc%3AA&limit=100&fmt=json');
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
  });

  it('backs off on 503 and slows down for the rest of the lookup', async () => {
    const c = clock();
    const times: number[] = [];
    let n = 0;
    const { fetch } = fakeFetch(() => {
      times.push(c.now());
      return n++ === 0 ? new Response('', { status: 503 }) : json({ artists: [] });
    });
    const mb = new MusicBrainzClient({ fetch, sleep: c.sleep, now: c.now });
    await mb.searchArtistsByName('Band');
    await mb.searchArtistsByName('Other');
    expect(times).toHaveLength(3);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(SLOW_INTERVAL_MS);
  });

  it('fails with GenreServiceError when MusicBrainz keeps refusing or is unreachable', async () => {
    const c = clock();
    const down = new MusicBrainzClient({ fetch: fakeFetch(() => new Response('', { status: 503 })).fetch, sleep: c.sleep, now: c.now });
    await expect(down.getGenreNames()).rejects.toBeInstanceOf(GenreServiceError);
    const offline = new MusicBrainzClient({
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
      sleep: c.sleep,
      now: c.now,
    });
    await expect(offline.getGenreNames()).rejects.toThrow('unreachable');
  });

  it('matches a chunk with batched searches: ISRC first, then name, then one tag search', async () => {
    const c = clock();
    const { fetch, calls } = fakeFetch((call) => {
      const url = new URL(call.url);
      const query = url.searchParams.get('query') ?? '';
      if (url.pathname.endsWith('/recording')) {
        expect(query).toBe('isrc:ISRC1 OR isrc:ISRC3');
        return json({ recordings: [recording(['ISRC1'], [['Alpha', 'aaaaaaaa-0000-0000-0000-000000000001']]), recording(['ISRC3'], [['Other', 'mb-x']])] });
      }
      if (query.startsWith('artist:')) {
        if (query === 'artist:"Gamma"') return json({ artists: [{ id: 'aaaaaaaa-0000-0000-0000-000000000003', name: 'Gamma' }] });
        return json({ artists: [{ id: 'mb-b1', name: 'Beta' }, { id: 'mb-b2', name: 'Beta' }] });
      }
      expect(query).toBe('arid:aaaaaaaa-0000-0000-0000-000000000001 OR arid:aaaaaaaa-0000-0000-0000-000000000003');
      return json({
        artists: [
          { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Alpha', tags: [{ name: 'rock', count: 3 }] },
          { id: 'aaaaaaaa-0000-0000-0000-000000000003', name: 'Gamma', tags: [{ name: 'seen live', count: 9 }, { name: 'jazz', count: 4 }] },
        ],
      });
    });
    const mb = new MusicBrainzClient({ fetch, sleep: c.sleep, now: c.now });
    const got: Record<string, ArtistGenreMatch> = {};
    const progress: number[] = [];
    await mb.findArtistGenres(
      [
        { id: 'a', name: 'Alpha', isrc: 'ISRC1' },
        { id: 'b', name: 'Beta' },
        { id: 'g', name: 'Gamma', isrc: 'ISRC3' },
      ],
      new Set(['rock', 'jazz']),
      (results, p) => {
        Object.assign(got, results);
        progress.push(p.done);
      },
    );
    expect(got).toEqual({
      a: { mbid: 'aaaaaaaa-0000-0000-0000-000000000001', via: 'isrc', genres: ['rock'] },
      b: { mbid: null, skipped: 'ambiguous', genres: [] },
      g: { mbid: 'aaaaaaaa-0000-0000-0000-000000000003', via: 'name', genres: ['jazz'] },
    });
    expect(calls).toHaveLength(4);
    expect(progress).toEqual([3]);
  });

  it('reports progress per chunk and stops between chunks when aborted', async () => {
    const c = clock();
    const controller = new AbortController();
    const { fetch } = fakeFetch((call) =>
      json(call.url.includes('/recording') ? { recordings: [] } : { artists: [] }),
    );
    const mb = new MusicBrainzClient({ fetch, sleep: c.sleep, now: c.now });
    const artists = Array.from({ length: ARTIST_CHUNK * 2 }, (_, i) => ({ id: `s${i}`, name: `N${i}`, isrc: `I${i}` }));
    const done: number[] = [];
    const run = mb.findArtistGenres(artists, new Set(), (_r, p) => {
      done.push(p.done);
      controller.abort();
    }, controller.signal);
    await expect(run).rejects.toThrow();
    expect(done).toEqual([ARTIST_CHUNK]);
  });
});
