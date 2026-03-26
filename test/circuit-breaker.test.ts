import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockUpstream, MockUpstream } from "./helpers/mock-upstream.js";
import { request } from "./helpers/request.js";
import { startGateway } from "../src/server.js";
import { GatewayConfig } from "../src/types.js";
import { createServer } from "node:http";

function createFailingUpstream(
  port: number,
  failStatus: number
): Promise<MockUpstream & { callCount: () => number }> {
  let calls = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      calls++;
      res.writeHead(failStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "failing" }));
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

/** Upstream that fails N times then succeeds. */
function createRecoveringUpstream(
  port: number,
  failCount: number
): Promise<MockUpstream & { callCount: () => number }> {
  let calls = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      calls++;
      if (calls <= failCount) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "failing" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "recovered" }));
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

describe("circuit breaker - trips after threshold", () => {
  let upstream: MockUpstream & { callCount: () => number };
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createFailingUpstream(9801, 500);
    const config: GatewayConfig = {
      gateway: {
        port: 9800,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/fragile",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9801" },
          circuit_breaker: {
            threshold: 3,
            window: "60s",
            cooldown: "30s",
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

  it("should pass through failures until threshold is reached", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(9800, "/api/fragile");
      assert.strictEqual(res.status, 500, `Request ${i + 1} should pass through to upstream`);
    }
  });

  it("should return 503 after breaker trips without contacting upstream", async () => {
    const countBefore = upstream.callCount();
    const res = await request(9800, "/api/fragile");
    assert.strictEqual(res.status, 503);
    const body = res.json() as { error: string; retry_after: number };
    assert.strictEqual(body.error, "service_unavailable");
    assert.strictEqual(typeof body.retry_after, "number");
    // Should not have contacted upstream
    assert.strictEqual(upstream.callCount(), countBefore);
  });

  it("should continue returning 503 while breaker is open", async () => {
    const res = await request(9800, "/api/fragile");
    assert.strictEqual(res.status, 503);
  });
});

describe("circuit breaker - does not trip on success", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9811);
    const config: GatewayConfig = {
      gateway: {
        port: 9810,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/stable",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9811" },
          circuit_breaker: {
            threshold: 3,
            window: "60s",
            cooldown: "30s",
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

  it("should never trip when upstream is healthy", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(9810, "/api/stable");
      assert.strictEqual(res.status, 200, `Request ${i + 1} should succeed`);
    }
  });
});

describe("circuit breaker - recovery after cooldown", () => {
  let upstream: MockUpstream & { callCount: () => number };
  let gateway: { close: () => Promise<void> };

  before(async () => {
    // Fails 3 times (trips the breaker), then recovers
    upstream = await createRecoveringUpstream(9821, 3);
    const config: GatewayConfig = {
      gateway: {
        port: 9820,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/recovering",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9821" },
          circuit_breaker: {
            threshold: 3,
            window: "60s",
            cooldown: "1s", // Short cooldown for testing
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

  it("should recover after cooldown when upstream is healthy again", async () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await request(9820, "/api/recovering");
    }

    // Should be tripped now
    const tripped = await request(9820, "/api/recovering");
    assert.strictEqual(tripped.status, 503);

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 1100));

    // Should try upstream again and succeed (upstream has recovered)
    const recovered = await request(9820, "/api/recovering");
    assert.strictEqual(recovered.status, 200);
  });
});

describe("circuit breaker - no circuit breaker config", () => {
  let upstream: MockUpstream & { callCount: () => number };
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createFailingUpstream(9831, 500);
    const config: GatewayConfig = {
      gateway: {
        port: 9830,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/no-breaker",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9831" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should never return 503 without circuit breaker config", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(9830, "/api/no-breaker");
      assert.strictEqual(res.status, 500, `Request ${i + 1} should pass through`);
    }
  });
});
