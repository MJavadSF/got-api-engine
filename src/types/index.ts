// =================================================================
// got-api-engine — Core Types
// =================================================================

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  /** HTTP QUERY — safe, idempotent request with a body (supported by got 16). */
  | "QUERY";

export type AuthMode =
  | boolean          // true = required, false = none
  | "optional"       // forward token if present
  | "bearer"         // alias for true
  | "none";          // alias for false

/**
 * How the response body is decoded.
 * - `auto`   (default) JSON → object, text → string, binary → Buffer, decided by Content-Type
 * - `json`   strict JSON (parse failure → `PARSE_ERROR`)
 * - `text`   always a string
 * - `buffer` always a Node.js Buffer (downloads, images, PDFs…)
 */
export type ResponseType = "auto" | "json" | "text" | "buffer";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

// ── Schema shape (Zod / Valibot / ArkType compatible) ────────────
export interface ZodLike<T> {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { flatten?: () => unknown; issues?: unknown } };
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
   * Return the Authorization header value (e.g. "Bearer <token>", "Basic …")
   * or null/undefined if no auth is available. A bare token without a scheme
   * is treated as a Bearer token.
   */
  getAuthHeader(): string | null | undefined | Promise<string | null | undefined>;

  /**
   * Optional: additional / alternative credential headers, e.g.
   * `{ "X-API-Key": "…" }`. Merged into the request when present.
   */
  getHeaders?(): Record<string, string> | null | undefined | Promise<Record<string, string> | null | undefined>;
}

// ── Request / Response hooks ─────────────────────────────────────
export interface RequestHookContext {
  url: string;
  method: HttpMethod;
  /** Mutable: changes made by the hook are sent upstream. */
  headers: Record<string, string>;
  body?: unknown;
  requestId?: string;
}

export interface ResponseHookContext {
  url: string;
  method: HttpMethod;
  status: number;
  body: unknown;
  durationMs: number;
  requestId?: string;
}

export interface ErrorHookContext {
  url: string;
  method: HttpMethod;
  error: unknown;
  durationMs: number;
  requestId?: string;
}

export type RequestHook = (ctx: RequestHookContext) => void | Promise<void>;
export type ResponseHook = (ctx: ResponseHookContext) => void | Promise<void>;
export type ErrorHook = (ctx: ErrorHookContext) => void | Promise<void>;

/** Context passed to `refreshAuth` after an upstream 401. */
export interface RefreshAuthContext {
  url: string;
  method: HttpMethod;
  requestId: string;
}

/**
 * Called (single-flight) when the upstream answers 401 to a request that used
 * the engine's configured `auth`. Perform your token refresh here. Return the
 * new token/header, or nothing if your `auth` provider will now yield the new
 * token by itself. The request is then replayed once.
 */
