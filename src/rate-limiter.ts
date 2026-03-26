import { RateLimit } from "./types.js";
import { parseDuration } from "./server.js";

export type Clock = () => number;

export interface RateLimiterResult {
  allowed: boolean;
}

export interface RateLimiter {
  check(key: string): RateLimiterResult;
}

export function createRateLimiter(
  _config: RateLimit,
  _clock: Clock = Date.now
): RateLimiter {
  throw new Error("not implemented");
}
