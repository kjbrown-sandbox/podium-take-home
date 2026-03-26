import {
  createServer,
  IncomingMessage,
  ServerResponse,
  Server,
  request as httpRequest,
} from "node:http";
import { GatewayConfig, Route, Upstream } from "./types.js";
import { createRateLimiter, RateLimiter } from "./rate-limiter.js";
import { createCircuitBreaker, CircuitBreakerInstance } from "./circuit-breaker.js";

export interface TargetSelector {
  next(): string | null;
  stop?(): void;
}

export function createTargetSelector(
  upstream: Upstream,
  healthCheck?: import("./types.js").HealthCheck
): TargetSelector {
  // Single URL — always return it
  if (upstream.url) {
    return { next: () => upstream.url! };
  }

  const targets = upstream.targets!;
  const balance = upstream.balance ?? "round_robin";
  const healthy = new Set<string>(targets.map((t) => t.url));
  let intervals: ReturnType<typeof setInterval>[] = [];

  // Start health checks if configured
  if (healthCheck) {
    const intervalMs = parseDuration(healthCheck.interval);
    const threshold = healthCheck.unhealthy_threshold;
    const failCounts = new Map<string, number>();

    for (const target of targets) {
      failCounts.set(target.url, 0);

      const timer = setInterval(() => {
        const url = new URL(healthCheck.path, target.url);
        const req = httpRequest(url, (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            failCounts.set(target.url, 0);
            healthy.add(target.url);
          } else {
            const count = (failCounts.get(target.url) ?? 0) + 1;
            failCounts.set(target.url, count);
            if (count >= threshold) {
              healthy.delete(target.url);
            }
          }
          res.resume(); // drain the response
        });
        req.on("error", () => {
          const count = (failCounts.get(target.url) ?? 0) + 1;
          failCounts.set(target.url, count);
          if (count >= threshold) {
            healthy.delete(target.url);
          }
        });
        req.setTimeout(5000, () => req.destroy());
        req.end();
      }, intervalMs);

      intervals.push(timer);
    }
  }

  if (balance === "round_robin") {
    let index = 0;
    return {
      next() {
        const urls = targets.map((t) => t.url).filter((u) => healthy.has(u));
        if (urls.length === 0) return null;
        const url = urls[index % urls.length];
        index++;
        return url;
      },
      stop() {
        intervals.forEach(clearInterval);
      },
    };
  }

  // Weighted round robin
  let index = 0;
  return {
    next() {
      const sequence: string[] = [];
      for (const target of targets) {
        if (healthy.has(target.url)) {
          for (let i = 0; i < target.weight; i++) {
            sequence.push(target.url);
          }
        }
      }
      if (sequence.length === 0) return null;
      const url = sequence[index % sequence.length];
      index++;
      return url;
    },
    stop() {
      intervals.forEach(clearInterval);
    },
  };
}

export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m)$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60_000;
    default: throw new Error(`Unknown duration unit: ${match[2]}`);
  }
}

function matchRoute(routes: Route[], pathname: string): Route | undefined {
  // Match the most specific (longest) prefix first
  let best: Route | undefined;
  for (const route of routes) {
    if (pathname === route.path || pathname.startsWith(route.path + "/")) {
      if (!best || route.path.length > best.path.length) {
        best = route;
      }
    }
  }
  return best;
}

function buildUpstreamPath(route: Route, originalPath: string): string {
  if (route.strip_prefix) {
    const stripped = originalPath.slice(route.path.length);
    return stripped || "/";
  }
  return originalPath;
}

function getTimeout(route: Route, globalTimeout: string): number {
  const timeoutStr = route.upstream.timeout ?? globalTimeout;
  return parseDuration(timeoutStr);
}

function resolveVariable(value: string, requestTime: number, routePath: string): string {
  if (value === "$request_time") return String(requestTime);
  if (value === "$response_time") return String(Date.now());
  if (value === "$route_path") return routePath;
  if (value.startsWith("$literal:")) return value.slice("$literal:".length);
  return value;
}

function applyResponseHeaderTransform(
  headers: Record<string, string | string[] | undefined>,
  route: Route
): Record<string, string | string[] | undefined> {
  if (!route.response_transform?.headers) return headers;
  const result = { ...headers };
  const { add, remove } = route.response_transform.headers;
  if (remove) {
    for (const name of remove) {
      delete result[name.toLowerCase()];
    }
  }
  if (add) {
    for (const [name, value] of Object.entries(add)) {
      result[name.toLowerCase()] = value;
    }
  }
  return result;
}

function bufferBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function sendUpstreamRequest(
  method: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  upstreamUrl: URL,
  upstreamPath: string,
  timeout: number
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const proxyReq = httpRequest(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: upstreamPath,
        method,
        headers,
      },
      (proxyRes) => {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk) => chunks.push(chunk));
        proxyRes.on("end", () => {
          resolve({
            statusCode: proxyRes.statusCode ?? 502,
            headers: proxyRes.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
          });
        });
      }
    );

    proxyReq.setTimeout(timeout, () => {
      proxyReq.destroy();
      reject(new Error("timeout"));
    });

    proxyReq.on("error", (err) => reject(err));

    proxyReq.end(body);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number, backoff: string, initialDelayMs: number): number {
  if (backoff === "exponential") {
    return initialDelayMs * Math.pow(2, attempt);
  }
  return initialDelayMs;
}

