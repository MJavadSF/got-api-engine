// =================================================================
// got-api-engine/node — Node.js / Vanilla JS Adapter
// Use this outside of Next.js (plain Node, Express, Fastify, etc.)
// =================================================================

import { GotApiEngine, createEngine } from "../core/engine";
import type { EngineConfig, RequestOptions, ApiResult } from "../types/index";

// Re-export everything from core for convenience
export { GotApiEngine, createEngine };
export type { EngineConfig, RequestOptions, ApiResult };

// ── Node-specific: batch requests ────────────────────────────────
export interface BatchRequestItem<TResponse = unknown, TBody = unknown> {
  key: string;
  options: RequestOptions<TBody, TResponse>;
}

export type BatchResult<T extends Record<string, ApiResult>> = T;

export async function batchRequests<
  TResults extends Record<string, ApiResult> = Record<string, ApiResult>,
>(
  engine: GotApiEngine,
  requests: BatchRequestItem[],
  options?: {
    /** Maximum concurrent requests. Defaults to all parallel. */
    concurrency?: number;
    /** Stop on first error. @default false */
    failFast?: boolean;
  },
): Promise<TResults> {
  const { concurrency, failFast = false } = options ?? {};
  const results: Record<string, ApiResult> = {};

  if (!concurrency || concurrency >= requests.length) {
    // All parallel.
    const settled = await Promise.allSettled(
      requests.map((r) => engine.request(r.options).then((res) => ({ key: r.key, res }))),
    );
    for (const s of settled) {
      if (s.status === "fulfilled") {
        results[s.value.key] = s.value.res;
        if (failFast && !s.value.res.ok) {
          throw new Error(s.value.res.error ?? "Request failed");
        }
      } else if (failFast) {
        throw s.reason;
      }
    }
    return results as TResults;
  }

  // Sliding-window pool: keep exactly `concurrency` requests in flight,
  // starting the next as soon as any finishes (higher throughput than
  // fixed chunks, which stall on the slowest item in each chunk).
  let cursor = 0;
  let aborted: unknown = null;

  const worker = async (): Promise<void> => {
    while (true) {
      if (aborted) return;
      const index = cursor++;
      if (index >= requests.length) return;
      const item = requests[index]!;
      try {
        const res = await engine.request(item.options);
        results[item.key] = res;
        if (failFast && !res.ok) {
          aborted = new Error(res.error ?? "Request failed");
          return;
        }
      } catch (err) {
        if (failFast) {
          aborted = err;
          return;
        }
      }
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, requests.length) }, () => worker());
  await Promise.all(pool);

  if (aborted) throw aborted;
  return results as TResults;
}

// ── Retry helper with exponential backoff (outside got's own retry)
export async function withRetry<T>(
  fn: () => Promise<ApiResult<T>>,
  options?: {
    retries?: number;
    baseDelayMs?: number;
    shouldRetry?: (result: ApiResult<T>) => boolean;
  },
): Promise<ApiResult<T>> {
  const { retries = 3, baseDelayMs = 300, shouldRetry } = options ?? {};

  const defaultShouldRetry = (r: ApiResult<T>) => !r.ok && r.status >= 500;

  const check = shouldRetry ?? defaultShouldRetry;

  let lastResult: ApiResult<T> | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await fn();
    if (result.ok || !check(result)) return result;

    lastResult = result;
    if (attempt < retries) {
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return lastResult!;
}
