// =================================================================
// got-api-engine — Core Types
// =================================================================

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type AuthMode =
  | boolean          // true = required, false = none
  | "optional"       // forward token if present
  | "bearer"         // alias for true
  | "none";          // alias for false

// ── Zod-compatible schema shape (avoids hard peer-dep) ──────────
export interface ZodLike<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } };
}

// ── Logger interface — bring your own logger ─────────────────────
export interface LoggerInterface {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child?(meta: Record<string, unknown>): LoggerInterface;
}

// ── Auth provider — pluggable ────────────────────────────────────
export interface AuthProvider {
  /**
   * Return the Authorization header value (e.g. "Bearer <token>")
   * or null/undefined if no auth is available.
   */
  getAuthHeader(): string | null | undefined | Promise<string | null | undefined>;
}

// ── Request / Response hooks ─────────────────────────────────────
export interface RequestHookContext {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ResponseHookContext {
  url: string;
  method: HttpMethod;
  status: number;
  body: unknown;
  durationMs: number;
}

export interface ErrorHookContext {
  url: string;
  method: HttpMethod;
  error: unknown;
  durationMs: number;
}

export type RequestHook = (ctx: RequestHookContext) => void | Promise<void>;
export type ResponseHook = (ctx: ResponseHookContext) => void | Promise<void>;
export type ErrorHook = (ctx: ErrorHookContext) => void | Promise<void>;

// ── Engine-level configuration ───────────────────────────────────
export interface EngineConfig {
  /**
   * Base URL of your backend API.
   * @example "https://api.myapp.com"
   */
  baseUrl: string;

  /**
   * Default auth mode for all requests.
   * @default true  (auth required)
   */
  defaultAuth?: AuthMode;

  /**
   * Auth provider. Can be a static token string, a function, or an AuthProvider object.
   */
  auth?: string | (() => string | null | undefined | Promise<string | null | undefined>) | AuthProvider;

  /**
   * Default timeout in milliseconds.
   * @default 10000
   */
  timeoutMs?: number;

  /**
   * Default retry limit for retryable methods (GET, PUT).
   * @default 2
   */
  retryLimit?: number;

  /**
   * Custom logger. If omitted, falls back to built-in winston logger or console.
   */
  logger?: LoggerInterface;

  /**
   * Enable verbose debug logging.
   * @default false
   */
  debug?: boolean;

  /**
   * Service name used in log output.
   * @default "got-api-engine"
   */
  serviceName?: string;

  /**
   * Static headers added to every request.
   */
  defaultHeaders?: Record<string, string>;

  /**
   * Whether to reject self-signed TLS certificates.
   * Automatically false in development (NODE_ENV !== "production").
   * @default true in production
   */
  rejectUnauthorized?: boolean;

  /**
   * Lifecycle hooks.
   */
  hooks?: {
    onRequest?: RequestHook | RequestHook[];
    onResponse?: ResponseHook | ResponseHook[];
    onError?: ErrorHook | ErrorHook[];
    /** Fired when the circuit breaker changes state. */
    onCircuitStateChange?: CircuitStateHook | CircuitStateHook[];
    /** Fired right before a retry attempt. */
    onRetry?: RetryHook | RetryHook[];
  };

  /**
   * Response caching for safe (GET/HEAD) requests.
   * Disabled unless `enabled: true`.
   */
  cache?: CacheConfig;

  /**
   * Circuit breaker — stop hammering a failing upstream.
   * Disabled unless `enabled: true`.
   */
  circuitBreaker?: CircuitBreakerConfig;

  /**
   * Client-side rate limiting (token bucket).
   * Disabled unless `enabled: true`.
   */
  rateLimit?: RateLimitConfig;

  /**
   * Deduplicate identical in-flight GET/HEAD requests (single-flight).
   * @default true
   */
  dedupe?: boolean;

  /**
   * Exponential backoff retry layer applied on top of got's own retry.
   * Adds jitter and retries on network errors + configurable status codes.
   */
  retry?: RetryConfig;

