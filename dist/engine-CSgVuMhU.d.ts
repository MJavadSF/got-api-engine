type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
type AuthMode = boolean | "optional" | "bearer" | "none";
interface ZodLike<T> {
    safeParse(data: unknown): {
        success: true;
        data: T;
    } | {
        success: false;
        error: {
            flatten(): unknown;
        };
    };
}
interface LoggerInterface {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    child?(meta: Record<string, unknown>): LoggerInterface;
}
interface AuthProvider {
    /**
     * Return the Authorization header value (e.g. "Bearer <token>")
     * or null/undefined if no auth is available.
     */
    getAuthHeader(): string | null | undefined | Promise<string | null | undefined>;
}
interface RequestHookContext {
    url: string;
    method: HttpMethod;
    headers: Record<string, string>;
    body?: unknown;
}
interface ResponseHookContext {
    url: string;
    method: HttpMethod;
    status: number;
    body: unknown;
    durationMs: number;
}
interface ErrorHookContext {
    url: string;
    method: HttpMethod;
    error: unknown;
    durationMs: number;
}
type RequestHook = (ctx: RequestHookContext) => void | Promise<void>;
type ResponseHook = (ctx: ResponseHookContext) => void | Promise<void>;
type ErrorHook = (ctx: ErrorHookContext) => void | Promise<void>;
interface EngineConfig {
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
interface RequestOptions<TBody = unknown, TResponse = unknown> {
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
interface SuccessResult<T = unknown> {
    ok: true;
    data: T;
    status: number;
    headers?: Record<string, string>;
}
interface ErrorResult {
    ok: false;
    error: string;
    status: number;
    details?: unknown;
}
type ApiResult<T = unknown> = SuccessResult<T> | ErrorResult;

declare class GotApiEngine {
    private readonly config;
    private readonly httpClient;
    private readonly log;
    constructor(config: EngineConfig);
    request<TResponse = unknown, TBody = unknown>(options: RequestOptions<TBody, TResponse>): Promise<ApiResult<TResponse>>;
    get<TResponse = unknown>(endpoint: string, options?: Omit<RequestOptions<never, TResponse>, "endpoint" | "method" | "body">): Promise<ApiResult<TResponse>>;
    post<TResponse = unknown, TBody = unknown>(endpoint: string, body?: TBody, options?: Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method" | "body">): Promise<ApiResult<TResponse>>;
    put<TResponse = unknown, TBody = unknown>(endpoint: string, body?: TBody, options?: Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method" | "body">): Promise<ApiResult<TResponse>>;
    patch<TResponse = unknown, TBody = unknown>(endpoint: string, body?: TBody, options?: Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method" | "body">): Promise<ApiResult<TResponse>>;
    delete<TResponse = unknown>(endpoint: string, options?: Omit<RequestOptions<never, TResponse>, "endpoint" | "method" | "body">): Promise<ApiResult<TResponse>>;
    extend(overrides: Partial<EngineConfig>): GotApiEngine;
}
declare function createEngine(config: EngineConfig): GotApiEngine;

export { type AuthMode as A, type EngineConfig as E, GotApiEngine as G, type HttpMethod as H, type LoggerInterface as L, type RequestOptions as R, type SuccessResult as S, type ZodLike as Z, type ApiResult as a, type AuthProvider as b, type ErrorHook as c, type ErrorHookContext as d, type ErrorResult as e, type RequestHook as f, type RequestHookContext as g, type ResponseHook as h, type ResponseHookContext as i, createEngine as j };
