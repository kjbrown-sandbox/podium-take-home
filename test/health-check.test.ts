import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "./helpers/request.js";
import { startGateway } from "../src/server.js";
import { GatewayConfig } from "../src/types.js";
import { createServer, Server } from "node:http";

/** Creates an upstream with a /healthz endpoint that can be toggled healthy/unhealthy. */
function createControllableUpstream(
  port: number,
  id: string
): Promise<{ server: Server; close: () => Promise<void>; setHealthy: (h: boolean) => void }> {
  let healthy = true;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/healthz") {
        if (healthy) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "unhealthy" }));
        }
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ server: id, url: req.url }));
    });
    server.listen(port, () => {
      resolve({
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
        setHealthy: (h: boolean) => { healthy = h; },
      });
    });
  });
}

describe("health checks - marks upstream unhealthy", () => {
  let upstream1: Awaited<ReturnType<typeof createControllableUpstream>>;
  let upstream2: Awaited<ReturnType<typeof createControllableUpstream>>;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream1 = await createControllableUpstream(10101, "server-1");
    upstream2 = await createControllableUpstream(10102, "server-2");
    const config: GatewayConfig = {
      gateway: {
        port: 10100,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/checked",
          methods: ["GET"],
          strip_prefix: false,
          upstream: {
            targets: [
              { url: "http://localhost:10101", weight: 1 },
              { url: "http://localhost:10102", weight: 1 },
            ],
            balance: "round_robin",
          },
          health_check: {
            path: "/healthz",
            interval: "500ms",
            unhealthy_threshold: 2,
          },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream1.close();
    await upstream2.close();
  });

  it("should route to both upstreams when both are healthy", async () => {
    const res1 = await request(10100, "/api/checked");
    const res2 = await request(10100, "/api/checked");
    const server1 = (res1.json() as { server: string }).server;
    const server2 = (res2.json() as { server: string }).server;
    assert.notStrictEqual(server1, server2, "Should hit different servers");
  });

  it("should stop routing to unhealthy upstream after threshold failures", async () => {
    // Make upstream1 unhealthy
    upstream1.setHealthy(false);

    // Wait for health checks to detect it (2 failures * 500ms interval + buffer)
    await new Promise((r) => setTimeout(r, 1500));

    // All requests should now go to server-2
    const servers: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(10100, "/api/checked");
      assert.strictEqual(res.status, 200);
      servers.push((res.json() as { server: string }).server);
    }
    assert.ok(
      servers.every((s) => s === "server-2"),
      `Expected all requests to go to server-2, got: ${servers}`
    );
  });

  it("should resume routing to upstream after it recovers", async () => {
    // Make upstream1 healthy again
    upstream1.setHealthy(true);

    // Wait for health check to detect recovery
    await new Promise((r) => setTimeout(r, 1000));

    // Should route to both again
    const servers = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const res = await request(10100, "/api/checked");
      servers.add((res.json() as { server: string }).server);
    }
    assert.strictEqual(servers.size, 2, "Should route to both servers again");
  });
});

describe("health checks - all upstreams unhealthy", () => {
  let upstream1: Awaited<ReturnType<typeof createControllableUpstream>>;
  let upstream2: Awaited<ReturnType<typeof createControllableUpstream>>;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream1 = await createControllableUpstream(10111, "server-1");
    upstream2 = await createControllableUpstream(10112, "server-2");
    const config: GatewayConfig = {
      gateway: {
        port: 10110,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/all-down",
          methods: ["GET"],
          strip_prefix: false,
          upstream: {
            targets: [
              { url: "http://localhost:10111", weight: 1 },
              { url: "http://localhost:10112", weight: 1 },
            ],
            balance: "round_robin",
          },
          health_check: {
            path: "/healthz",
            interval: "500ms",
            unhealthy_threshold: 2,
          },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream1.close();
    await upstream2.close();
  });

  it("should return 503 when all upstreams are unhealthy", async () => {
    upstream1.setHealthy(false);
    upstream2.setHealthy(false);

    // Wait for health checks to detect both are down
    await new Promise((r) => setTimeout(r, 1500));

    const res = await request(10110, "/api/all-down");
    assert.strictEqual(res.status, 503);
    const body = res.json() as { error: string };
    assert.strictEqual(body.error, "no_healthy_upstreams");
  });
});

describe("health checks - no health check config", () => {
  let upstream1: Awaited<ReturnType<typeof createControllableUpstream>>;
  let upstream2: Awaited<ReturnType<typeof createControllableUpstream>>;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream1 = await createControllableUpstream(10121, "server-1");
    upstream2 = await createControllableUpstream(10122, "server-2");
    // Make one unhealthy — but without health checks, gateway won't know
    upstream1.setHealthy(false);
    const config: GatewayConfig = {
      gateway: {
        port: 10120,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/no-check",
          methods: ["GET"],
          strip_prefix: false,
          upstream: {
            targets: [
              { url: "http://localhost:10121", weight: 1 },
              { url: "http://localhost:10122", weight: 1 },
            ],
            balance: "round_robin",
          },
          // No health_check — should still route to both
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream1.close();
    await upstream2.close();
  });

  it("should route to all upstreams without health check config", async () => {
    const servers = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const res = await request(10120, "/api/no-check");
      assert.strictEqual(res.status, 200);
      servers.add((res.json() as { server: string }).server);
    }
    assert.strictEqual(servers.size, 2, "Should route to both servers");
  });
});