export type RefreshAuthHook = (
  ctx: RefreshAuthContext,
) => string | null | undefined | void | Promise<string | null | undefined | void>;

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
   * Called once (single-flight) when the upstream replies 401 to a request that
   * used the engine's `auth`; the request is then retried a single time.
   */
  refreshAuth?: RefreshAuthHook;

  /**
   * Extra hosts (exact or `*.suffix`) that may receive this engine's
   * credentials in addition to the `baseUrl` origin. Requests to any other
   * origin (absolute URLs) that would carry credentials are refused with
   * `CREDENTIALS_BLOCKED`, which prevents token leaks to attacker-controlled URLs.
   */
  credentialHosts?: string[];

  /**
   * Default timeout in milliseconds for a single attempt.
   * @default 10000
   */
  timeoutMs?: number;

  /**
   * Overall deadline in ms for a request *including* retries and backoff.
   * Disabled by default.
   */
  totalTimeoutMs?: number;

  /**
   * Default retry limit (beyond the first try). Only idempotent methods are
   * retried unless `retry.methods` says otherwise.
   * @default 2
   */
  retryLimit?: number;

  /**
   * Default response decoding.
   * @default "auto"
   */
  responseType?: ResponseType;

  /**
   * Use got 16's built-in HTTP/2 client (ALPN negotiation, pooled sessions,
   * multiplexing). The engine then omits its own https keep-alive agent, since
   * a custom https agent forces got onto the HTTP/1.1 path. @default false
   */
  http2?: boolean;

  /**
   * Enable got 16's built-in DNS cache. Keep it off for internal hostnames.
   * Compatible with `ssrfProtection` (the guarded lookup wraps it). @default false
   */
  dnsCache?: boolean;

  /**
   * Custom logger. If omitted, a built-in console logger is used
   * (use `await createLogger()` to get the Winston-backed one).
   */
  logger?: LoggerInterface;

  /**
   * Enable verbose debug logging.
   * @default false
   */
  debug?: boolean;

  /**
   * Minimum level for the built-in logger. Overrides `debug` and the
   * `LOG_LEVEL` environment variable.
   */
  logLevel?: LogLevel;

  /**
   * Service name used in log output.
   * @default process.env.LOG_NAME ?? "got-api-engine"
   */
  serviceName?: string;

  /**
   * Static headers added to every request.
   */
  defaultHeaders?: Record<string, string>;

  /**
   * Whether to verify TLS certificates. Set to `false` ONLY for local
   * development against self-signed certificates.
   * @default true (in every environment)
   */
  rejectUnauthorized?: boolean;

  /**
   * If set (e.g. `"X-Request-Id"`), the request's correlation id is sent
   * upstream under this header.
   */
  requestIdHeader?: string;

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
   * Client-side rate limiting (token bucket) applied to every upstream attempt.
   * Disabled unless `enabled: true`.
   */
  rateLimit?: RateLimitConfig;

  /**
   * Deduplicate identical in-flight GET/HEAD requests (single-flight).
   * @default true
   */
  dedupe?: boolean;

  /**
   * Exponential backoff retry layer (engine-managed; got's own retry is disabled).
   */
  retry?: RetryConfig;

  /**
   * SSRF protection — block requests to private/loopback ranges (including
   * DNS names that *resolve* to them) and disallow cross-origin redirects.
   * Recommended `true` for any engine that forwards user-controlled URLs.
   * @default false
   */
  ssrfProtection?: boolean | SsrfConfig;

  /**
   * Header/body/query keys to redact in logs (case-insensitive).
   * Merged with sensible defaults (authorization, cookie, token, …).
   */
  redactKeys?: string[];

  /**
   * Collect runtime metrics (counts, latency percentiles, circuit state).
   * @default true
   */
  metrics?: boolean;

  /**
   * Automatically attach an `Idempotency-Key` header to mutating requests
   * (POST/PUT/PATCH). With a key present, POST/PATCH become safely retryable.
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
  /**
   * HTTP methods eligible for retry.
   * @default ["GET","HEAD","PUT","DELETE","OPTIONS","QUERY"]  (idempotent methods).
   * POST/PATCH are additionally retried when the request carries an
   * `Idempotency-Key`, unless you set this list explicitly.
   */
  methods?: HttpMethod[];
  /** Respect a `Retry-After` response header when present. @default true */
  respectRetryAfter?: boolean;
  /**
   * If `Retry-After` asks for a longer wait than this, do not retry and return
   * the error immediately (with `meta.retryAfterMs`). @default = maxDelayMs
   */
  maxRetryAfterMs?: number;
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
   * background (one revalidation per key). @default false
   */
  staleWhileRevalidate?: boolean;
  /**
   * If the upstream fails (network error, timeout, 5xx, open circuit) serve
   * the stale cached response instead of the error. @default false
   */
  staleIfError?: boolean;
  /**
   * How long past expiry an entry stays usable for `staleWhileRevalidate`,
   * `staleIfError` and conditional revalidation. @default 300000
   */
  staleTtlMs?: number;
  /** Methods eligible for caching. @default ["GET","HEAD"] */
  methods?: HttpMethod[];
  /** Provide a custom cache store (e.g. Redis-backed). */
  store?: CacheStore;
  /**
   * Honor `ETag` / `Last-Modified` for conditional revalidation
   * (sends `If-None-Match` / `If-Modified-Since`). @default true
   */
  conditional?: boolean;
  /**
   * Derive the TTL from the upstream `Cache-Control: max-age` header
   * (`no-cache` → always revalidate). Falls back to `ttlMs`. @default false
   */
  respectCacheControl?: boolean;
  /**
   * After a successful POST/PUT/PATCH/DELETE, drop cached GET/HEAD entries for
   * the same resource (and any `Location` / `Content-Location`). @default true
   */
  invalidateOnMutation?: boolean;
  /**
   * Return a copy of cached data so callers cannot mutate the cache.
   * @default true
   */
  cloneOnRead?: boolean;
}

