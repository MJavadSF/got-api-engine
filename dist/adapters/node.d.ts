import { R as RequestOptions, a as ApiResult, G as GotApiEngine } from '../engine-CSgVuMhU.js';
export { E as EngineConfig, j as createEngine } from '../engine-CSgVuMhU.js';

interface BatchRequestItem<TResponse = unknown, TBody = unknown> {
    key: string;
    options: RequestOptions<TBody, TResponse>;
}
type BatchResult<T extends Record<string, ApiResult>> = T;
declare function batchRequests<TResults extends Record<string, ApiResult> = Record<string, ApiResult>>(engine: GotApiEngine, requests: BatchRequestItem[], options?: {
    /** Maximum concurrent requests. Defaults to all parallel. */
    concurrency?: number;
    /** Stop on first error. @default false */
    failFast?: boolean;
}): Promise<TResults>;
declare function withRetry<T>(fn: () => Promise<ApiResult<T>>, options?: {
    retries?: number;
    baseDelayMs?: number;
    shouldRetry?: (result: ApiResult<T>) => boolean;
}): Promise<ApiResult<T>>;

export { ApiResult, type BatchRequestItem, type BatchResult, GotApiEngine, RequestOptions, batchRequests, withRetry };
