import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/http';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('mapWithConcurrency', () => {
  it('keeps input order', async () => {
    const results = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, n));
      return n * 10;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it('starts no further items once one fails', async () => {
    const started: number[] = [];
    const err = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      await tick();
      if (n === 0) throw new Error('boom');
    }).catch((e) => e);
    expect(err.message).toBe('boom');
    await tick();
    await tick();
    expect(started).toEqual([0, 1]);
  });

  it('stops taking items and rejects when the signal aborts', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const err = await mapWithConcurrency(
      [0, 1, 2, 3],
      1,
      async (n) => {
        started.push(n);
        if (n === 1) controller.abort();
      },
      controller.signal,
    ).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(started).toEqual([0, 1]);
  });
});
