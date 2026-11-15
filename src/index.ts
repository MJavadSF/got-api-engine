/**
 * Engine, typed endpoints, auth providers, plugins, resilience building blocks and helpers.
 *
 * @packageDocumentation
 * @module got-api-engine
 */
// ── got-api-engine — public API ──────────────────────────────────
// Exports are sorted by module path (kept stable by Biome's import sorting).
// Subpath entry points: got-api-engine/next, /node, /redis, /testing, /codegen.

export type { BatchOptions, BatchRequestItem, BatchResults, WithRetryOptions } from "./adapters/node";
export { BatchRequestError, batchRequests, withRetry } from "./adapters/node";
export { normalizeAuthorization } from "./auth/normalize";
export type { OAuth2ClientCredentialsOptions } from "./auth/oauth2";
export { createOAuth2ClientCredentials, OAuth2TokenError } from "./auth/oauth2";
export type { NextAuthSession, RefreshableAuthOptions, RefreshedToken, TokenFn } from "./auth/providers";
export {
  ApiKeyAuthProvider,
  BasicAuthProvider,
  BrowserStorageAuthProvider,
  createApiKeyAuth,
  createBasicAuth,
  createBrowserStorageAuth,
  createDynamicAuth,
  createNextAuthProvider,
  createRefreshableAuth,
  createStaticAuth,
  DynamicAuthProvider,
  NextAuthProvider,
  RefreshableAuthProvider,
  StaticAuthProvider,
} from "./auth/providers";
export type { MemoryCacheStoreOptions } from "./cache/memory-store";
export { MemoryCacheStore } from "./cache/memory-store";
export { mergeEngineConfig } from "./core/config";
export type { BodylessOptions, BodyOptions } from "./core/engine";
export { createEngine, GotApiEngine } from "./core/engine";
export type { FailExtra } from "./core/result";
export { fail, isApiError, mapResult, unwrap } from "./core/result";
export { ApiError } from "./errors/api-error";
export { ERROR_CODES, isErrorCode } from "./errors/codes";
export { MESSAGES_EN, MESSAGES_FA } from "./errors/messages";
export type { Batcher, BatcherOptions, BatchLoadFn } from "./features/batcher";
export { createBatcher } from "./features/batcher";
export type {
  Endpoint,
  EndpointDefinition,
  EndpointInput,
  PathParamName,
  PathParamNames,
  PathParams,
  Requester,
} from "./features/endpoint";
export { bindEndpoint, bindEndpoints, defineEndpoint } from "./features/endpoint";
export type { PaginateOptions } from "./features/paginate";
export type { CurlInput } from "./http/curl";
export { toCurl } from "./http/curl";
export { parseApiError } from "./http/decode";
export { generateRequestId, getUserIdFromBearerToken, safeStringify } from "./http/misc";
export { appendParams, buildUrl, path } from "./http/url";
export { createConsoleLogger, createLogger } from "./observability/logger";
export type { MetricsCounter } from "./observability/metrics";
export { MetricsCollector, toPrometheus } from "./observability/metrics";
export type { OtelOptions, SpanLike, TracerLike } from "./plugins/otel";
export { otel } from "./plugins/otel";
export type { AwsCredentials, AwsSigV4Options, HmacSignOptions, SigV4Input } from "./plugins/signing";
export { awsSigV4, hmacSign, signSigV4 } from "./plugins/signing";
export type { Release } from "./resilience/bulkhead";
export { Bulkhead, ConcurrencyLimitError } from "./resilience/bulkhead";
export type { CircuitStateChangeListener, CircuitTransition } from "./resilience/circuit-breaker";
export { CircuitBreaker } from "./resilience/circuit-breaker";
export { CircuitRegistry } from "./resilience/circuit-registry";
export { RateLimitError, TokenBucket } from "./resilience/rate-limiter";
export { RetryBudget } from "./resilience/retry-budget";
export { createCredentialMatcher, isCredentialTarget } from "./security/hosts";
export type { Redactor } from "./security/redact";
export { buildRedactor, redactUrl, withRedaction } from "./security/redact";
export type { DnsLookupCallback, DnsLookupFn } from "./security/ssrf";
export {
  assertUrlAllowed,
  buildGuardedLookup,
  findSsrfError,
  isPrivateAddress,
  resolveSsrfConfig,
  SsrfError,
} from "./security/ssrf";
export type * from "./types/index";
