import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseConfig } from "../src/config.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "gateway.yaml");

describe("parseConfig", () => {
  it("should parse config without throwing", () => {
    assert.doesNotThrow(() => parseConfig(fixturePath));
  });

  describe("gateway settings", () => {
    it("should parse port as a number", () => {
      const config = parseConfig(fixturePath);
      assert.strictEqual(config.gateway.port, 8080);
    });

    it("should parse global_timeout as a string", () => {
      const config = parseConfig(fixturePath);
      assert.strictEqual(config.gateway.global_timeout, "30s");
    });

    it("should parse global_rate_limit with all fields", () => {
      const config = parseConfig(fixturePath);
      assert.deepStrictEqual(config.gateway.global_rate_limit, {
        requests: 100,
        window: "60s",
        strategy: "fixed_window",
        per: "ip",
      });
    });
  });

  describe("routes", () => {
    it("should parse all 5 routes", () => {
      const config = parseConfig(fixturePath);
      assert.strictEqual(config.routes.length, 5);
    });

    it("should parse route paths", () => {
      const config = parseConfig(fixturePath);
      const paths = config.routes.map((r) => r.path);
      assert.deepStrictEqual(paths, [
        "/api/users",
        "/api/orders",
        "/api/products",
        "/api/legacy",
        "/api/internal",
      ]);
    });

    it("should parse methods as string arrays", () => {
      const config = parseConfig(fixturePath);
      assert.deepStrictEqual(config.routes[0].methods, ["GET", "POST"]);
      assert.deepStrictEqual(config.routes[1].methods, [
        "GET",
        "POST",
        "PUT",
      ]);
      assert.deepStrictEqual(config.routes[2].methods, ["GET"]);
    });

    it("should parse strip_prefix as boolean", () => {
      const config = parseConfig(fixturePath);
      assert.strictEqual(config.routes[0].strip_prefix, false);
      assert.strictEqual(config.routes[2].strip_prefix, true);
      assert.strictEqual(config.routes[3].strip_prefix, true);
    });
  });

  describe("upstream - single target", () => {
    it("should parse url for simple upstream", () => {
      const config = parseConfig(fixturePath);
      assert.strictEqual(
        config.routes[0].upstream.url,
        "http://localhost:3001"
      );
    });

    it("should parse optional timeout", () => {
      const config = parseConfig(fixturePath);
      assert.strictEqual(config.routes[1].upstream.timeout, "5s");
      assert.strictEqual(config.routes[0].upstream.timeout, undefined);
    });
  });

  describe("upstream - weighted targets", () => {
    it("should parse targets array with url and weight", () => {
      const config = parseConfig(fixturePath);
      assert.deepStrictEqual(config.routes[2].upstream.targets, [
        { url: "http://localhost:3003", weight: 3 },
        { url: "http://localhost:3004", weight: 1 },
      ]);
    });

    it("should parse balance strategy", () => {
      const config = parseConfig(fixturePath);
      assert.strictEqual(
        config.routes[2].upstream.balance,
        "weighted_round_robin"
      );
    });
  });

  describe("rate limiting", () => {
    it("should parse route-level rate limit for /api/users", () => {
      const config = parseConfig(fixturePath);
      assert.deepStrictEqual(config.routes[0].rate_limit, {
        requests: 30,
        window: "60s",
        strategy: "sliding_window",
        per: "ip",
      });
    });

    it("should parse route-level rate limit for /api/orders", () => {
      const config = parseConfig(fixturePath);
      assert.deepStrictEqual(config.routes[1].rate_limit, {
        requests: 10,
        window: "10s",
        strategy: "fixed_window",
        per: "ip",
      });
    });
  });

  describe("retry", () => {
    it("should parse retry config for /api/orders", () => {
      const config = parseConfig(fixturePath);
      const retry = config.routes[1].retry;
      assert.ok(retry);
      assert.strictEqual(retry.attempts, 3);
      assert.strictEqual(retry.backoff, "exponential");
      assert.strictEqual(retry.initial_delay, "1s");
      assert.deepStrictEqual(retry.on, [502, 503, 504]);
    });

    it("should not have retry on routes without it", () => {
      const config = parseConfig(fixturePath);
      assert.strictEqual(config.routes[0].retry, undefined);
    });
  });

  describe("auth", () => {
    it("should parse api_key auth for /api/internal", () => {
      const config = parseConfig(fixturePath);
      const auth = config.routes[4].auth;
      assert.ok(auth);
      assert.strictEqual(auth.type, "api_key");
      assert.strictEqual(auth.header, "X-API-Key");
      assert.deepStrictEqual(auth.keys, [
        "sk_live_abc123",
        "sk_live_def456",
      ]);
    });

    it("should not have auth on routes without it", () => {
      const config = parseConfig(fixturePath);
      assert.strictEqual(config.routes[0].auth, undefined);
    });
  });

  describe("circuit breaker", () => {
    it("should parse circuit breaker for /api/internal", () => {
      const config = parseConfig(fixturePath);
      const cb = config.routes[4].circuit_breaker;
      assert.ok(cb);
      assert.strictEqual(cb.threshold, 5);
      assert.strictEqual(cb.window, "60s");
      assert.strictEqual(cb.cooldown, "30s");
    });
  });

  describe("health check", () => {
    it("should parse health check for /api/products", () => {
      const config = parseConfig(fixturePath);
      const hc = config.routes[2].health_check;
      assert.ok(hc);
      assert.strictEqual(hc.path, "/healthz");
      assert.strictEqual(hc.interval, "30s");
      assert.strictEqual(hc.unhealthy_threshold, 3);
    });
  });

  describe("request transform", () => {
    it("should parse header additions", () => {
      const config = parseConfig(fixturePath);
      const rt = config.routes[3].request_transform;
      assert.ok(rt?.headers?.add);
      assert.strictEqual(rt.headers.add["X-Gateway"], "gatewaykit");
      assert.strictEqual(rt.headers.add["X-Request-Start"], "$request_time");
    });

    it("should parse header removals", () => {
      const config = parseConfig(fixturePath);
      const rt = config.routes[3].request_transform;
      assert.ok(rt?.headers?.remove);
      assert.deepStrictEqual(rt.headers.remove, ["X-Debug", "X-Internal"]);
    });

    it("should parse body mapping", () => {
      const config = parseConfig(fixturePath);
      const rt = config.routes[3].request_transform;
      assert.ok(rt?.body?.mapping);
      assert.strictEqual(rt.body.mapping["user.id"], "userId");
      assert.strictEqual(rt.body.mapping["user.name"], "userName");
      assert.strictEqual(rt.body.mapping["meta.source"], "$literal:gateway");
      assert.strictEqual(rt.body.mapping["meta.timestamp"], "$request_time");
    });
  });

  describe("response transform", () => {
    it("should parse header additions", () => {
      const config = parseConfig(fixturePath);
      const rt = config.routes[3].response_transform;
      assert.ok(rt?.headers?.add);
      assert.strictEqual(rt.headers.add["X-Served-By"], "gatewaykit");
    });

    it("should parse header removals", () => {
      const config = parseConfig(fixturePath);
      const rt = config.routes[3].response_transform;
      assert.ok(rt?.headers?.remove);
      assert.deepStrictEqual(rt.headers.remove, ["Server", "X-Powered-By"]);
    });

    it("should parse body envelope structure", () => {
      const config = parseConfig(fixturePath);
      const rt = config.routes[3].response_transform;
      assert.ok(rt?.body?.envelope);
      assert.strictEqual(rt.body.envelope["data"], "$body");
    });

    it("should preserve nested envelope structure with $variables", () => {
      const config = parseConfig(fixturePath);
      const rt = config.routes[3].response_transform;
      assert.ok(rt?.body?.envelope);
      const metadata = rt.body.envelope["gateway_metadata"] as Record<
        string,
        unknown
      >;
      assert.strictEqual(metadata["served_at"], "$response_time");
      assert.strictEqual(metadata["route"], "$route_path");
    });
  });
});
