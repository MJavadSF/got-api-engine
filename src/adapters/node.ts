// =================================================================
// got-api-engine/node — Node.js / Vanilla JS Adapter
// Use this outside of Next.js (plain Node, Express, Fastify, etc.)
// =================================================================

import { GotApiEngine, createEngine } from "../core/engine";
import type { EngineConfig, RequestOptions, ApiResult, ErrorResult } from "../types/index";
import { sleep } from "../core/backoff";

// Re-export everything from core for convenience
export { GotApiEngine, createEngine };
export type { EngineConfig, RequestOptions, ApiResult };

// ── Batch requests ───────────────────────────────────────────────
export interface BatchRequestItem<TResponse = unknown, TBody = unknown> {
  key: string;
  options: RequestOptions<TBody, TResponse>;
}

export type BatchResult<T extends Record<string, ApiResult>> = T;

/** Thrown by `batchRequests` in `failFast` mode. */
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
  /** Maximum concurrent requests. Defaults to all at once. */
  concurrency?: number;
  /**
   * Stop on first failure: unstarted requests are skipped and in-flight ones
   * are aborted, then a `BatchRequestError` is thrown. @default false
   */
  failFast?: boolean;
  /** Cancel the whole batch. */
  signal?: AbortSignal;
}

export async function batchRequests<
  TResults extends Record<string, ApiResult> = Record<string, ApiResult>,
>(
  engine: GotApiEngine,
  requests: BatchRequestItem[],
  options?: BatchOptions,
): Promise<TResults> {
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
      if (failFast && failure) return;
      if (controller.signal.aborted) return;
      const index = cursor++;
      const item = requests[index];
      if (!item) return;

      const itemSignal = item.options.signal
        ? AbortSignal.any([item.options.signal, controller.signal])
        : controller.signal;

      try {
        const res = await engine.request({ ...item.options, signal: itemSignal });
        results.set(item.key, res);
        if (failFast && !res.ok && !failure) {
          failure = new BatchRequestError(res.error, item.key, res);
          controller.abort(failure);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Request failed";
        results.set(item.key, { ok: false, error: message, status: 500, code: "NETWORK_ERROR" });
        if (failFast && !failure) {
          failure = new BatchRequestError(message, item.key, undefined, err);
          controller.abort(failure);
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: limit }, () => worker()));
  } finally {
    signal?.removeEventListener("abort", onOuterAbort);
  }

  if (failure) throw failure;

  // Requests that never started (batch aborted by the caller's signal).
  for (const item of requests) {
    if (!results.has(item.key)) {
      results.set(item.key, { ok: false, error: "Request aborted.", status: 499, code: "ABORTED" });
    }
  }
  // Object.fromEntries defines own properties, so a key like "__proto__" is safe.
  return Object.fromEntries(requests.map((r) => [r.key, results.get(r.key)!])) as TResults;
}

// ── Retry helper with exponential backoff (outside the engine's own retry) ──
export interface WithRetryOptions<T> {
  retries?: number;
  baseDelayMs?: number;
  /** Cap for a single delay. @default 10000 */
  maxDelayMs?: number;
  /** ±jitter fraction applied to each delay. @default 0.2 */
  jitter?: number;
  shouldRetry?: (result: ApiResult<T>) => boolean;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; result: ApiResult<T> }) => void;
}

/**
 * Default policy: transient failures only — network errors, 408/425/429 and
 * 5xx except 501/505. Client aborts and 4xx validation errors are never retried.
 */
function defaultShouldRetry<T>(r: ApiResult<T>): boolean {
  if (r.ok) return false;
  if (r.code === "ABORTED" || r.code === "REQUEST_VALIDATION" || r.code === "SSRF_BLOCKED") return false;
  if (r.code === "AUTH_REQUIRED" || r.code === "CREDENTIALS_BLOCKED") return false;
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
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jittered = Math.max(0, Math.round(exp + (Math.random() * 2 - 1) * exp * jitter));
      const hinted = result.meta?.retryAfterMs;
      const delayMs = hinted !== undefined ? Math.min(maxDelayMs, Math.max(jittered, hinted)) : jittered;
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
