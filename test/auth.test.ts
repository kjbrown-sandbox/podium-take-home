import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockUpstream, MockUpstream } from "./helpers/mock-upstream.js";
import { request } from "./helpers/request.js";
import { startGateway } from "../src/server.js";
import { GatewayConfig } from "../src/types.js";

describe("auth - api_key", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9601);
    const config: GatewayConfig = {
      gateway: {
        port: 9600,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/secure",
          methods: ["GET", "POST"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9601" },
          auth: {
            type: "api_key",
            header: "X-API-Key",
            keys: ["valid-key-1", "valid-key-2"],
          },
        },
        {
          path: "/api/public",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9601" },
        },
      ],
    };
    gateway = await startGateway(config);
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it("should allow request with valid API key", async () => {
    const res = await request(9600, "/api/secure", {
      headers: { "X-API-Key": "valid-key-1" },
    });
    assert.strictEqual(res.status, 200);
  });

  it("should allow request with any valid key", async () => {
    const res = await request(9600, "/api/secure", {
      headers: { "X-API-Key": "valid-key-2" },
    });
    assert.strictEqual(res.status, 200);
  });

  it("should return 401 when API key is missing", async () => {
    const res = await request(9600, "/api/secure");
    assert.strictEqual(res.status, 401);
    const body = res.json() as { error: string };
    assert.strictEqual(body.error, "unauthorized");
  });

  it("should return 401 when API key is invalid", async () => {
    const res = await request(9600, "/api/secure", {
      headers: { "X-API-Key": "wrong-key" },
    });
    assert.strictEqual(res.status, 401);
  });

  it("should not require auth on routes without auth config", async () => {
    const res = await request(9600, "/api/public");
    assert.strictEqual(res.status, 200);
  });

  it("should check auth before proxying (invalid key should not reach upstream)", async () => {
    const countBefore = upstream.requests.length;
    await request(9600, "/api/secure", {
      headers: { "X-API-Key": "wrong-key" },
    });
    assert.strictEqual(upstream.requests.length, countBefore);
  });
});
