// Small HTTP helpers shared by the Spotify and ReccoBeats clients.

/** Parses Retry-After (seconds or HTTP date); defaults to 1s when missing. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? 1000 : Math.max(0, date - now);
}

/**
 * Runs `fn` over items with at most `limit` in flight; results keep input order.
 * Once any call fails or `signal` aborts, no further items are started.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && !signal?.aborted && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  signal?.throwIfAborted();
  return results;
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
