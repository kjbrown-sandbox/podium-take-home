import { RateLimit } from "./types.js";
import { parseDuration } from "./server.js";

export type Clock = () => number;

export interface RateLimiterResult {
  allowed: boolean;
}

export interface RateLimiter {
  check(key: string): RateLimiterResult;
}

interface WindowState {
  windowStart: number;
  count: number;
  previousCount: number;
}

function createFixedWindowLimiter(
  maxRequests: number,
  windowMs: number,
  clock: Clock
): RateLimiter {
  const buckets = new Map<string, WindowState>();

  return {
    check(key: string): RateLimiterResult {
      const now = clock();
      let state = buckets.get(key);

      if (!state || now >= state.windowStart + windowMs) {
        state = { windowStart: now - (now % windowMs), count: 0, previousCount: 0 };
        buckets.set(key, state);
      }

      state.count++;
      return { allowed: state.count <= maxRequests };
    },
  };
}

function createSlidingWindowLimiter(
  maxRequests: number,
  windowMs: number,
  clock: Clock
): RateLimiter {
  const buckets = new Map<string, WindowState>();

  return {
    check(key: string): RateLimiterResult {
      const now = clock();
      let state = buckets.get(key);

      if (!state) {
        state = { windowStart: now, count: 0, previousCount: 0 };
        buckets.set(key, state);
      }

      // Roll the window forward if we've moved past it
      if (now >= state.windowStart + windowMs) {
        state.previousCount = state.count;
        state.count = 0;
        state.windowStart = state.windowStart + windowMs;

        // If we've moved past two full windows, previous is gone too
        if (now >= state.windowStart + windowMs) {
          state.previousCount = 0;
          state.windowStart = now;
        }
      }

      const elapsed = now - state.windowStart;
      const overlapFraction = Math.max(0, 1 - elapsed / windowMs);
      const estimated = state.previousCount * overlapFraction + state.count;

      if (estimated >= maxRequests) {
        return { allowed: false };
      }

      state.count++;
      return { allowed: true };
    },
  };
}

export function createRateLimiter(
  config: RateLimit,
  clock: Clock = Date.now
): RateLimiter {
  const windowMs = parseDuration(config.window);

  if (config.strategy === "sliding_window") {
    return createSlidingWindowLimiter(config.requests, windowMs, clock);
  }
  return createFixedWindowLimiter(config.requests, windowMs, clock);
}
