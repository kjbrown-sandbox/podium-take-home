// Top-level config structure
export interface GatewayConfig {
  gateway: GatewaySettings;
  routes: Route[];
}

export interface GatewaySettings {
  port: number;
  global_timeout: string;
  global_rate_limit: RateLimit;
}

// Route definition
export interface Route {
  path: string;
  methods: HttpMethod[];
  strip_prefix: boolean;
  upstream: Upstream;
  rate_limit?: RateLimit;
  retry?: Retry;
  auth?: Auth;
  circuit_breaker?: CircuitBreaker;
  health_check?: HealthCheck;
  request_transform?: RequestTransform;
  response_transform?: ResponseTransform;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

// Upstream — single URL or multiple weighted targets
export interface Upstream {
  url?: string;
  targets?: UpstreamTarget[];
  balance?: BalanceStrategy;
  timeout?: string;
}

export interface UpstreamTarget {
  url: string;
  weight: number;
}

export type BalanceStrategy = "round_robin" | "weighted_round_robin";

// Rate limiting
export interface RateLimit {
  requests: number;
  window: string;
  strategy: RateLimitStrategy;
  per: RateLimitScope;
}

export type RateLimitStrategy = "fixed_window" | "sliding_window";
export type RateLimitScope = "ip" | "global";

// Retry
export interface Retry {
  attempts: number;
  backoff: BackoffStrategy;
  initial_delay: string;
  on: number[];
}

export type BackoffStrategy = "fixed" | "exponential";

// Auth
export interface Auth {
  type: "api_key";
  header: string;
  keys: string[];
}

// Circuit breaker
export interface CircuitBreaker {
  threshold: number;
  window: string;
  cooldown: string;
}

// Health check
export interface HealthCheck {
  path: string;
  interval: string;
  unhealthy_threshold: number;
}

// Transforms
export interface HeaderTransform {
  add?: Record<string, string>;
  remove?: string[];
}

export interface RequestBodyTransform {
  mapping: Record<string, string>;
}

export interface ResponseBodyTransform {
  envelope: Record<string, unknown>;
}

export interface RequestTransform {
  headers?: HeaderTransform;
  body?: RequestBodyTransform;
}

export interface ResponseTransform {
  headers?: HeaderTransform;
  body?: ResponseBodyTransform;
}