  /**
   * SSRF protection — block requests resolving to private/loopback ranges
   * and disallow cross-origin redirects. Recommended `true` for any engine
   * that forwards user-controlled URLs.
   * @default false
   */
  ssrfProtection?: boolean | SsrfConfig;

  /**
   * Header/body keys to redact in logs (case-insensitive).
   * Merged with sensible defaults (authorization, cookie, set-cookie, etc.).
   */
  redactKeys?: string[];

  /**
   * Collect runtime metrics (counts, latency percentiles, circuit state).
   * @default true
   */
  metrics?: boolean;

  /**
   * Automatically attach an `Idempotency-Key` header to mutating requests
   * so safe retries don't double-execute on the server.
   * @default false
   */
  idempotency?: boolean;
}

// ── Retry configuration ──────────────────────────────────────────
export interface RetryConfig {
  /** Max retry attempts (beyond the first try). @default 2 */
  limit?: number;
  /** Base delay in ms for exponential backoff. @default 200 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. @default 10000 */
  maxDelayMs?: number;
  /** Jitter factor 0–1 applied to each delay. @default 0.2 */
  jitter?: number;
  /** HTTP status codes that should trigger a retry. @default [408,425,429,500,502,503,504] */
  retryStatusCodes?: number[];
  /** HTTP methods eligible for retry. @default ["GET","HEAD","PUT","DELETE","OPTIONS"] */
  methods?: HttpMethod[];
  /** Respect a `Retry-After` response header when present. @default true */
  respectRetryAfter?: boolean;
}

// ── Response cache configuration ─────────────────────────────────
export interface CacheConfig {
  enabled?: boolean;
  /** Default TTL in ms for cached responses. @default 30000 */
  ttlMs?: number;
  /** Max number of cached entries (LRU eviction). @default 500 */
  maxEntries?: number;
  /**
   * Serve a stale cached response immediately while revalidating in the
   * background. @default false
   */
  staleWhileRevalidate?: boolean;
  /** Methods eligible for caching. @default ["GET","HEAD"] */
  methods?: HttpMethod[];
  /** Provide a custom cache store (e.g. Redis-backed). */
  store?: CacheStore;
  /**
   * Honor `ETag` / `Last-Modified` for conditional revalidation
   * (sends `If-None-Match` / `If-Modified-Since`). @default true
   */
  conditional?: boolean;
}

/** Pluggable cache store. Defaults to an in-memory LRU. */
export interface CacheStore {
  get(key: string): CachedResponse | undefined | Promise<CachedResponse | undefined>;
  set(key: string, value: CachedResponse, ttlMs: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

export interface CachedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** Epoch ms when this entry expires (becomes stale). */
  expiresAt: number;
  etag?: string | undefined;
  lastModified?: string | undefined;
  storedAt: number;
}

// ── Circuit breaker configuration ────────────────────────────────
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  enabled?: boolean;
  /** Consecutive failures before opening the circuit. @default 5 */
  failureThreshold?: number;
  /**
   * Rolling failure-rate threshold (0–1). If set, the circuit opens when the
   * error rate over `rollingWindow` requests exceeds this value.
   */
  failureRateThreshold?: number;
  /** Number of recent requests considered for failure-rate. @default 20 */
  rollingWindow?: number;
  /** Time in ms the circuit stays open before trying half-open. @default 30000 */
  resetTimeoutMs?: number;
  /** Successes required in half-open to fully close. @default 2 */
  successThreshold?: number;
  /** Status codes counted as failures. @default [500,502,503,504] */
  failureStatusCodes?: number[];
}

// ── Rate limit configuration (token bucket) ──────────────────────
export interface RateLimitConfig {
  enabled?: boolean;
  /** Sustained requests per interval. @default 10 */
  requestsPerInterval?: number;
  /** Interval window in ms. @default 1000 */
  intervalMs?: number;
  /** Max burst (bucket capacity). @default = requestsPerInterval */
  burst?: number;
  /**
   * When the bucket is empty: "wait" (queue until a token frees up) or
   * "reject" (fail fast with status 429). @default "wait"
   */
  onLimit?: "wait" | "reject";
  /** Max time to wait for a token in "wait" mode (ms). @default 10000 */
  maxWaitMs?: number;
}

// ── SSRF protection configuration ────────────────────────────────
export interface SsrfConfig {
  enabled?: boolean;
  /** Allow requests to private/loopback IP ranges. @default false */
  allowPrivateNetworks?: boolean;
  /** Explicit allowlist of hostnames (exact or *.suffix). */
  allowHosts?: string[];
  /** Explicit blocklist of hostnames. */
  blockHosts?: string[];
  /** Follow redirects only within the original origin. @default true */
  sameOriginRedirectsOnly?: boolean;
}

// ── Circuit / retry hooks ────────────────────────────────────────
export interface CircuitStateContext {
  from: CircuitState;
  to: CircuitState;
  serviceName: string;
  failureCount: number;
}

export interface RetryHookContext {
  url: string;
  method: HttpMethod;
  attempt: number;
  delayMs: number;
  reason: string;
}

export type CircuitStateHook = (ctx: CircuitStateContext) => void | Promise<void>;
export type RetryHook = (ctx: RetryHookContext) => void | Promise<void>;

// ── Metrics snapshot ─────────────────────────────────────────────
export interface MetricsSnapshot {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  retryCount: number;
  cacheHits: number;
  cacheMisses: number;
  dedupeHits: number;
  rateLimitedCount: number;
  circuitRejectedCount: number;
  circuitState: CircuitState;
  /** Latency in ms. */
  latency: {
    count: number;
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
  };
  byStatus: Record<string, number>;
}

// ── Per-request options ──────────────────────────────────────────
export interface RequestOptions<TBody = unknown, TResponse = unknown> {
  /** Endpoint path (e.g. "/users/1") or full URL */
  endpoint: string;

