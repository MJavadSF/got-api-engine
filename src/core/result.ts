// ── Result construction + consumer helpers ───────────────────────

import { ApiError } from "../errors/api-error";
import type { ApiResult, ErrorResult, ResultCode, ResultMeta, SuccessResult } from "../types/result";

export interface FailExtra {
  code?: ResultCode | undefined;
  details?: unknown;
  meta?: ResultMeta | undefined;
  headers?: Record<string, string> | undefined;
}

export function fail(error: string, status: number, extra: FailExtra = {}): ErrorResult {
  return {
    ok: false,
    error,
    status,
    ...(extra.code ? { code: extra.code } : {}),
    ...(extra.details !== undefined ? { details: extra.details } : {}),
    ...(extra.headers ? { headers: extra.headers } : {}),
    ...(extra.meta ? { meta: extra.meta } : {}),
  };
}

export function withMeta<T>(result: ApiResult<T>, meta: ResultMeta): ApiResult<T> {
  return { ...result, meta: { ...result.meta, ...meta } };
}

/** Type guard; optionally narrows to specific error codes. */
export function isApiError(result: ApiResult<unknown>, ...codes: ResultCode[]): result is ErrorResult {
  if (result.ok) return false;
  return codes.length === 0 || (result.code !== undefined && codes.includes(result.code));
}

/** Return `data` or throw an `ApiError`. */
export function unwrap<T>(result: ApiResult<T>): T {
  if (result.ok) return result.data;
  throw new ApiError(result);
}

/** Map the data of a successful result; errors pass through untouched. */
export function mapResult<T, U>(result: ApiResult<T>, fn: (data: T) => U): ApiResult<U> {
  return result.ok ? ({ ...result, data: fn(result.data) } satisfies SuccessResult<U>) : result;
}
