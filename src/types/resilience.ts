import type { HttpMethod } from "./http";

// ── Retry ────────────────────────────────────────────────────────
export interface RetryBudgetConfig {
  /** Retries allowed as a fraction of recent requests (0–1). @default 0.2 */
  ratio?: number;
  /** Retries per second always allowed, even at low traffic. @default 5 */
  minPerSec?: number;
  /** Sliding window in ms. @default 10000 */
  windowMs?: number;
}

export interface RetryConfig {
  /** Max retry attempts (beyond the first try). @default 2 */
  limit?: number;
  /** Base delay in ms for exponential backoff. @default 200 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. @default 10000 */
  maxDelayMs?: number;
  /** Jitter factor 0–1 applied to each delay. @default 0.2 */
  jitter?: number;
  /** Status codes that trigger a retry. @default [408,425,429,500,502,503,504] */
  retryStatusCodes?: number[];
  /**
   * Methods eligible for retry. Default: idempotent methods, plus POST/PATCH
   * when the request carries an `Idempotency-Key`.
   */
  methods?: HttpMethod[];
  /** Respect `Retry-After`. @default true */
  respectRetryAfter?: boolean;
  /** Longer `Retry-After` → give up immediately. @default = maxDelayMs */
  maxRetryAfterMs?: number;
  /** Cap retries relative to traffic to prevent retry storms. Off by default. */
  budget?: RetryBudgetConfig | boolean;
}

// ── Circuit breaker ──────────────────────────────────────────────
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  enabled?: boolean;
  /**
   * One breaker per `"host"` (default), one for the whole `"engine"`, or a
   * custom key function receiving the target URL.
   */
  scope?: "host" | "engine" | ((url: URL) => string);
  /** Consecutive failures before opening. @default 5 */
  failureThreshold?: number;
  /** Failure-rate threshold (0–1) over the rolling window. */
  failureRateThreshold?: number;
  /** Outcomes considered for failure-rate (count). @default 20 */
  rollingWindow?: number;
  /** Only outcomes newer than this count (ms). @default 60000 */
  rollingWindowMs?: number;
  /** Time the circuit stays open before half-open. @default 30000 */
  resetTimeoutMs?: number;
  /** Successes required in half-open to close. @default 2 */
  successThreshold?: number;
  /** Concurrent probes while half-open. @default 1 */
  halfOpenMaxConcurrent?: number;
  /** Status codes counted as failures. @default [500,502,503,504] */
  failureStatusCodes?: number[];
}

// ── Rate limiting ────────────────────────────────────────────────
/** Pluggable limiter (e.g. Redis-backed, shared by instances). */
export interface RateLimiterLike {
  acquire(signal?: AbortSignal): Promise<void>;
  /** Non-blocking acquire (used by hedged attempts). */
  tryAcquire?(): boolean;
  /** Stop granting tokens until `epochMs` (adaptive limiting). */
  pauseUntil?(epochMs: number): void;
  readonly pending?: number;
  dispose?(): void;
}

export interface RateLimitConfig {
  enabled?: boolean;
  /** Sustained requests per interval. @default 10 */
  requestsPerInterval?: number;
  /** Interval in ms. @default 1000 */
  intervalMs?: number;
  /** Bucket capacity. @default = requestsPerInterval */
  burst?: number;
  /** Empty bucket: `"wait"` (FIFO queue) or `"reject"` (429). @default "wait" */
  onLimit?: "wait" | "reject";
  /** Max wait for a token (ms). @default 10000 */
  maxWaitMs?: number;
  /**
   * Pause automatically when upstream says so (`RateLimit`,
   * `X-RateLimit-Remaining`/`-Reset`, 429 `Retry-After`). @default false
   */
  adaptive?: boolean;
  /** Custom limiter instance (overrides the built-in token bucket). */
  limiter?: RateLimiterLike;
}

// ── Concurrency (bulkhead) ───────────────────────────────────────
export interface ConcurrencyConfig {
  /** Max upstream attempts in flight. */
  max: number;
  /** Max queued attempts; beyond this → `CONCURRENCY_LIMITED`. @default Infinity */
  maxQueue?: number;
  /** Max queue wait (ms). @default 10000 */
  maxWaitMs?: number;
  /**
   * AIMD: shrink the limit on overload signals (timeouts, 429, 503),
   * grow it back on success, within [min, max].
   */
  adaptive?: { min?: number } | boolean;
}

// ── Hedging ──────────────────────────────────────────────────────
export interface HedgeConfig {
  /** Delay before the hedge: ms, or `"p95"` of observed latency. @default "p95" */
  afterMs?: number | "p95";
  /** Lower bound for the computed delay (ms). @default 50 */
  minDelayMs?: number;
  /** Extra parallel attempts. @default 1 */
  max?: number;
}
