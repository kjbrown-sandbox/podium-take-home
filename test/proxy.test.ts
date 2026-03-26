import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockUpstream, createSlowUpstream, MockUpstream } from "./helpers/mock-upstream.js";
import { request } from "./helpers/request.js";
import { startGateway } from "../src/server.js";
import { GatewayConfig } from "../src/types.js";

describe("health endpoint", () => {
  let gateway: { close: () => Promise<void> };

  before(async () => {
    const config: GatewayConfig = {
      gateway: {
        port: 9100,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
  });

  it("should return 200 with healthy status", async () => {
    const res = await request(9100, "/health");
    assert.strictEqual(res.status, 200);
    const body = res.json() as { status: string; uptime_seconds: number };
    assert.strictEqual(body.status, "healthy");
    assert.strictEqual(typeof body.uptime_seconds, "number");
  });

  it("should only respond to GET", async () => {
    const res = await request(9100, "/health", { method: "POST" });
    assert.strictEqual(res.status, 405);
  });
});

describe("basic proxying", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9201);
    const config: GatewayConfig = {
      gateway: {
        port: 9200,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/users",
          methods: ["GET", "POST"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9201" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should proxy GET requests to upstream", async () => {
    const res = await request(9200, "/api/users");
    assert.strictEqual(res.status, 200);
    const body = res.json() as { method: string; url: string };
    assert.strictEqual(body.method, "GET");
    assert.strictEqual(body.url, "/api/users");
  });

  it("should proxy POST requests to upstream", async () => {
    const res = await request(9200, "/api/users", {
      method: "POST",
      body: JSON.stringify({ name: "test" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.strictEqual(res.status, 200);
    const body = res.json() as { method: string };
    assert.strictEqual(body.method, "POST");
  });

  it("should proxy subpaths to upstream", async () => {
    const res = await request(9200, "/api/users/123");
    assert.strictEqual(res.status, 200);
    const body = res.json() as { url: string };
    assert.strictEqual(body.url, "/api/users/123");
  });

  it("should return 404 for unmatched routes", async () => {
    const res = await request(9200, "/api/unknown");
    assert.strictEqual(res.status, 404);
  });

  it("should return 405 for disallowed methods", async () => {
    const res = await request(9200, "/api/users", { method: "DELETE" });
    assert.strictEqual(res.status, 405);
  });
});

describe("strip_prefix", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9301);
    const config: GatewayConfig = {
      gateway: {
        port: 9300,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/products",
          methods: ["GET"],
          strip_prefix: true,
          upstream: { url: "http://localhost:9301" },
        },
        {
          path: "/api/users",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9301" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should strip prefix when strip_prefix is true", async () => {
    const res = await request(9300, "/api/products/123");
    assert.strictEqual(res.status, 200);
    const body = res.json() as { url: string };
    assert.strictEqual(body.url, "/123");
  });

  it("should strip prefix for exact path match (root becomes /)", async () => {
    const res = await request(9300, "/api/products");
    assert.strictEqual(res.status, 200);
    const body = res.json() as { url: string };
    assert.strictEqual(body.url, "/");
  });

  it("should preserve full path when strip_prefix is false", async () => {
    const res = await request(9300, "/api/users/456");
    assert.strictEqual(res.status, 200);
    const body = res.json() as { url: string };
    assert.strictEqual(body.url, "/api/users/456");
  });
});

describe("timeouts", () => {
  let slowUpstream: MockUpstream;
  let fastUpstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    // Responds after 3 seconds
    slowUpstream = await createSlowUpstream(9401, 3000);
    fastUpstream = await createMockUpstream(9402);
    const config: GatewayConfig = {
      gateway: {
        port: 9400,
        global_timeout: "1s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/slow",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9401" },
        },
        {
          path: "/api/slow-override",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9401", timeout: "5s" },
        },
        {
          path: "/api/fast",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9402" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await slowUpstream.close();
    await fastUpstream.close();
  });

  it("should timeout with global_timeout when upstream is slow", async () => {
    const res = await request(9400, "/api/slow");
    assert.strictEqual(res.status, 504);
  });

  it("should use per-route timeout override instead of global", async () => {
    // Route has 5s timeout, upstream responds in 3s — should succeed
    const res = await request(9400, "/api/slow-override");
    assert.strictEqual(res.status, 200);
  });

  it("should not timeout when upstream responds quickly", async () => {
    const res = await request(9400, "/api/fast");
    assert.strictEqual(res.status, 200);
  });
});
