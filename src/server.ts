import {
  createServer,
  IncomingMessage,
  ServerResponse,
  Server,
  request as httpRequest,
} from "node:http";
import { GatewayConfig, Route } from "./types.js";
import { createRateLimiter, RateLimiter } from "./rate-limiter.js";

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

function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: Route,
  globalTimeout: string
): void {
  const upstreamUrl = new URL(route.upstream.url!);
  const upstreamPath = buildUpstreamPath(route, req.url ?? "/");
  const timeout = getTimeout(route, globalTimeout);

  const proxyReq = httpRequest(
    {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      path: upstreamPath,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.setTimeout(timeout, () => {
    proxyReq.destroy();
    res.writeHead(504, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "gateway_timeout" }));
  });

  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad_gateway" }));
    }
  });

  req.pipe(proxyReq);
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

    // Proxy to upstream
    proxyRequest(req, res, route, config.gateway.global_timeout);
  });

  return server;
}

export function startGateway(
  config: GatewayConfig
): Promise<{ server: Server; close: () => Promise<void> }> {
  const server = createGateway(config);
  return new Promise((resolve) => {
    server.listen(config.gateway.port, () => {
      resolve({
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
