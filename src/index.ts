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
} from "./types/index";

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
} from "./utils/helpers";

// ── Node/vanilla adapter (batch, retry) ───────────────────────────
export { batchRequests, withRetry } from "./adapters/node";
