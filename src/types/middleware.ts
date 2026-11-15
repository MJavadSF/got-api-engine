import type { HttpMethod } from "./http";
import type { RequestOptions } from "./request";
import type { ApiResult } from "./result";

/** The request body as it will go on the wire (after JSON / compression). */
export type EncodedBody =
  | { kind: "none" }
  | { kind: "bytes"; data: Buffer | string }
  | { kind: "form"; data: FormData }
  | { kind: "stream"; data: AsyncIterable<unknown> | NodeJS.ReadableStream };

/** One upstream attempt (first try, retry, failover or hedge), right before it is sent. */
export interface AttemptContext {
  readonly method: HttpMethod;
  /** The URL this attempt goes to (after upstream selection). */
  readonly url: string;
  /** Mutable headers of this attempt only. */
  readonly headers: Record<string, string>;
  readonly body: EncodedBody;
  /** 1-based upstream call number. */
  readonly attempt: number;
  /** True for the parallel attempt started by hedging. */
  readonly hedge: boolean;
}

/**
 * Runs before every upstream attempt. Use it for anything that depends on the
 * final target or on time — request signing, per-attempt tokens. Headers it
 * adds or changes are treated as credentials (stripped on foreign redirects).
 */
export type AttemptHook = (attempt: AttemptContext) => void | Promise<void>;

export interface MiddlewareContext {
  readonly requestId: string;
  readonly method: HttpMethod;
  /** Canonical absolute URL (first upstream for relative endpoints). */
  readonly url: string;
  /** Mutable request headers (sent upstream, including credentials). */
  readonly headers: Record<string, string>;
  readonly body: EncodedBody;
  readonly options: Readonly<RequestOptions<unknown, unknown>>;
  readonly signal: AbortSignal | undefined;
  /** Free-form per-request state shared between middleware. */
  readonly state: Record<string, unknown>;
  /** Register a hook that runs before every upstream attempt of this request. */
  onAttempt(hook: AttemptHook): void;
}

/**
 * Koa-style middleware. Call `next()` to continue (dedupe → cache → network),
 * or return a result to short-circuit. Results are raw (before the caller's
 * `responseSchema` / key transforms are applied).
 */
export type Middleware = (ctx: MiddlewareContext, next: () => Promise<ApiResult<unknown>>) => Promise<ApiResult<unknown>>;
