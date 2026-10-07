import { describe, expect, it } from 'vitest';
import { PART_SIZE, partKey, seriesKey, showParts, showSuggestions, splitParts } from '../src/parts';
import type { CuratedPlaylist } from '../src/types';
import { track } from './fixtures/builders';

function playlist(key: string, n: number): CuratedPlaylist {
  return { key, kind: 'genre', name: key === 'genre:rock' ? 'Rock' : key, reason: 'Your rock songs.', tracks: Array.from({ length: n }, (_, i) => track({ id: `${key}-${i + 1}` })) };
}
const ids = (p: CuratedPlaylist) => p.tracks.map((t) => t.id);

describe('splitParts', () => {
  it('leaves a suggestion of at most 25 songs as it is', () => {
    const p = playlist('genre:rock', PART_SIZE);
    expect(splitParts(p)).toEqual([p]);
    expect(seriesKey(p)).toBe('genre:rock');
  });

  it('splits a longer one into parts of 25, in order, each its own playlist', () => {
    const parts = splitParts(playlist('genre:rock', 60));
    expect(parts.map((p) => p.key)).toEqual(['genre:rock', 'genre:rock|part:2', 'genre:rock|part:3']);
    expect(parts.map((p) => p.name)).toEqual(['Rock', 'Rock - Part 2', 'Rock - Part 3']);
    expect(parts.map((p) => p.tracks.length)).toEqual([25, 25, 10]);
    expect(ids(parts[1])[0]).toBe('genre:rock-26');
    expect(parts[1].reason).toBe('Your rock songs. Part 2 of 3: songs 26–50.');
    expect(parts[2].reason).toBe('Your rock songs. Part 3 of 3: songs 51–60.');
    // Part 1 keeps its key, name and reason, so links and saves from before still match it.
    expect(parts[0].reason).toBe('Your rock songs.');
    expect(parts.map((p) => p.part)).toEqual([1, 2, 3].map((number) => ({ series: 'genre:rock', number, of: 3 })));
    expect(parts.map(seriesKey)).toEqual(['genre:rock', 'genre:rock', 'genre:rock']);
    expect(partKey('genre:rock', 1)).toBe('genre:rock');
  });
});

describe('showParts', () => {
  const series = [playlist('genre:rock', 100), playlist('favorites', 20)];

  it('shows part 1 of each suggestion and offers the next part of the last one shown', () => {
    const { shown, more, used } = showParts(series, {});
    expect(shown.map((p) => p.key)).toEqual(['genre:rock', 'favorites']);
    expect(more.get('genre:rock')?.next.key).toBe('genre:rock|part:2');
    expect(more.get('genre:rock')?.left).toBe(3);
    expect(more.has('favorites')).toBe(false);
    expect(used.size).toBe(0);
  });

  it('shows as many parts as were revealed, offering the next one after the last', () => {
    const { shown, more } = showParts(series, { 'genre:rock': 3 });
    expect(shown.map((p) => p.key)).toEqual(['genre:rock', 'genre:rock|part:2', 'genre:rock|part:3', 'favorites']);
    expect([...more.keys()]).toEqual(['genre:rock|part:3']);
    expect(more.get('genre:rock|part:3')?.left).toBe(1);
    expect(showParts(series, { 'genre:rock': 9 }).more.size).toBe(0);
  });

  it('lets the next part take the place of a saved one, and gives up a suggestion only when all its parts are saved', () => {
    const saved = showParts(series, {}, new Set(['genre:rock']));
    expect(saved.shown.map((p) => p.key)).toEqual(['genre:rock|part:2', 'favorites']);
    expect(saved.more.get('genre:rock|part:2')?.next.key).toBe('genre:rock|part:3');

    const all = new Set(['genre:rock', 'genre:rock|part:2', 'genre:rock|part:3', 'genre:rock|part:4']);
    const done = showParts(series, {}, all);
    expect(done.shown.map((p) => p.key)).toEqual(['favorites']);
    expect([...done.used]).toEqual(['genre:rock']);
  });
});

