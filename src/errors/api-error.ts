import type { ErrorResult, ResultCode, ResultMeta } from "../types/result";

/** Thrown by `throwOnError`, `unwrap()` and `requestData()`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ResultCode | undefined;
  readonly details: unknown;
  readonly meta: ResultMeta | undefined;
  readonly result: ErrorResult;

  constructor(result: ErrorResult) {
    super(result.error);
    this.name = "ApiError";
    this.status = result.status;
    this.code = result.code;
    this.details = result.details;
    this.meta = result.meta;
    this.result = result;
  }

  /** Narrow by code: `if (err instanceof ApiError && err.is("TIMEOUT"))`. */
  is(code: ResultCode): boolean {
    return this.code === code;
  }
}
