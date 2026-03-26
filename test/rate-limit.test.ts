import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockUpstream, MockUpstream } from "./helpers/mock-upstream.js";
import { request } from "./helpers/request.js";
import { startGateway } from "../src/server.js";
import { GatewayConfig } from "../src/types.js";

describe("rate limiting - fixed window", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9501);
    const config: GatewayConfig = {
      gateway: {
        port: 9500,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/limited",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9501" },
          rate_limit: { requests: 3, window: "60s", strategy: "fixed_window", per: "ip" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should allow requests within the limit", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(9500, "/api/limited");
      assert.strictEqual(res.status, 200, `Request ${i + 1} should succeed`);
    }
  });

  it("should return 429 when limit is exceeded", async () => {
    const res = await request(9500, "/api/limited");
    assert.strictEqual(res.status, 429);
  });

  it("should return JSON error body on 429", async () => {
    const res = await request(9500, "/api/limited");
    assert.strictEqual(res.status, 429);
    const body = res.json() as { error: string };
    assert.strictEqual(body.error, "rate_limit_exceeded");
  });
});

describe("rate limiting - global bucket", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9511);
    const config: GatewayConfig = {
      gateway: {
        port: 9510,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/shared",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9511" },
          rate_limit: { requests: 2, window: "60s", strategy: "fixed_window", per: "global" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should share rate limit across all clients when per is global", async () => {
    // Two requests from "different IPs" (simulated via X-Forwarded-For)
    const res1 = await request(9510, "/api/shared", { headers: { "X-Forwarded-For": "1.1.1.1" } });
    assert.strictEqual(res1.status, 200);
    const res2 = await request(9510, "/api/shared", { headers: { "X-Forwarded-For": "2.2.2.2" } });
    assert.strictEqual(res2.status, 200);
    // Third request from yet another IP should still be blocked
    const res3 = await request(9510, "/api/shared", { headers: { "X-Forwarded-For": "3.3.3.3" } });
    assert.strictEqual(res3.status, 429);
  });
});

describe("rate limiting - global_rate_limit fallback", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9521);
    const config: GatewayConfig = {
      gateway: {
        port: 9520,
        global_timeout: "30s",
        global_rate_limit: { requests: 2, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/no-override",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9521" },
          // No route-level rate_limit — should use global_rate_limit
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should apply global_rate_limit when route has no override", async () => {
    const res1 = await request(9520, "/api/no-override", { headers: { "X-Forwarded-For": "10.0.0.1" } });
    assert.strictEqual(res1.status, 200);
    const res2 = await request(9520, "/api/no-override", { headers: { "X-Forwarded-For": "10.0.0.1" } });
    assert.strictEqual(res2.status, 200);
    const res3 = await request(9520, "/api/no-override", { headers: { "X-Forwarded-For": "10.0.0.1" } });
    assert.strictEqual(res3.status, 429);
  });

  it("should not block a different IP when one IP is rate limited", async () => {
    // 10.0.0.1 is already blocked from above — 10.0.0.2 should still be fine
    const res = await request(9520, "/api/no-override", { headers: { "X-Forwarded-For": "10.0.0.2" } });
    assert.strictEqual(res.status, 200);
  });
});

describe("rate limiting - sliding window", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9531);
    const config: GatewayConfig = {
      gateway: {
        port: 9530,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/sliding",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9531" },
          rate_limit: { requests: 3, window: "60s", strategy: "sliding_window", per: "ip" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should enforce rate limit using sliding window", async () => {
    // Same basic behavior: allow up to limit, then reject
    for (let i = 0; i < 3; i++) {
      const res = await request(9530, "/api/sliding");
      assert.strictEqual(res.status, 200, `Request ${i + 1} should succeed`);
    }
    const res = await request(9530, "/api/sliding");
    assert.strictEqual(res.status, 429);
  });
});

describe("rate limiting - route override beats global", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9541);
    const config: GatewayConfig = {
      gateway: {
        port: 9540,
        global_timeout: "30s",
        global_rate_limit: { requests: 1, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/generous",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9541" },
          rate_limit: { requests: 5, window: "60s", strategy: "fixed_window", per: "ip" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should use route-level rate limit instead of global", async () => {
    // Global is 1, but route overrides to 5 — should allow 5
    for (let i = 0; i < 5; i++) {
      const res = await request(9540, "/api/generous");
      assert.strictEqual(res.status, 200, `Request ${i + 1} should succeed`);
    }
    const res = await request(9540, "/api/generous");
    assert.strictEqual(res.status, 429);
  });
});

describe("rate limiting - independent routes", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9551);
    const config: GatewayConfig = {
      gateway: {
        port: 9550,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/foo",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9551" },
          rate_limit: { requests: 2, window: "60s", strategy: "fixed_window", per: "ip" },
        },
        {
          path: "/api/bar",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9551" },
          rate_limit: { requests: 2, window: "60s", strategy: "fixed_window", per: "ip" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should track rate limits independently per route", async () => {
    // Exhaust /api/foo limit
    await request(9550, "/api/foo");
    await request(9550, "/api/foo");
    const blocked = await request(9550, "/api/foo");
    assert.strictEqual(blocked.status, 429);

    // /api/bar should still be available
    const res = await request(9550, "/api/bar");
    assert.strictEqual(res.status, 200);
  });
});

describe("rate limiting - health endpoint", () => {
  let gateway: { close: () => Promise<void> };

  before(async () => {
    const config: GatewayConfig = {
      gateway: {
        port: 9560,
        global_timeout: "30s",
        global_rate_limit: { requests: 1, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
  });

  it("should rate limit the health endpoint using global_rate_limit", async () => {
    const res1 = await request(9560, "/health");
    assert.strictEqual(res1.status, 200);
    const res2 = await request(9560, "/health");
    assert.strictEqual(res2.status, 429);
  });
});
