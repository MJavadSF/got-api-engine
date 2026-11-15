import type { ErrorCode } from "../errors/codes";
import type { Timings } from "./http";

export type { ErrorCode };

/** An `ErrorCode`, or a custom code produced by your own middleware. */
export type ResultCode = ErrorCode | (string & {});

export interface ResultMeta {
  requestId?: string;
  durationMs?: number;
  /** Upstream calls made (1 = no retry). */
  attempts?: number;
  cached?: boolean;
  stale?: boolean;
  staleReason?: "revalidating" | "error";
  deduped?: boolean;
  /** A hedged (parallel) attempt produced this response. */
  hedged?: boolean;
  /** Data came from `fallback` because the request failed. */
  fallback?: boolean;
  fallbackFrom?: ResultCode | undefined;
  /** Delay requested by upstream `Retry-After` (ms). */
  retryAfterMs?: number;
  /** Upstream origin that answered (useful with failover). */
  upstream?: string;
  timings?: Timings;
}

export interface SuccessResult<T = unknown> {
  ok: true;
  data: T;
  status: number;
  headers?: Record<string, string>;
  meta?: ResultMeta;
}

export interface ErrorResult {
  ok: false;
  error: string;
  status: number;
  code?: ResultCode;
  details?: unknown;
  headers?: Record<string, string>;
  meta?: ResultMeta;
}

/** Plain, serialisable result (safe to return from Server Actions). */
export type ApiResult<T = unknown> = SuccessResult<T> | ErrorResult;
