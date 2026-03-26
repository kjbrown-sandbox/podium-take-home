import { CircuitBreaker as CircuitBreakerConfig } from "./types.js";
import { parseDuration } from "./server.js";

type State = "closed" | "open";

export interface CircuitBreakerInstance {
  /** Check if request is allowed. Returns null if allowed, or a response object if blocked. */
  allowRequest(): { retry_after: number } | null;
  /** Record a successful response. */
  recordSuccess(): void;
  /** Record a failed response. */
  recordFailure(): void;
}

export function createCircuitBreaker(
  config: CircuitBreakerConfig
): CircuitBreakerInstance {
  const threshold = config.threshold;
  const windowMs = parseDuration(config.window);
  const cooldownMs = parseDuration(config.cooldown);

  let state: State = "closed";
  let failures: number[] = []; // timestamps of failures
  let openedAt = 0;

  return {
    allowRequest() {
      if (state === "open") {
        const elapsed = Date.now() - openedAt;
        if (elapsed < cooldownMs) {
          const retryAfter = Math.ceil((cooldownMs - elapsed) / 1000);
          return { retry_after: retryAfter };
        }
        // Cooldown expired — move to half-open (let one request through)
        state = "closed";
        failures = [];
      }
      return null;
    },

    recordSuccess() {
      // Reset on success
      failures = [];
      state = "closed";
    },

    recordFailure() {
      const now = Date.now();
      // Remove failures outside the window
      failures = failures.filter((t) => now - t < windowMs);
      failures.push(now);

      if (failures.length >= threshold) {
        state = "open";
        openedAt = now;
      }
    },
  };
}
