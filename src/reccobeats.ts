// Musical key lookup via ReccoBeats (https://reccobeats.com), a free third-party
// API that serves Spotify-style audio features by Spotify track ID. Spotify's own
// Audio Features endpoint is closed to new apps, so this is the only key source.
// It needs no API key; it is optional and the app works without it.

import type { TrackKey } from './types';
import { defaultSleep, mapWithConcurrency, retryAfterMs } from './http';

export const RECCOBEATS_BASE = 'https://api.reccobeats.com/v1';
/** GET /v1/audio-features accepts between 1 and 40 IDs per request. */
export const KEY_BATCH = 40;
const MAX_ATTEMPTS = 5;

export class KeyServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyServiceError';
  }
}

export interface ReccoBeatsOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Parallel requests; kept low to stay well within ReccoBeats' fair-use limits. */
  concurrency?: number;
  /** Longest Retry-After we wait out before giving up on key lookups. */
  maxRetryAfterMs?: number;
}

interface AudioFeatures {
  href?: string;
  key?: number | null;
  mode?: number | null;
}

export class ReccoBeatsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly concurrency: number;
  private readonly maxRetryAfterMs: number;

  constructor(options: ReccoBeatsOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.concurrency = options.concurrency ?? 2;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
  }

  /**
   * Looks up keys for Spotify track IDs. Tracks ReccoBeats does not know, or whose
   * key could not be detected, are recorded as `null` so they are not re-requested.
   */
  async getTrackKeys(
    spotifyIds: string[],
    onProgress?: (done: number, total: number, keys: Record<string, TrackKey | null>) => void,
    signal?: AbortSignal,
  ): Promise<Record<string, TrackKey | null>> {
    const keys: Record<string, TrackKey | null> = {};
    const batches: string[][] = [];
    for (let i = 0; i < spotifyIds.length; i += KEY_BATCH) batches.push(spotifyIds.slice(i, i + KEY_BATCH));

    let done = 0;
    await mapWithConcurrency(batches, this.concurrency, async (batch) => {
      const features = await this.getAudioFeatures(batch);
      for (const id of batch) keys[id] = null;
      for (const f of features) {
        const id = spotifyIdFromHref(f.href);
        if (id && id in keys) keys[id] = toTrackKey(f);
      }
      done += batch.length;
      onProgress?.(done, spotifyIds.length, keys);
    }, signal);
    return keys;
  }

  private async getAudioFeatures(ids: string[]): Promise<AudioFeatures[]> {
    const url = `${RECCOBEATS_BASE}/audio-features?ids=${ids.map(encodeURIComponent).join(',')}`;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
      } catch (err) {
        if (attempt < 3) {
          await this.sleep(1000 * attempt);
          continue;
        }
        throw new KeyServiceError(`ReccoBeats unreachable: ${(err as Error).message}`);
      }
      if (res.ok) {
        const body = (await res.json()) as { content?: AudioFeatures[] };
        return body.content ?? [];
      }
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const waitMs = retryAfterMs(res.headers.get('Retry-After'));
        if (waitMs > this.maxRetryAfterMs) {
          throw new KeyServiceError(`ReccoBeats rate limit: asked to wait ${Math.ceil(waitMs / 1000)}s`);
        }
        await this.sleep(waitMs);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await this.sleep(1000 * attempt);
        continue;
      }
      throw new KeyServiceError(`ReccoBeats request failed with HTTP ${res.status}`);
    }
  }
}

/** ReccoBeats identifies the Spotify track only through its open.spotify.com href. */
export function spotifyIdFromHref(href: string | undefined): string | null {
  const match = href?.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

function toTrackKey(f: AudioFeatures): TrackKey | null {
  // Spotify-style features use key -1 when no key was detected.
  if (typeof f.key !== 'number' || f.key < 0 || f.key > 11) return null;
  if (f.mode !== 0 && f.mode !== 1) return null;
  return { key: f.key, mode: f.mode };
}
