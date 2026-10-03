// =================================================================
// got-api-engine — Public API
// =================================================================

// ── Core ─────────────────────────────────────────────────────────
export { GotApiEngine, createEngine, mergeEngineConfig } from "./core/engine";

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
  LogLevel,
  ResponseType,
  ParamValue,
  ZodLike,
  RequestHook,
  ResponseHook,
  ErrorHook,
  RequestHookContext,
  ResponseHookContext,
  ErrorHookContext,
  RefreshAuthHook,
  RefreshAuthContext,
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
  buildGuardedLookup,
  findSsrfError,
  isPrivateAddress,
  redactUrl,
  resolveSsrfConfig,
  withRedaction,
} from "./core/security";

// ── Auth Providers ────────────────────────────────────────────────
export {
  StaticAuthProvider,
  DynamicAuthProvider,
  NextAuthProvider,
  BrowserStorageAuthProvider,
  ApiKeyAuthProvider,
  BasicAuthProvider,
  RefreshableAuthProvider,
  createStaticAuth,
  createDynamicAuth,
  createNextAuthProvider,
  createBrowserStorageAuth,
  createApiKeyAuth,
  createBasicAuth,
  createRefreshableAuth,
} from "./plugins/auth-providers";
export type {
  NextAuthSession,
  RefreshableAuthOptions,
  RefreshedToken,
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
export { batchRequests, withRetry, BatchRequestError } from "./adapters/node";
export type { BatchRequestItem, BatchOptions, WithRetryOptions } from "./adapters/node";