describe('showSuggestions', () => {
  // As the page uses it (src/main.ts curateNow): saved parts are set aside, and a suggestion
  // whose every part is saved is curated away so the next candidate takes its place.
  const candidates = [playlist('genre:rock', 100), playlist('genre:jazz', 20), playlist('genre:folk', 20)];
  const curateTwo = (used: ReadonlySet<string>) => candidates.filter((p) => !used.has(p.key)).slice(0, 2);
  const findSaved = (savedKeys: string[]) => (playlists: CuratedPlaylist[]) =>
    new Map(playlists.filter((p) => savedKeys.includes(p.key)).map((p) => [p.key, { playlist: { id: p.key, name: p.name, description: '', uri: '', url: '' }, by: 'name' as const }]));
  const run = (savedKeys: string[], options: { kept?: CuratedPlaylist[]; revealed?: Record<string, number>; want?: string } = {}) =>
    showSuggestions(curateTwo, options.kept ?? [], options.revealed ?? {}, findSaved(savedKeys), options.want);
  const keys = (list: CuratedPlaylist[]) => list.map((p) => p.key);

  it('offers part 2 in place of a saved part 1', () => {
    const { fresh, saved, more } = run(['genre:rock']);
    expect(keys(fresh)).toEqual(['genre:rock|part:2', 'genre:jazz']);
    expect(saved.map((s) => s.playlist.key)).toEqual(['genre:rock']);
    expect(more.get('genre:rock|part:2')?.next.key).toBe('genre:rock|part:3');
  });

  it('finds saved parts that are not revealed yet, so the next part offered skips them', () => {
    const { fresh, saved, more } = run(['genre:rock|part:2']);
    expect(keys(fresh)).toEqual(['genre:rock', 'genre:jazz']);
    expect(saved.map((s) => s.playlist.key)).toEqual(['genre:rock|part:2']);
    expect(more.get('genre:rock')?.next.key).toBe('genre:rock|part:3');
  });

  it('offers the next suggestion once every part is saved, however many parts there are', () => {
    const { fresh, saved } = run(['genre:rock', 'genre:rock|part:2', 'genre:rock|part:3', 'genre:rock|part:4']);
    expect(keys(fresh)).toEqual(['genre:jazz', 'genre:folk']);
    expect(saved).toHaveLength(4);
  });

  it('offers no next part from or to a kept snapshot, while the rest of its series stays reachable', () => {
    const kept = [splitParts(playlist('genre:rock', 30))[0]];
    const { fresh, more } = run([], { kept });
    expect(fresh[0]).toBe(kept[0]);
    expect(keys(fresh)).toEqual(['genre:rock', 'genre:jazz']);
    expect(more.size).toBe(0);
    const linked = run([], { kept, want: 'genre:rock|part:3' });
    expect(keys(linked.fresh)).toEqual(['genre:rock', 'genre:rock|part:2', 'genre:rock|part:3', 'genre:jazz']);
    expect(linked.more.get('genre:rock|part:3')?.next.key).toBe('genre:rock|part:4');

    const keptPart2 = [splitParts(playlist('genre:rock', 60))[1]];
    const later = run([], { kept: keptPart2 });
    expect(keys(later.fresh)).toEqual(['genre:rock|part:2', 'genre:rock', 'genre:jazz']);
    expect(later.fresh[0]).toBe(keptPart2[0]);
    expect(later.more.size).toBe(0);
  });

  it('reveals a series up to a wanted part, such as one opened from a link', () => {
    const revealed = { 'genre:jazz': 1 };
    const opened = run([], { revealed, want: 'genre:rock|part:3' });
    expect(opened.revealed).toEqual({ 'genre:jazz': 1, 'genre:rock': 3 });
    expect(keys(opened.fresh)).toEqual(['genre:rock', 'genre:rock|part:2', 'genre:rock|part:3', 'genre:jazz']);

    // Saved parts do not count, and a part already shown or not curated leaves it as it is.
    expect(run(['genre:rock'], { want: 'genre:rock|part:3' }).revealed).toEqual({ 'genre:rock': 2 });
    expect(run([], { revealed, want: 'genre:rock' }).revealed).toBe(revealed);
    expect(run([], { revealed, want: 'genre:rock|part:9' }).revealed).toBe(revealed);
  });
});
