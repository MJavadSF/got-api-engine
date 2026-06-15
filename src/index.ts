// =================================================================
// got-api-engine — Public API
// =================================================================

// ── Core ─────────────────────────────────────────────────────────
export { GotApiEngine, createEngine } from "./core/engine";

// ── Types ─────────────────────────────────────────────────────────
export type {
  EngineConfig,
  RequestOptions,
  ApiResult,
  SuccessResult,
  ErrorResult,
  ResultMeta,
  HttpMethod,
  AuthMode,
  AuthProvider,
  LoggerInterface,
  ZodLike,
  RequestHook,
  ResponseHook,
  ErrorHook,
  RequestHookContext,
  ResponseHookContext,
  ErrorHookContext,
  RetryConfig,
  CacheConfig,
  CacheStore,
  CachedResponse,
  CircuitBreakerConfig,
  CircuitState,
  CircuitStateContext,
  CircuitStateHook,
  RetryHook,
  RetryHookContext,
  RateLimitConfig,
  SsrfConfig,
  MetricsSnapshot,
} from "./types/index";

// ── Production subsystems (advanced / custom usage) ──────────────
export { CircuitBreaker } from "./core/circuit-breaker";
export { MemoryCacheStore } from "./core/cache-store";
export { TokenBucket, RateLimitError } from "./core/rate-limiter";
export { MetricsCollector } from "./core/metrics";
export {
  SsrfError,
  assertUrlAllowed,
  buildRedactor,
  resolveSsrfConfig,
} from "./core/security";

// ── Auth Providers ────────────────────────────────────────────────
export {
  StaticAuthProvider,
  DynamicAuthProvider,
  NextAuthProvider,
  BrowserStorageAuthProvider,
  ApiKeyAuthProvider,
  createStaticAuth,
  createDynamicAuth,
  createNextAuthProvider,
  createBrowserStorageAuth,
} from "./plugins/auth-providers";

// ── Logger utilities ──────────────────────────────────────────────
export { createConsoleLogger, createLogger } from "./utils/logger";

// ── Utility helpers (advanced usage) ─────────────────────────────
export {
  parseApiError,
  buildUrl,
  appendParams,
  safeStringify,
  generateRequestId,
  getUserIdFromBearerToken,
} from "./utils/helpers";

// ── Node/vanilla adapter (batch, retry) ───────────────────────────
export { batchRequests, withRetry } from "./adapters/node";
