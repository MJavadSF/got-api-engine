import { G as GotApiEngine, E as EngineConfig, H as HttpMethod, A as AuthMode, Z as ZodLike, R as RequestOptions, a as ApiResult } from '../engine-CSgVuMhU.mjs';

interface NextRouteHandlerOptions<TBody = unknown> {
    endpoint: string;
    method?: HttpMethod;
    auth?: AuthMode;
    schema?: ZodLike<TBody>;
    timeoutMs?: number;
    retryLimit?: number;
    headers?: Record<string, string>;
    params?: Record<string, string | number | boolean>;
    /** Custom body override (ignores req.body) */
    body?: TBody;
    /** Forward X-Forwarded-For from incoming request */
    forwardClientIp?: boolean;
}
type ServerActionOptions<TBody = unknown, TResponse = unknown> = Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method"> & {
    /** next-auth Session-like object with access_token */
    session?: {
        access_token?: string;
        user?: {
            id?: string;
        };
    } | null;
};
declare class NextApiEngine extends GotApiEngine {
    constructor(config: EngineConfig);
    handleRoute<TBody = unknown>(req: Request, options: NextRouteHandlerOptions<TBody>): Promise<Response>;
    serverAction<TResponse = unknown, TBody = unknown>(method: HttpMethod, endpoint: string, options?: ServerActionOptions<TBody, TResponse>): Promise<ApiResult<TResponse>>;
    serverGet<TResponse = unknown>(endpoint: string, options?: ServerActionOptions<never, TResponse>): Promise<ApiResult<TResponse>>;
    serverPost<TResponse = unknown, TBody = unknown>(endpoint: string, body?: TBody, options?: ServerActionOptions<TBody, TResponse>): Promise<ApiResult<TResponse>>;
    serverPut<TResponse = unknown, TBody = unknown>(endpoint: string, body?: TBody, options?: ServerActionOptions<TBody, TResponse>): Promise<ApiResult<TResponse>>;
    serverPatch<TResponse = unknown, TBody = unknown>(endpoint: string, body?: TBody, options?: ServerActionOptions<TBody, TResponse>): Promise<ApiResult<TResponse>>;
    serverDelete<TResponse = unknown>(endpoint: string, options?: ServerActionOptions<never, TResponse>): Promise<ApiResult<TResponse>>;
    buildRouteHandlers(): {
        GET: (req: Request, endpoint: string, auth?: AuthMode) => Promise<Response>;
        POST: <TBody = unknown>(req: Request, opts: Omit<NextRouteHandlerOptions<TBody>, "method">) => Promise<Response>;
        PUT: <TBody = unknown>(req: Request, opts: Omit<NextRouteHandlerOptions<TBody>, "method">) => Promise<Response>;
        PATCH: <TBody = unknown>(req: Request, opts: Omit<NextRouteHandlerOptions<TBody>, "method">) => Promise<Response>;
        DELETE: (req: Request, endpoint: string, auth?: AuthMode) => Promise<Response>;
    };
}
declare function createNextEngine(config: EngineConfig): NextApiEngine;

export { ApiResult, AuthMode, EngineConfig, NextApiEngine, type NextRouteHandlerOptions, RequestOptions, type ServerActionOptions, createNextEngine };
