import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockUpstream, MockUpstream } from "./helpers/mock-upstream.js";
import { request } from "./helpers/request.js";
import { startGateway } from "../src/server.js";
import { GatewayConfig } from "../src/types.js";
import { createServer } from "node:http";

/** Creates a mock that identifies itself in responses. */
function createIdentifiedUpstream(
  port: number,
  id: string
): Promise<MockUpstream> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ server: id, url: req.url }));
    });
    server.listen(port, () => {
      resolve({
        server,
        port,
        requests: [],
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("load balancing - round robin", () => {
  let upstream1: MockUpstream;
  let upstream2: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream1 = await createIdentifiedUpstream(10001, "server-1");
    upstream2 = await createIdentifiedUpstream(10002, "server-2");
    const config: GatewayConfig = {
      gateway: {
        port: 10000,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/balanced",
          methods: ["GET"],
          strip_prefix: false,
          upstream: {
            targets: [
              { url: "http://localhost:10001", weight: 1 },
              { url: "http://localhost:10002", weight: 1 },
            ],
            balance: "round_robin",
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

  it("should alternate between targets", async () => {
    const res1 = await request(10000, "/api/balanced");
    const res2 = await request(10000, "/api/balanced");
    const res3 = await request(10000, "/api/balanced");
    const res4 = await request(10000, "/api/balanced");

    const servers = [
      (res1.json() as { server: string }).server,
      (res2.json() as { server: string }).server,
      (res3.json() as { server: string }).server,
      (res4.json() as { server: string }).server,
    ];

    // Should alternate: 1, 2, 1, 2
    assert.strictEqual(servers[0], "server-1");
    assert.strictEqual(servers[1], "server-2");
    assert.strictEqual(servers[2], "server-1");
    assert.strictEqual(servers[3], "server-2");
  });
});

describe("load balancing - weighted round robin", () => {
  let upstream1: MockUpstream;
  let upstream2: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream1 = await createIdentifiedUpstream(10011, "heavy");
    upstream2 = await createIdentifiedUpstream(10012, "light");
    const config: GatewayConfig = {
      gateway: {
        port: 10010,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/weighted",
          methods: ["GET"],
          strip_prefix: false,
          upstream: {
            targets: [
              { url: "http://localhost:10011", weight: 3 },
              { url: "http://localhost:10012", weight: 1 },
            ],
            balance: "weighted_round_robin",
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

  it("should distribute requests according to weight", async () => {
    const servers: string[] = [];
    // Send 8 requests (two full cycles of weight 3+1=4)
    for (let i = 0; i < 8; i++) {
      const res = await request(10010, "/api/weighted");
      servers.push((res.json() as { server: string }).server);
    }

    const heavyCount = servers.filter((s) => s === "heavy").length;
    const lightCount = servers.filter((s) => s === "light").length;

    // Weight ratio is 3:1, so in 8 requests expect 6 heavy, 2 light
    assert.strictEqual(heavyCount, 6);
    assert.strictEqual(lightCount, 2);
  });
});

describe("load balancing - strip_prefix with targets", () => {
  let upstream1: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream1 = await createIdentifiedUpstream(10021, "target");
    const config: GatewayConfig = {
      gateway: {
        port: 10020,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/products",
          methods: ["GET"],
          strip_prefix: true,
          upstream: {
            targets: [{ url: "http://localhost:10021", weight: 1 }],
            balance: "round_robin",
          },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream1.close();
  });

  it("should strip prefix when using targets", async () => {
    const res = await request(10020, "/api/products/123");
    assert.strictEqual(res.status, 200);
    const body = res.json() as { url: string };
    assert.strictEqual(body.url, "/123");
  });
});

describe("load balancing - single url still works", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(10031);
    const config: GatewayConfig = {
      gateway: {
        port: 10030,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/single",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:10031" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should still work with a single url upstream", async () => {
    const res = await request(10030, "/api/single");
    assert.strictEqual(res.status, 200);
  });
});
