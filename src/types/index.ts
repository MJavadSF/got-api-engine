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
  };
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
}

// ── Result types ─────────────────────────────────────────────────
export interface SuccessResult<T = unknown> {
  ok: true;
  data: T;
  status: number;
  headers?: Record<string, string>;
}

export interface ErrorResult {
  ok: false;
  error: string;
  status: number;
  details?: unknown;
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
