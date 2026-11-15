import type { HttpMethod } from "./http";
import type { CircuitState } from "./resilience";

// ── Logger — bring your own ──────────────────────────────────────
export interface LoggerInterface {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child?(meta: Record<string, unknown>): LoggerInterface;
  /**
   * Optional fast check (pino and winston expose `isLevelEnabled`). When it
   * returns false the engine skips building messages, redaction and child
   * loggers for that level.
   */
  isLevelEnabled?(level: "debug" | "info" | "warn" | "error"): boolean;
}

// ── Lifecycle hooks (observers; use middleware to change behaviour) ──
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

/** A sanitised view of a thrown error (no request options / credentials). */
export interface SafeError {
  name: string;
  message: string;
  code?: string | undefined;
}

export interface ErrorHookContext {
  url: string;
  method: HttpMethod;
  error: SafeError;
  durationMs: number;
  requestId?: string;
}

export interface CircuitStateContext {
  from: CircuitState;
  to: CircuitState;
  serviceName: string;
  failureCount: number;
  /** Breaker key (host by default). */
  key: string;
}

export interface RetryHookContext {
  url: string;
  method: HttpMethod;
  attempt: number;
  delayMs: number;
  reason: string;
}

export type RequestHook = (ctx: RequestHookContext) => void | Promise<void>;
export type ResponseHook = (ctx: ResponseHookContext) => void | Promise<void>;
export type ErrorHook = (ctx: ErrorHookContext) => void | Promise<void>;
export type CircuitStateHook = (ctx: CircuitStateContext) => void | Promise<void>;
export type RetryHook = (ctx: RetryHookContext) => void | Promise<void>;

export interface EngineHooks {
  onRequest?: RequestHook | RequestHook[];
  onResponse?: ResponseHook | ResponseHook[];
  onError?: ErrorHook | ErrorHook[];
  onCircuitStateChange?: CircuitStateHook | CircuitStateHook[];
  onRetry?: RetryHook | RetryHook[];
}

// ── Metrics ──────────────────────────────────────────────────────
export interface LatencyStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface RouteMetrics {
  requests: number;
  errors: number;
  latency: LatencyStats;
}

/**
 * Counter semantics (stable since v4):
 * - `totalRequests` / `successCount` / `errorCount` count calls to `request()`
 *   and the results they returned (cache hits and deduped followers included).
 * - `upstream*` count real network attempts.
 */
export interface MetricsSnapshot {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  upstreamRequests: number;
  upstreamErrors: number;
  retryCount: number;
  hedgeCount: number;
  cacheHits: number;
  cacheMisses: number;
  /** Stale responses served (stale-while-revalidate or stale-if-error). */
  staleServed: number;
  dedupeHits: number;
  rateLimitedCount: number;
  concurrencyLimitedCount: number;
  circuitRejectedCount: number;
  authRefreshes: number;
  fallbackServed: number;
  circuitState: CircuitState;
  /** Upstream attempt latency in ms. */
  latency: LatencyStats;
  byStatus: Record<string, number>;
  byErrorCode: Record<string, number>;
  /** Per route (`METHOD host/path-template`). */
  byRoute: Record<string, RouteMetrics>;
}

export interface HealthReport {
  status: "ok" | "degraded" | "down";
  circuits: Record<string, CircuitState>;
  upstreams: Array<{ origin: string; healthy: boolean }>;
  inflight: number;
  rateLimiterPending: number;
  latencyP95: number;
  errorRate: number;
  ping?: { ok: boolean; status: number; durationMs: number } | undefined;
}
