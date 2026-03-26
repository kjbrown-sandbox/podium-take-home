import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockUpstream, MockUpstream } from "./helpers/mock-upstream.js";
import { request } from "./helpers/request.js";
import { startGateway } from "../src/server.js";
import { GatewayConfig } from "../src/types.js";
import { createServer, Server } from "node:http";

/** Creates a mock that fails N times with the given status, then succeeds. */
function createFlakyUpstream(
  port: number,
  failCount: number,
  failStatus: number
): Promise<MockUpstream & { callCount: () => number }> {
  let calls = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      calls++;
      if (calls <= failCount) {
        res.writeHead(failStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_error" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "success", attempt: calls }));
      }
    });
    server.listen(port, () => {
      resolve({
        server,
        port,
        requests: [],
        close: () => new Promise<void>((r) => server.close(() => r())),
        callCount: () => calls,
      });
    });
  });
}

/** Creates a mock that always fails with the given status. */
function createFailingUpstream(
  port: number,
  failStatus: number
): Promise<MockUpstream & { callCount: () => number }> {
  let calls = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      calls++;
      res.writeHead(failStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "always_failing" }));
    });
    server.listen(port, () => {
      resolve({
        server,
        port,
        requests: [],
        close: () => new Promise<void>((r) => server.close(() => r())),
        callCount: () => calls,
      });
    });
  });
}

describe("retry - succeeds after failures", () => {
  let upstream: MockUpstream & { callCount: () => number };
  let gateway: { close: () => Promise<void> };

  before(async () => {
    // Fails twice with 502, then succeeds
    upstream = await createFlakyUpstream(9701, 2, 502);
    const config: GatewayConfig = {
      gateway: {
        port: 9700,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/flaky",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9701" },
          retry: {
            attempts: 3,
            backoff: "fixed",
            initial_delay: "100ms",
            on: [502, 503, 504],
          },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should retry and eventually return success", async () => {
    const res = await request(9700, "/api/flaky");
    assert.strictEqual(res.status, 200);
    const body = res.json() as { message: string; attempt: number };
    assert.strictEqual(body.message, "success");
  });

  it("should have made 3 total attempts (2 failures + 1 success)", () => {
    assert.strictEqual(upstream.callCount(), 3);
  });
});

describe("retry - exhausts all attempts", () => {
  let upstream: MockUpstream & { callCount: () => number };
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createFailingUpstream(9711, 503);
    const config: GatewayConfig = {
      gateway: {
        port: 9710,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/down",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9711" },
          retry: {
            attempts: 3,
            backoff: "fixed",
            initial_delay: "100ms",
            on: [502, 503, 504],
          },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should return the last failure status after exhausting retries", async () => {
    const res = await request(9710, "/api/down");
    assert.strictEqual(res.status, 503);
  });

  it("should have made 4 total attempts (1 original + 3 retries)", () => {
    assert.strictEqual(upstream.callCount(), 4);
  });
});

describe("retry - only retries on configured status codes", () => {
  let upstream: MockUpstream & { callCount: () => number };
  let gateway: { close: () => Promise<void> };

  before(async () => {
    // Fails with 400 — not in the retry list
    upstream = await createFailingUpstream(9721, 400);
    const config: GatewayConfig = {
      gateway: {
        port: 9720,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/bad-request",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9721" },
          retry: {
            attempts: 3,
            backoff: "fixed",
            initial_delay: "100ms",
            on: [502, 503, 504],
          },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should not retry on status codes not in the retry list", async () => {
    const res = await request(9720, "/api/bad-request");
    assert.strictEqual(res.status, 400);
  });

  it("should have made only 1 attempt (no retries)", () => {
    assert.strictEqual(upstream.callCount(), 1);
  });
});

describe("retry - no retry config", () => {
  let upstream: MockUpstream & { callCount: () => number };
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createFailingUpstream(9731, 502);
    const config: GatewayConfig = {
      gateway: {
        port: 9730,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/no-retry",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9731" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should not retry when no retry config is set", async () => {
    const res = await request(9730, "/api/no-retry");
    assert.strictEqual(res.status, 502);
  });

  it("should have made only 1 attempt", () => {
    assert.strictEqual(upstream.callCount(), 1);
  });
});

describe("retry - exponential backoff", () => {
  let upstream: MockUpstream & { callCount: () => number };
  let gateway: { close: () => Promise<void> };

  before(async () => {
    // Fails 3 times, succeeds on 4th
    upstream = await createFlakyUpstream(9741, 3, 504);
    const config: GatewayConfig = {
      gateway: {
        port: 9740,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/exp",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9741" },
          retry: {
            attempts: 3,
            backoff: "exponential",
            initial_delay: "100ms",
            on: [502, 503, 504],
          },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should retry with exponential backoff and succeed", async () => {
    const start = Date.now();
    const res = await request(9740, "/api/exp");
    const elapsed = Date.now() - start;
    assert.strictEqual(res.status, 200);
    // Exponential: 100ms + 200ms + 400ms = 700ms minimum
    assert.ok(elapsed >= 600, `Expected >= 600ms elapsed, got ${elapsed}ms`);
  });
});