async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: Route,
  globalTimeout: string,
  circuitBreaker?: CircuitBreakerInstance,
  targetSelector?: TargetSelector
): Promise<void> {
  // Circuit breaker check
  if (circuitBreaker) {
    const blocked = circuitBreaker.allowRequest();
    if (blocked) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "service_unavailable", retry_after: blocked.retry_after }));
      return;
    }
  }

  const selectedUrl = targetSelector ? targetSelector.next() : route.upstream.url!;
  if (!selectedUrl) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no_healthy_upstreams" }));
    return;
  }
  const upstreamUrl = new URL(selectedUrl);
  const upstreamPath = buildUpstreamPath(route, req.url ?? "/");
  const timeout = getTimeout(route, globalTimeout);
  const body = await bufferBody(req);
  const requestTime = Date.now();

  // Apply request header transforms
  const headers = { ...req.headers };
  if (route.request_transform?.headers) {
    const { add, remove } = route.request_transform.headers;
    if (remove) {
      for (const name of remove) {
        delete headers[name.toLowerCase()];
      }
    }
    if (add) {
      for (const [name, value] of Object.entries(add)) {
        headers[name.toLowerCase()] = resolveVariable(value, requestTime, route.path);
      }
    }
  }

  const maxAttempts = route.retry ? 1 + route.retry.attempts : 1;
  const retryOn = route.retry?.on ?? [];
  const initialDelayMs = route.retry ? parseDuration(route.retry.initial_delay) : 0;
  const backoff = route.retry?.backoff ?? "fixed";

  let lastStatusCode = 502;
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  let lastBody = Buffer.alloc(0);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await delay(getRetryDelay(attempt - 1, backoff, initialDelayMs));
    }

    try {
      const result = await sendUpstreamRequest(
        req.method ?? "GET",
        headers,
        body,
        upstreamUrl,
        upstreamPath,
        timeout
      );

      lastStatusCode = result.statusCode;
      lastHeaders = result.headers;
      lastBody = result.body;

      // If status is not retryable, or not configured for retry, return immediately
      if (!retryOn.includes(result.statusCode)) {
        if (result.statusCode >= 500) {
          circuitBreaker?.recordFailure();
        } else {
          circuitBreaker?.recordSuccess();
        }
        const responseHeaders = applyResponseHeaderTransform(result.headers, route);
        res.writeHead(result.statusCode, responseHeaders);
        res.end(result.body);
        return;
      }
    } catch (err) {
      if ((err as Error).message === "timeout") {
        lastStatusCode = 504;
        lastHeaders = { "Content-Type": "application/json" };
        lastBody = Buffer.from(JSON.stringify({ error: "gateway_timeout" }));
      } else {
        lastStatusCode = 502;
        lastHeaders = { "Content-Type": "application/json" };
        lastBody = Buffer.from(JSON.stringify({ error: "bad_gateway" }));
      }
    }
  }

  // All retries exhausted — record failure and return last response
  circuitBreaker?.recordFailure();
  const responseHeaders = applyResponseHeaderTransform(lastHeaders, route);
  res.writeHead(lastStatusCode, responseHeaders);
  res.end(lastBody);
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return first.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function getRateLimitKey(req: IncomingMessage, per: string): string {
  return per === "global" ? "global" : getClientIp(req);
}

export function createGateway(config: GatewayConfig): Server {
  const startTime = Date.now();

  // Create rate limiters: one per route, plus a global fallback
  const globalLimiter = createRateLimiter(config.gateway.global_rate_limit);
  const routeLimiters = new Map<string, RateLimiter>();
  for (const route of config.routes) {
    if (route.rate_limit) {
      routeLimiters.set(route.path, createRateLimiter(route.rate_limit));
    }
  }

  // Create circuit breakers per route
  const circuitBreakers = new Map<string, CircuitBreakerInstance>();
  for (const route of config.routes) {
    if (route.circuit_breaker) {
      circuitBreakers.set(route.path, createCircuitBreaker(route.circuit_breaker));
    }
  }

  // Create target selectors per route (with health checks if configured)
  const targetSelectors = new Map<string, TargetSelector>();
  for (const route of config.routes) {
    targetSelectors.set(route.path, createTargetSelector(route.upstream, route.health_check));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Route matching (null for /health and unmatched paths)
    const route = matchRoute(config.routes, pathname);

    // Rate limiting — route-level if present, otherwise global
    const rateLimitConfig = route?.rate_limit ?? config.gateway.global_rate_limit;
    const limiter = (route && routeLimiters.get(route.path)) ?? globalLimiter;
    const key = getRateLimitKey(req, rateLimitConfig.per);
    if (!limiter.check(key).allowed) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate_limit_exceeded" }));
      return;
    }

    // Health endpoint
    if (pathname === "/health") {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", uptime_seconds: uptimeSeconds }));
      return;
    }

    // 404 for unmatched routes
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    // Method filtering
    if (!route.methods.includes(req.method as any)) {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    // Auth
    if (route.auth) {
      const apiKey = req.headers[route.auth.header.toLowerCase()] as string | undefined;
      if (!apiKey || !route.auth.keys.includes(apiKey)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    // Proxy to upstream
    const cb = circuitBreakers.get(route.path);
    const ts = targetSelectors.get(route.path);
    proxyRequest(req, res, route, config.gateway.global_timeout, cb, ts);
  });

  return { server, targetSelectors };
}

export function startGateway(
  config: GatewayConfig
): Promise<{ server: Server; close: () => Promise<void> }> {
  const { server, targetSelectors } = createGateway(config);
  return new Promise((resolve) => {
    server.listen(config.gateway.port, () => {
      resolve({
        server,
        close: () => {
          targetSelectors.forEach((ts) => ts.stop?.());
          return new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
