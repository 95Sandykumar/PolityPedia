/**
 * 10 requests a minute per user (issue 22-revision-api, constraint C).
 *
 * A sliding window in memory. One serverless instance, one window: this is
 * not a cluster-wide quota and it is not trying to be. The real money gate is
 * the 30-a-day counter inside Postgres (`ai_usage`), which no number of
 * instances can get around. This limiter exists to stop ONE client hammering
 * one instance, which is a different problem and a cheaper one to solve.
 *
 * Pure apart from the default clock: pass `now` and it is deterministic.
 */
import { RATE_LIMIT_PER_MINUTE, RATE_WINDOW_MS, type RateLimiter } from './types';

/** Stop one leaked key from growing the map forever. */
const MAX_KEYS = 10_000;

export interface RateLimiterOptions {
  limit?: number;
  windowMs?: number;
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const limit = options.limit ?? RATE_LIMIT_PER_MINUTE;
  const windowMs = options.windowMs ?? RATE_WINDOW_MS;
  /** key -> the timestamps still inside the window, oldest first. */
  const hits = new Map<string, number[]>();

  function sweep(now: number): void {
    for (const [key, times] of hits) {
      if (times.length === 0 || now - times[times.length - 1] > windowMs) {
        hits.delete(key);
      }
    }
  }

  return {
    take(key: string, now: number = Date.now()): boolean {
      // Only ever on the way in, and only when the map is already big, so a
      // normal request never pays for the sweep.
      if (hits.size >= MAX_KEYS) sweep(now);

      const cutoff = now - windowMs;
      const times = (hits.get(key) ?? []).filter((at) => at > cutoff);

      if (times.length >= limit) {
        // Keep the trimmed list: the window still has to slide.
        hits.set(key, times);
        return false;
      }

      times.push(now);
      hits.set(key, times);
      return true;
    },
  };
}

/**
 * The one limiter the route uses.
 *
 * Module scope on purpose: it must survive between requests in the same
 * instance, or it counts nothing. Built lazily so importing this file does no
 * work at build time.
 */
let shared: RateLimiter | null = null;

export function sharedRateLimiter(): RateLimiter {
  shared ??= createRateLimiter();
  return shared;
}