/** Pluggable cache store. Defaults to an in-memory LRU. */
export interface CacheStore {
  get(key: string): CachedResponse | undefined | Promise<CachedResponse | undefined>;
  set(key: string, value: CachedResponse, ttlMs: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
  /**
   * Optional: delete every key matching the predicate (used for
   * `invalidateOnMutation`). Stores that omit it only get exact-key invalidation.
   */
  deleteMatching?(predicate: (key: string) => boolean): void | Promise<void>;
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
  /** Concurrent probe requests allowed while half-open. @default 1 */
  halfOpenMaxConcurrent?: number;
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
   * When the bucket is empty: "wait" (FIFO queue until a token frees up) or
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
  /** Explicit allowlist of hostnames (exact or *.suffix). Authoritative when set. */
  allowHosts?: string[];
  /** Explicit blocklist of hostnames. */
  blockHosts?: string[];
  /** Follow redirects only within the original origin. @default true */
  sameOriginRedirectsOnly?: boolean;
  /**
   * Also validate the IP addresses a hostname *resolves to* at connect time
   * (defeats DNS-rebinding and names pointing at internal IPs). @default true
   */
  checkResolvedAddresses?: boolean;
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
  /** Stale responses served (stale-while-revalidate or stale-if-error). */
  staleServed: number;
  dedupeHits: number;
  rateLimitedCount: number;
  circuitRejectedCount: number;
  /** Number of `refreshAuth` invocations. */
  authRefreshes: number;
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
export type ParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<string | number | boolean | null | undefined>;

export interface RequestOptions<TBody = unknown, TResponse = unknown> {
  /** Endpoint path (e.g. "/users/1") or full URL */
  endpoint: string;

  /** HTTP method */
  method?: HttpMethod;

  /** Override auth mode for this request */
  auth?: AuthMode;

  /** Override auth token for this request */
  authToken?: string;

  /** Request body. Objects/arrays → JSON; string, Buffer, URLSearchParams, Blob, FormData are sent as-is. */
  body?: TBody | FormData;

  /** Zod-compatible schema for request body validation */
  schema?: ZodLike<TBody>;

  /** Expected response schema for validation */
  responseSchema?: ZodLike<TResponse>;

  /** Override timeout (per attempt) for this request */
  timeoutMs?: number;

  /** Overall deadline including retries for this request */
  totalTimeoutMs?: number;

  /** Override retry limit for this request */
  retryLimit?: number;

  /** Additional headers for this request */
  headers?: Record<string, string>;

  /** Additional query params (arrays become repeated keys) */
  params?: Record<string, ParamValue>;

  /** Override response decoding for this request */
  responseType?: ResponseType;

  /** Supply your own correlation id (e.g. an incoming `X-Request-Id`). */
  requestId?: string;

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

  /** Per-request retry override (merged over the engine's retry config). */
  retry?: RetryConfig | false;
}

// ── Result types ─────────────────────────────────────────────────
export interface ResultMeta {
  /** Whether this response was served from cache. */
  cached?: boolean;
  /** Whether a stale cached response was served. */
  stale?: boolean;
  /** Why a stale response was served. */
  staleReason?: "revalidating" | "error";
  /** Whether this response joined an in-flight deduplicated request. */
  deduped?: boolean;
  /** Number of attempts made (1 = no retries). */
  attempts?: number;
  /** Total wall-clock duration in ms. */
  durationMs?: number;
  /** Correlation id for this request. */
  requestId?: string;
  /** Upstream `Retry-After` in ms, when it was too long to honour. */
  retryAfterMs?: number;
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
  /** Validation errors, or the upstream error body for HTTP errors. */
  details?: unknown;
  /**
   * Machine-readable error code: CIRCUIT_OPEN, RATE_LIMITED, TIMEOUT, ABORTED,
   * SSRF_BLOCKED, AUTH_REQUIRED, AUTH_PROVIDER_ERROR, CREDENTIALS_BLOCKED,
   * HTTP_ERROR, REQUEST_VALIDATION, RESPONSE_VALIDATION, PARSE_ERROR,
   * INVALID_URL, NETWORK_ERROR, ENGINE_DISPOSED, INTERNAL_ERROR.
   */
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
