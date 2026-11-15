/**
 * Node.js helpers: batched requests and a standalone retry helper.
 *
 * @packageDocumentation
 * @module got-api-engine/node
 */
// ── got-api-engine/node — batch and retry helpers ────────────────

import { createEngine, GotApiEngine } from "../core/engine";
import { backoffDelay, sleep } from "../resilience/backoff";
import type { EngineConfig } from "../types/config";
import type { RequestOptions } from "../types/request";
import type { ApiResult, ErrorResult } from "../types/result";

export type { ApiResult, EngineConfig, RequestOptions };
export { createEngine, GotApiEngine };

// ── Batch requests ───────────────────────────────────────────────
export interface BatchRequestItem<K extends string = string, TResponse = unknown, TBody = unknown> {
  key: K;
  options: RequestOptions<TBody, TResponse>;
}

/** Result record typed by item keys: `{ users: ApiResult<User[]>, … }`. */
export type BatchResults<Items extends readonly BatchRequestItem[]> = {
  [I in Items[number] as I["key"]]: I extends BatchRequestItem<string, infer R> ? ApiResult<R> : ApiResult;
};

export class BatchRequestError extends Error {
  constructor(
    message: string,
    readonly key: string,
    readonly result?: ErrorResult,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BatchRequestError";
  }
}

export interface BatchOptions {
  /** Max concurrent requests. @default all at once */
  concurrency?: number;
  /** Stop on first failure (abort in-flight, skip the rest) and throw. @default false */
  failFast?: boolean;
  signal?: AbortSignal;
}

export async function batchRequests<const Items extends readonly BatchRequestItem[]>(
  engine: GotApiEngine,
  requests: Items,
  options?: BatchOptions,
): Promise<BatchResults<Items>> {
  const { failFast = false, signal } = options ?? {};
  const seen = new Set<string>();
  for (const r of requests) {
    if (seen.has(r.key)) throw new TypeError(`batchRequests: duplicate key "${r.key}".`);
    seen.add(r.key);
  }

  const limit = Math.max(1, Math.min(options?.concurrency ?? requests.length, requests.length || 1));
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onOuterAbort, { once: true });

  const results = new Map<string, ApiResult>();
  let failure: BatchRequestError | null = null;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if ((failFast && failure) || controller.signal.aborted) return;
      const item = requests[cursor++];
      if (!item) return;
      const itemSignal = item.options.signal ? AbortSignal.any([item.options.signal, controller.signal]) : controller.signal;
      try {
        const res = await engine.request({ ...item.options, signal: itemSignal, throwOnError: false });
        results.set(item.key, res);
        if (failFast && !res.ok && !failure) {
          failure = new BatchRequestError(res.error, item.key, res);
          controller.abort(failure);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Request failed";
        results.set(item.key, { ok: false, error: message, status: 500, code: "INTERNAL_ERROR" });
        if (failFast && !failure) {
          failure = new BatchRequestError(message, item.key, undefined, err);
          controller.abort(failure);
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: limit }, worker));
  } finally {
    signal?.removeEventListener("abort", onOuterAbort);
  }
  if (failure) throw failure;

  for (const item of requests) {
    if (!results.has(item.key)) results.set(item.key, { ok: false, error: "Request aborted.", status: 499, code: "ABORTED" });
  }
  // Object.fromEntries defines own properties, so a key like "__proto__" is safe.
  return Object.fromEntries(requests.map((r) => [r.key, results.get(r.key)])) as BatchResults<Items>;
}

// ── Retry helper (outside the engine's own retry layer) ─────────
export interface WithRetryOptions<T> {
  retries?: number;
  baseDelayMs?: number;
  /** Cap for a single computed delay. @default 10000 */
  maxDelayMs?: number;
  /** @default 0.2 */
  jitter?: number;
  shouldRetry?: (result: ApiResult<T>) => boolean;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; result: ApiResult<T> }) => void;
}

const NEVER_RETRY = new Set([
  "ABORTED",
  "REQUEST_VALIDATION",
  "REQUEST_INVALID",
  "SSRF_BLOCKED",
  "AUTH_REQUIRED",
  "CREDENTIALS_BLOCKED",
  "INVALID_URL",
]);

/** Transient failures only: network, 408/425/429 and 5xx except 501/505. */
function defaultShouldRetry<T>(r: ApiResult<T>): boolean {
  if (r.ok || (r.code && NEVER_RETRY.has(r.code))) return false;
  return [408, 425, 429].includes(r.status) || (r.status >= 500 && r.status !== 501 && r.status !== 505);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<ApiResult<T>>,
  options?: WithRetryOptions<T>,
): Promise<ApiResult<T>> {
  const {
    retries = 3,
    baseDelayMs = 300,
    maxDelayMs = 10_000,
    jitter = 0.2,
    shouldRetry = defaultShouldRetry,
    signal,
    onRetry,
  } = options ?? {};
  let last: ApiResult<T> | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await fn(attempt);
    if (result.ok || !shouldRetry(result)) return result;
    last = result;
    if (attempt < retries) {
      const computed = backoffDelay(attempt, { baseDelayMs, maxDelayMs, jitter });
      // The server's Retry-After is honoured even when it exceeds our own cap.
      const delayMs = Math.max(computed, result.meta?.retryAfterMs ?? 0);
      onRetry?.({ attempt: attempt + 1, delayMs, result });
      try {
        await sleep(delayMs, signal);
      } catch {
        return { ok: false, error: "Request aborted.", status: 499, code: "ABORTED" };
      }
    }
  }
  return last as ApiResult<T>;
}
