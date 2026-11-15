import type { RequestCacheOptions } from "./cache";
import type { AuthMode, HttpMethod, ParamValue, Progress, ResponseType } from "./http";
import type { RetryConfig } from "./resilience";
import type { ErrorResult } from "./result";
import type { Schema } from "./schema";

export type KeyCase = "camel" | "snake" | ((key: string) => string);

export interface RequestOptions<TBody = unknown, TResponse = unknown> {
  /** Path relative to `baseUrl` (e.g. "/users/1") or an absolute URL. */
  endpoint: string;
  method?: HttpMethod;
  auth?: AuthMode;
  /** Explicit credential for this request (sent to any host — your choice). */
  authToken?: string;
  /** Objects/arrays → JSON; string, Buffer, URLSearchParams, Blob, FormData, streams → as-is. */
  body?: TBody | FormData;
  /** Request body schema (Standard Schema or `safeParse`). */
  schema?: Schema<TBody>;
  /** Response schema; failures → `RESPONSE_VALIDATION`. */
  responseSchema?: Schema<TResponse>;
  /** Per-attempt timeout (ms). */
  timeoutMs?: number;
  /** Deadline including retries and backoff (ms). `0` disables. */
  totalTimeoutMs?: number;
  retryLimit?: number;
  retry?: RetryConfig | false;
  headers?: Record<string, string>;
  /** Query params (arrays become repeated keys). */
  params?: Record<string, ParamValue>;
  responseType?: ResponseType;
  /** Correlation id (only `[\w.:-]{1,128}` is accepted). */
  requestId?: string;
  signal?: AbortSignal;
  /** `false` disables, a number sets the TTL, an object tunes this call. */
  cache?: boolean | number | RequestCacheOptions;
  /** Tags to invalidate after a successful mutation. */
  invalidateTags?: string[];
  dedupe?: boolean;
  idempotencyKey?: string;
  /** Returned (as success, `meta.fallback`) when the request fails. */
  fallback?: TResponse | ((error: ErrorResult) => TResponse | Promise<TResponse>);
  /** Throw `ApiError` instead of returning an error result. */
  throwOnError?: boolean;
  /** Key casing transforms for this request (overrides the engine's). */
  transformKeys?: { request?: KeyCase; response?: KeyCase } | false;
  /** Upper bound for the buffered response body (bytes). */
  maxResponseBytes?: number;
  onUploadProgress?: (progress: Progress) => void;
  onDownloadProgress?: (progress: Progress) => void;
  /** Label for per-route metrics (typed endpoints set their path template). */
  metricsLabel?: string;
  /** Hedge this request (safe methods only). Overrides engine `hedge`. */
  hedge?: boolean;
}
