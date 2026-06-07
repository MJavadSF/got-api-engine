import { b as AuthProvider, L as LoggerInterface } from './engine-CSgVuMhU.js';
export { a as ApiResult, A as AuthMode, E as EngineConfig, c as ErrorHook, d as ErrorHookContext, e as ErrorResult, G as GotApiEngine, H as HttpMethod, f as RequestHook, g as RequestHookContext, R as RequestOptions, h as ResponseHook, i as ResponseHookContext, S as SuccessResult, Z as ZodLike, j as createEngine } from './engine-CSgVuMhU.js';
export { batchRequests, withRetry } from './adapters/node.js';

declare class StaticAuthProvider implements AuthProvider {
    private readonly token;
    constructor(token: string);
    getAuthHeader(): string;
}
declare class DynamicAuthProvider implements AuthProvider {
    private readonly tokenFn;
    constructor(tokenFn: () => string | null | undefined | Promise<string | null | undefined>);
    getAuthHeader(): Promise<string | null>;
}
interface NextAuthSession {
    access_token?: string;
    [key: string]: unknown;
}
declare class NextAuthProvider implements AuthProvider {
    private readonly getSession;
    constructor(getSession: () => NextAuthSession | null | Promise<NextAuthSession | null>);
    getAuthHeader(): Promise<string | null>;
}
declare class BrowserStorageAuthProvider implements AuthProvider {
    private readonly storageKey;
    private readonly storage;
    constructor(storageKey?: string, storage?: "localStorage" | "sessionStorage");
    getAuthHeader(): string | null;
}
declare class ApiKeyAuthProvider implements AuthProvider {
    private readonly apiKey;
    constructor(apiKey: string);
    /**
     * Note: API key auth sets a custom header.
     * Use this with defaultHeaders instead for full control:
     *   defaultHeaders: { 'X-API-Key': apiKey }
     */
    getAuthHeader(): string;
}
declare const createStaticAuth: (token: string) => AuthProvider;
declare const createDynamicAuth: (fn: () => string | null | undefined | Promise<string | null | undefined>) => AuthProvider;
declare const createNextAuthProvider: (getSession: () => NextAuthSession | null | Promise<NextAuthSession | null>) => AuthProvider;
declare const createBrowserStorageAuth: (key?: string, storage?: "localStorage" | "sessionStorage") => AuthProvider;

declare function createConsoleLogger(serviceName: string, debugEnabled?: boolean): LoggerInterface;
declare function createLogger(serviceName: string, debugEnabled?: boolean, isDev?: boolean): Promise<LoggerInterface>;

declare function generateRequestId(): string;
declare function safeStringify(value: unknown, maxDepth?: number): string;
declare function parseApiError(rawBody: unknown): string;
declare function buildUrl(endpoint: string, baseUrl: string): string;
declare function appendParams(url: string, params: Record<string, string | number | boolean>): string;

export { ApiKeyAuthProvider, AuthProvider, BrowserStorageAuthProvider, DynamicAuthProvider, LoggerInterface, NextAuthProvider, StaticAuthProvider, appendParams, buildUrl, createBrowserStorageAuth, createConsoleLogger, createDynamicAuth, createLogger, createNextAuthProvider, createStaticAuth, generateRequestId, parseApiError, safeStringify };
