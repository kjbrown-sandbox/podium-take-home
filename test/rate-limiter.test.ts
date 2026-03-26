import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/rate-limiter.js";

describe("rate limiter - fixed window expiry", () => {
  it("should reset count after window expires", () => {
    let now = 0;
    const limiter = createRateLimiter(
      { requests: 2, window: "10s", strategy: "fixed_window", per: "ip" },
      () => now
    );

    // Use up the limit
    assert.strictEqual(limiter.check("ip1").allowed, true);
    assert.strictEqual(limiter.check("ip1").allowed, true);
    assert.strictEqual(limiter.check("ip1").allowed, false);

    // Advance past the window
    now = 10_000;
    assert.strictEqual(limiter.check("ip1").allowed, true);
  });

  it("should not reset before window expires", () => {
    let now = 0;
    const limiter = createRateLimiter(
      { requests: 2, window: "10s", strategy: "fixed_window", per: "ip" },
      () => now
    );

    assert.strictEqual(limiter.check("ip1").allowed, true);
    assert.strictEqual(limiter.check("ip1").allowed, true);

    // Advance but not past the window
    now = 9_999;
    assert.strictEqual(limiter.check("ip1").allowed, false);
  });

  it("should track keys independently", () => {
    let now = 0;
    const limiter = createRateLimiter(
      { requests: 1, window: "10s", strategy: "fixed_window", per: "ip" },
      () => now
    );

    assert.strictEqual(limiter.check("ip1").allowed, true);
    assert.strictEqual(limiter.check("ip1").allowed, false);
    // Different key should have its own counter
    assert.strictEqual(limiter.check("ip2").allowed, true);
  });
});

describe("rate limiter - sliding window expiry", () => {
  it("should use weighted approximation across windows", () => {
    let now = 0;
    const limiter = createRateLimiter(
      { requests: 10, window: "10s", strategy: "sliding_window", per: "ip" },
      () => now
    );

    // Fill up the first window with 10 requests
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(limiter.check("ip1").allowed, true);
    }
    assert.strictEqual(limiter.check("ip1").allowed, false);

    // Move to 5s into the next window (50% overlap with previous)
    // Estimated = previous(10) * 0.5 + current(0) = 5, under limit of 10
    now = 15_000;
    assert.strictEqual(limiter.check("ip1").allowed, true);
  });

  it("should block when weighted estimate exceeds limit", () => {
    let now = 0;
    const limiter = createRateLimiter(
      { requests: 10, window: "10s", strategy: "sliding_window", per: "ip" },
      () => now
    );

    // Fill up first window
    for (let i = 0; i < 10; i++) {
      limiter.check("ip1");
    }

    // Move to 1s into next window (90% overlap)
    // Estimated = previous(10) * 0.9 + current(0) = 9
    now = 11_000;
    // Should allow 1 more (9 + 1 = 10 = limit)
    assert.strictEqual(limiter.check("ip1").allowed, true);
    // Now estimated = 10 * 0.9 + 1 = 10, at limit
    assert.strictEqual(limiter.check("ip1").allowed, false);
  });

  it("should fully reset after two full windows have passed", () => {
    let now = 0;
    const limiter = createRateLimiter(
      { requests: 2, window: "10s", strategy: "sliding_window", per: "ip" },
      () => now
    );

    assert.strictEqual(limiter.check("ip1").allowed, true);
    assert.strictEqual(limiter.check("ip1").allowed, true);
    assert.strictEqual(limiter.check("ip1").allowed, false);

    // Move past two full windows — previous window is completely gone
    now = 20_000;
    assert.strictEqual(limiter.check("ip1").allowed, true);
  });
});
