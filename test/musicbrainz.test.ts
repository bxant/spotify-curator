import { describe, expect, it, vi } from 'vitest';
import {
  ARTIST_CHUNK,
  GenreServiceError,
  MIN_INTERVAL_MS,
  MusicBrainzClient,
  LINK_CHUNK,
  NAME_SEARCH_MIN_TRACKS,
  RECOVER_AFTER,
  SLOW_INTERVAL_MS,
  TAG_CHUNK,
  USER_AGENT,
  genresFromTags,
  matchByIsrc,
  matchByName,
  normalizeName,
  phrase,
  spotifyArtistUrl,
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

  it('backs off on 503 and slows down until requests go through again', async () => {
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
    // The start after the one that ends the slowdown was already booked at the slow pace.
    for (let i = 0; i <= RECOVER_AFTER; i++) await mb.searchArtistsByName(`Calm ${i}`);
    const last = times.length - 1;
    expect(times[last] - times[last - 1]).toBeLessThan(SLOW_INTERVAL_MS);
    expect(times[last] - times[last - 1]).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
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

  it('matches by ISRC in one search per chunk, then by name for the rest, reading tags in batches', async () => {
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
      if (query === 'arid:aaaaaaaa-0000-0000-0000-000000000001') {
        return json({ artists: [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Alpha', tags: [{ name: 'rock', count: 3 }] }] });
      }
      expect(query).toBe('arid:aaaaaaaa-0000-0000-0000-000000000003');
      return json({
        artists: [{ id: 'aaaaaaaa-0000-0000-0000-000000000003', name: 'Gamma', tags: [{ name: 'seen live', count: 9 }, { name: 'jazz', count: 4 }] }],
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
    // ISRC search, Alpha's tags, then the name searches for Beta and Gamma and Gamma's tags.
    expect(calls.map((c) => new URL(c.url).searchParams.get('query'))).toEqual([
      'isrc:ISRC1 OR isrc:ISRC3',
      'arid:aaaaaaaa-0000-0000-0000-000000000001',
      'artist:"Beta"',
      'artist:"Gamma"',
      'arid:aaaaaaaa-0000-0000-0000-000000000003',
    ]);
    // Nothing to search by Spotify link (these are not Spotify IDs), then the ISRC and name steps.
    expect(progress).toEqual([0, 1, 3]);
  });

  it('matches artists by MusicBrainz\' links to their Spotify pages, 50 per search, before trying ISRCs', async () => {
    const c = clock();
    const spotify = (i: number) => `sp${String(i).padStart(20, '0')}`;
    const { fetch, calls } = fakeFetch((call) => {
      const url = new URL(call.url);
      const query = url.searchParams.get('query') ?? '';
      if (url.pathname.endsWith('/url')) {
        return json({
          urls: [
            { resource: spotifyArtistUrl(spotify(0)), 'relation-list': [{ relations: [{ artist: { id: '00000000-0000-0000-0000-0000000000a0' } }] }] },
            // Linked to two artists: left to the ISRC step.
            { resource: spotifyArtistUrl(spotify(1)), 'relation-list': [{ relations: [{ artist: { id: 'mb-1a' } }, { artist: { id: 'mb-1b' } }] }] },
          ],
        });
      }
      if (url.pathname.endsWith('/recording')) return json({ recordings: [] });
      if (query.startsWith('artist:')) return json({ artists: [] });
      return json({ artists: [{ id: '00000000-0000-0000-0000-0000000000a0', name: 'Zero', tags: [{ name: 'jazz', count: 2 }] }] });
    });
    const mb = new MusicBrainzClient({ fetch, sleep: c.sleep, now: c.now });
    const artists = Array.from({ length: LINK_CHUNK + 1 }, (_, i) => ({ id: spotify(i), name: `N${i}`, isrc: `I${i}` }));
    const got: Record<string, ArtistGenreMatch> = {};
    await mb.findArtistGenres(artists, new Set(['jazz']), (results) => Object.assign(got, results));

    const queries = calls.map((call) => new URL(call.url).searchParams.get('query') ?? '');
    expect(queries[0].split(' OR ')).toHaveLength(LINK_CHUNK);
    expect(queries[0]).toContain(`url:"https://open.spotify.com/artist/${spotify(0)}"`);
    expect(queries).toContain('arid:00000000-0000-0000-0000-0000000000a0');
    expect(got[spotify(0)]).toEqual({ mbid: '00000000-0000-0000-0000-0000000000a0', via: 'spotify', genres: ['jazz'] });
    // Two link searches ran first (the chunks overlap); ISRCs then go most-liked first.
    expect(queries.findIndex((q) => q.startsWith('isrc:'))).toBeGreaterThan(1);
    expect(queries.find((q) => q.startsWith('isrc:'))).toMatch(/^isrc:I1 OR isrc:I2 /);
    expect(got[spotify(1)]).toEqual({ mbid: null, skipped: 'none', genres: [] });
  });

  it('reads artists Wikidata linked first, 100 per tag search, and skips artists another source covered', async () => {
    const c = clock();
    const mbid = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    const { fetch, calls } = fakeFetch((call) => {
      const query = new URL(call.url).searchParams.get('query') ?? '';
      if (query.startsWith('isrc:')) return json({ recordings: [recording(['ISRCU'], [['Unlinked', mbid(999)]])] });
      const ids = query.split(' OR ').map((q) => q.replace('arid:', ''));
      return json({ artists: ids.map((id) => ({ id, name: id, tags: [{ name: 'folk', count: 1 }] })) });
    });
    const mb = new MusicBrainzClient({ fetch, sleep: c.sleep, now: c.now });
    const artists = [
      { id: 'unlinked', name: 'Unlinked', isrc: 'ISRCU' },
      ...Array.from({ length: TAG_CHUNK + 1 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, mbid: mbid(i) })),
    ];
    const got: Record<string, ArtistGenreMatch> = {};
    const progress: number[] = [];
    await mb.findArtistGenres(artists, new Set(['folk']), (results, p) => {
      Object.assign(got, results);
      progress.push(p.done);
    }, undefined, (id) => id === 'l1');

    const queries = calls.map((c) => new URL(c.url).searchParams.get('query') ?? '');
    expect(queries[0].split(' OR ')).toHaveLength(TAG_CHUNK - 1);
    expect(queries[0]).not.toContain(mbid(1));
    expect(queries[1]).toBe(`arid:${mbid(TAG_CHUNK)}`);
    expect(queries[2]).toBe('isrc:ISRCU');
    expect(got.l0).toEqual({ mbid: mbid(0), via: 'wikidata', genres: ['folk'] });
    expect(got.l1).toBeUndefined();
    expect(got.unlinked).toEqual({ mbid: mbid(999), via: 'isrc', genres: ['folk'] });
    expect(progress).toEqual([TAG_CHUNK, TAG_CHUNK + 1, TAG_CHUNK + 1, TAG_CHUNK + 2]);
  });

  it('searches names only for artists with at least NAME_SEARCH_MIN_TRACKS liked songs', async () => {
    const c = clock();
    const { fetch, calls } = fakeFetch((call) => {
      const query = new URL(call.url).searchParams.get('query') ?? '';
      return json(query.startsWith('isrc:') ? { recordings: [] } : { artists: [] });
    });
    const mb = new MusicBrainzClient({ fetch, sleep: c.sleep, now: c.now });
    const got: Record<string, ArtistGenreMatch> = {};
    await mb.findArtistGenres(
      [
        { id: 'many', name: 'Many', tracks: NAME_SEARCH_MIN_TRACKS, isrc: 'I1' },
        { id: 'one', name: 'One', tracks: 1, isrc: 'I2' },
      ],
      new Set(),
      (results) => Object.assign(got, results),
    );
    expect(calls.map((call) => new URL(call.url).searchParams.get('query'))).toEqual(['isrc:I1 OR isrc:I2', 'artist:"Many"']);
    expect(got).toEqual({
      many: { mbid: null, skipped: 'none', tracks: NAME_SEARCH_MIN_TRACKS, genres: [] },
      one: { mbid: null, skipped: 'none', tracks: 1, genres: [] },
    });
  });

  it('keeps two slow searches open at once but still starts them at least MIN_INTERVAL_MS apart', async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      let open = 0;
      let mostOpen = 0;
      const { fetch } = fakeFetch(async () => {
        starts.push(Date.now());
        mostOpen = Math.max(mostOpen, ++open);
        // MusicBrainz often takes longer to answer than the spacing between requests.
        await new Promise((r) => setTimeout(r, 3000));
        open--;
        return json({ artists: [] });
      });
      const mb = new MusicBrainzClient({ fetch });
      const mbid = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      const artists = Array.from({ length: TAG_CHUNK * 4 }, (_, i) => ({ id: `s${i}`, name: `N${i}`, mbid: mbid(i) }));
      const run = mb.findArtistGenres(artists, new Set(), () => {});
      await vi.runAllTimersAsync();
      await run;
      expect(starts).toHaveLength(4);
      expect(mostOpen).toBe(2);
      for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
      // Two at a time: four 3-second searches take about 7 seconds instead of 12.
      expect(starts[3] - starts[0]).toBeLessThan(3 * 3000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports progress per step and stops between chunks when aborted', async () => {
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
    // No recording matched, so the first chunk's artists still wait for their name searches.
    expect(done).toEqual([0]);
  });
});
