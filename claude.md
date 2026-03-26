# GatewayKit — Take-Home Project

## Project Overview

Build **GatewayKit**, a lightweight, config-driven API gateway. It sits between clients and upstream services, handling routing, rate limiting, request/response transformation, and resilience. Think simplified Kong/Envoy/AWS API Gateway — built from scratch.

It's important that I, the developer, have full control over what gets built. Check in frequently to see what my opinions are. Do not automatically implement things, but you may offer suggestions.

## Constraints

- **Language:** Use standard library HTTP server/client + a YAML parser only
- **No existing API gateway, reverse proxy, or HTTP proxy frameworks/libraries** — building the proxy logic is the point
- **Data storage:** In-memory only, no database
- **Must include:** Mock upstream server for self-contained tests

## Core Requirements (non-negotiable)

1. Gateway starts on **port 8080**, reads config from YAML file path (CLI arg or env var)
2. **GET /health** always returns `200 OK` with `{ "status": "healthy", "uptime_seconds": <int> }`
3. **Basic proxying** — matched routes forward to upstream, unmatched return 404
4. **Method filtering** — wrong method returns 405 Method Not Allowed
5. Must work with **any valid config** following the schema, not just the example

## Config Schema (gateway.yaml)

```yaml
gateway:
   port: 8080
   global_timeout: "30s"
   global_rate_limit:
      requests: 100
      window: "60s"
      strategy: "fixed_window" # or "sliding_window"
      per: "ip" # or "global"

routes:
   - path: "/api/users"
     methods: ["GET", "POST"]
     strip_prefix: false
     upstream:
        url: "http://localhost:3001"
     rate_limit: { requests: 30, window: "60s", strategy: "sliding_window", per: "ip" }

   - path: "/api/orders"
     methods: ["GET", "POST", "PUT"]
     strip_prefix: false
     upstream:
        url: "http://localhost:3002"
        timeout: "5s"
     retry: { attempts: 3, backoff: "exponential", initial_delay: "1s", on: [502, 503, 504] }
     rate_limit: { requests: 10, window: "10s", strategy: "fixed_window", per: "ip" }

   - path: "/api/products"
     methods: ["GET"]
     strip_prefix: true # /api/products/123 -> /123
     upstream:
        targets:
           - { url: "http://localhost:3003", weight: 3 }
           - { url: "http://localhost:3004", weight: 1 }
        balance: "weighted_round_robin" # or "round_robin"
        timeout: "10s"
     health_check: { path: "/healthz", interval: "30s", unhealthy_threshold: 3 }

   - path: "/api/legacy"
     methods: ["GET", "POST"]
     strip_prefix: true
     upstream:
        url: "http://localhost:3005"
     request_transform:
        headers:
           add: { X-Gateway: "gatewaykit", X-Request-Start: "$request_time" }
           remove: ["X-Debug", "X-Internal"]
        body:
           mapping:
              user.id: "userId"
              user.name: "userName"
              meta.source: "$literal:gateway"
              meta.timestamp: "$request_time"
     response_transform:
        headers:
           add: { X-Served-By: "gatewaykit" }
           remove: ["Server", "X-Powered-By"]
        body:
           envelope:
              data: "$body"
              gateway_metadata:
                 served_at: "$response_time"
                 route: "$route_path"

   - path: "/api/internal"
     methods: ["GET", "POST"]
     strip_prefix: false
     upstream:
        url: "http://localhost:3006"
     auth: { type: "api_key", header: "X-API-Key", keys: ["sk_live_abc123", "sk_live_def456"] }
     circuit_breaker:
        threshold: 5
        window: "60s"
        cooldown: "30s"
        # When tripped: 503 with { "error": "service_unavailable", "retry_after": <seconds_remaining> }
```

## What to Submit

1. Git repo with commit history showing progression
2. **DECISIONS.md** — prioritization, architecture, trade-offs, what's next, AI tool usage
3. **Working test suite** — single command, self-contained with mock upstreams
4. **README.md** — setup, run, test instructions, feature checklist

## Evaluation Criteria

| Category               | Weight | Focus                                                         |
| ---------------------- | ------ | ------------------------------------------------------------- |
| Architectural Judgment | 35%    | Prioritization, pipeline structure, extensibility, trade-offs |
| Code Quality           | 25%    | Readability, separation of concerns, testing                  |
| Production Thinking    | 25%    | Error handling, concurrency, failure modes                    |
| Communication          | 15%    | DECISIONS.md, commit story, README clarity                    |

## Feature Priority Order

1. Config parsing + health endpoint + basic proxying + method filtering (CORE)
2. strip_prefix + timeouts (global + per-route)
3. Rate limiting (fixed_window + sliding_window, per-ip + global)
4. Auth (api_key) + header transforms (add/remove)
5. Retry logic (fixed + exponential backoff)
6. Circuit breaker
7. Load balancing (round_robin + weighted_round_robin)
8. Health checks for upstream targets
9. Body transforms (request mapping + response envelope)

## Dynamic Variables

- `$request_time` — timestamp when request was received
- `$response_time` — timestamp when response is sent
- `$route_path` — the matched route path
- `$body` — original response body (for envelope wrapping)
- `$literal:<value>` — inject a literal string value
