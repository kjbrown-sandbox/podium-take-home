import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockUpstream, MockUpstream } from "./helpers/mock-upstream.js";
import { request } from "./helpers/request.js";
import { startGateway } from "../src/server.js";
import { GatewayConfig } from "../src/types.js";

describe("request header transform - add", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9901);
    const config: GatewayConfig = {
      gateway: {
        port: 9900,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/transformed",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9901" },
          request_transform: {
            headers: {
              add: {
                "X-Gateway": "gatewaykit",
                "X-Request-Start": "$request_time",
              },
            },
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

  it("should add static headers to the upstream request", async () => {
    const res = await request(9900, "/api/transformed");
    assert.strictEqual(res.status, 200);
    const body = res.json() as { headers: Record<string, string> };
    assert.strictEqual(body.headers["x-gateway"], "gatewaykit");
  });

  it("should resolve $request_time to a timestamp", async () => {
    const beforeMs = Date.now();
    const res = await request(9900, "/api/transformed");
    const afterMs = Date.now();
    const body = res.json() as { headers: Record<string, string> };
    const timestamp = Number(body.headers["x-request-start"]);
    assert.ok(!isNaN(timestamp), "Should be a numeric timestamp");
    assert.ok(timestamp >= beforeMs && timestamp <= afterMs, "Timestamp should be around now");
  });
});

describe("request header transform - remove", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9911);
    const config: GatewayConfig = {
      gateway: {
        port: 9910,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/stripped",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9911" },
          request_transform: {
            headers: {
              remove: ["X-Debug", "X-Internal"],
            },
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

  it("should remove specified headers before forwarding to upstream", async () => {
    const res = await request(9910, "/api/stripped", {
      headers: { "X-Debug": "true", "X-Internal": "secret", "X-Keep": "this" },
    });
    assert.strictEqual(res.status, 200);
    const body = res.json() as { headers: Record<string, string> };
    assert.strictEqual(body.headers["x-debug"], undefined);
    assert.strictEqual(body.headers["x-internal"], undefined);
    assert.strictEqual(body.headers["x-keep"], "this");
  });
});

describe("response header transform - add", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9921);
    const config: GatewayConfig = {
      gateway: {
        port: 9920,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/resp-add",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9921" },
          response_transform: {
            headers: {
              add: {
                "X-Served-By": "gatewaykit",
              },
            },
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

  it("should add headers to the response returned to the client", async () => {
    const res = await request(9920, "/api/resp-add");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers["x-served-by"], "gatewaykit");
  });
});

describe("response header transform - remove", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    // Upstream that sends headers we want to strip
    upstream = await createMockUpstream(9931, (req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Server": "upstream-server",
        "X-Powered-By": "Express",
        "X-Custom": "keep-me",
      });
      res.end(JSON.stringify({ ok: true }));
    });
    const config: GatewayConfig = {
      gateway: {
        port: 9930,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/resp-strip",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9931" },
          response_transform: {
            headers: {
              remove: ["Server", "X-Powered-By"],
            },
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

  it("should remove specified headers from upstream response", async () => {
    const res = await request(9930, "/api/resp-strip");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers["server"], undefined);
    assert.strictEqual(res.headers["x-powered-by"], undefined);
    assert.strictEqual(res.headers["x-custom"], "keep-me");
  });
});

describe("header transform - combined request and response", () => {
  let upstream: MockUpstream;
  let gateway: { close: () => Promise<void> };

  before(async () => {
    upstream = await createMockUpstream(9941);
    const config: GatewayConfig = {
      gateway: {
        port: 9940,
        global_timeout: "30s",
        global_rate_limit: { requests: 100, window: "60s", strategy: "fixed_window", per: "ip" },
      },
      routes: [
        {
          path: "/api/both",
          methods: ["GET"],
          strip_prefix: false,
          upstream: { url: "http://localhost:9941" },
          request_transform: {
            headers: {
              add: { "X-Gateway": "gatewaykit" },
              remove: ["X-Debug"],
            },
          },
          response_transform: {
            headers: {
              add: { "X-Served-By": "gatewaykit" },
            },
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

  it("should apply both request and response transforms", async () => {
    const res = await request(9940, "/api/both", {
      headers: { "X-Debug": "remove-me" },
    });
    assert.strictEqual(res.status, 200);
    // Request transform: added X-Gateway, removed X-Debug
    const body = res.json() as { headers: Record<string, string> };
    assert.strictEqual(body.headers["x-gateway"], "gatewaykit");
    assert.strictEqual(body.headers["x-debug"], undefined);
    // Response transform: added X-Served-By
    assert.strictEqual(res.headers["x-served-by"], "gatewaykit");
  });
});
