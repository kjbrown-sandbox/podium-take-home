# GatewayKit

A lightweight, config-driven API gateway built from scratch in TypeScript.

## Prerequisites

- Node.js 20+
- npm

## Setup

```bash
npm install
```

## Running the Gateway

```bash
# Via CLI argument
npm start -- gateway.yaml

# Via environment variable
GATEWAY_CONFIG=gateway.yaml npm start
```

The gateway reads the config file and starts listening on the configured port (default 8080).

## Running Tests

```bash
npm test
```

Tests are self-contained — they spin up mock upstream servers and gateway instances on ephemeral ports. No external services needed.

## Implemented Features

- [x] Config parsing from YAML file (CLI arg or env var)
- [x] Health endpoint (`GET /health` returns status + uptime)
- [x] Basic proxying (prefix-based route matching, forwarding to upstream)
- [x] Method filtering (405 for disallowed methods)
- [x] 404 for unmatched routes
- [x] `strip_prefix` (strip route path before forwarding)
- [x] Timeouts (global + per-route override, 504 on timeout)
- [x] Rate limiting — fixed window
- [x] Rate limiting — sliding window (weighted approximation)
- [x] Rate limiting — per-IP and global bucket modes
- [x] Rate limiting — route-level override of global config
- [x] Auth — API key validation via configurable header
- [x] Retry — fixed and exponential backoff
- [x] Retry — configurable retryable status codes
- [x] Circuit breaker — trips after threshold failures
- [x] Circuit breaker — cooldown and recovery
- [x] Circuit breaker — 503 response with `retry_after`
- [x] Request header transforms — add (with `$request_time` variable) and remove
- [x] Response header transforms — add and remove
- [x] Load balancing — round robin
- [x] Load balancing — weighted round robin

## Not Implemented

- [ ] Health checks for upstream targets (background pings)
- [ ] Request body transforms (dot-notation field mapping)
- [ ] Response body transforms (envelope wrapping)

## Architecture

The gateway is structured as a pipeline:

1. **Route matching** — longest prefix match
2. **Rate limiting** — per-route or global fallback, injectable clock for testing
3. **Health endpoint** — handled before 404 check
4. **Method filtering** — 405 for wrong methods
5. **Auth** — API key check if configured
6. **Circuit breaker** — blocks requests if upstream is failing
7. **Proxy** — buffers request body, forwards to upstream (with target selection for load balancing), applies header transforms, retries on configured status codes

Each feature is a separate module (`rate-limiter.ts`, `circuit-breaker.ts`) wired together in `server.ts`.