  /** HTTP method */
  method?: HttpMethod;

  /** Override auth mode for this request */
  auth?: AuthMode;

  /** Override auth token for this request */
  authToken?: string;

  /** Request body (for POST/PUT/PATCH) */
  body?: TBody | FormData;

  /** Zod-compatible schema for request body validation */
  schema?: ZodLike<TBody>;

  /** Expected response schema for validation */
  responseSchema?: ZodLike<TResponse>;

  /** Override timeout for this request */
  timeoutMs?: number;

  /** Override retry limit for this request */
  retryLimit?: number;

  /** Additional headers for this request */
  headers?: Record<string, string>;

  /** Additional query params (merged with any in the URL) */
  params?: Record<string, string | number | boolean>;

  /** AbortSignal to cancel this request. */
  signal?: AbortSignal;

  /**
   * Per-request cache control.
   * - `false` disables caching for this request
   * - a number overrides the TTL (ms)
   * - an object overrides cache behaviour for this call
   */
  cache?: boolean | number | { ttlMs?: number; staleWhileRevalidate?: boolean };

  /** Skip in-flight dedupe for this request. */
  dedupe?: boolean;

  /** Override the idempotency key for this request. */
  idempotencyKey?: string;

  /** Per-request retry override. */
  retry?: RetryConfig | false;
}

// ── Result types ─────────────────────────────────────────────────
export interface ResultMeta {
  /** Whether this response was served from cache. */
  cached?: boolean;
  /** Whether a stale cached response was served while revalidating. */
  stale?: boolean;
  /** Whether this response joined an in-flight deduplicated request. */
  deduped?: boolean;
  /** Number of attempts made (1 = no retries). */
  attempts?: number;
  /** Total wall-clock duration in ms. */
  durationMs?: number;
  /** Correlation id for this request. */
  requestId?: string;
}

export interface SuccessResult<T = unknown> {
  ok: true;
  data: T;
  status: number;
  headers?: Record<string, string>;
  meta?: ResultMeta;
}

export interface ErrorResult {
  ok: false;
  error: string;
  status: number;
  details?: unknown;
  /** Machine-readable error code (e.g. CIRCUIT_OPEN, RATE_LIMITED, TIMEOUT). */
  code?: string;
  meta?: ResultMeta;
}

export type ApiResult<T = unknown> = SuccessResult<T> | ErrorResult;

// ── Convenience type: response from Next.js route handlers ───────
export interface NextProxyResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
  details?: unknown;
}
