// =================================================================
// got-api-engine — Backoff helpers
// =================================================================

import type { HttpMethod, RetryConfig } from "../types";

export interface ResolvedRetry {
  limit: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  retryStatusCodes: Set<number>;
  methods: Set<HttpMethod>;
  respectRetryAfter: boolean;
}

const DEFAULT_RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];
const DEFAULT_RETRY_METHODS: HttpMethod[] = ["GET", "PUT", "DELETE", "PATCH", "POST"];

export function resolveRetry(config?: RetryConfig): ResolvedRetry {
  return {
    limit: config?.limit ?? 2,
    baseDelayMs: config?.baseDelayMs ?? 200,
    maxDelayMs: config?.maxDelayMs ?? 10_000,
    jitter: Math.min(1, Math.max(0, config?.jitter ?? 0.2)),
    retryStatusCodes: new Set(config?.retryStatusCodes ?? DEFAULT_RETRY_STATUS),
    methods: new Set(config?.methods ?? DEFAULT_RETRY_METHODS),
    respectRetryAfter: config?.respectRetryAfter ?? true,
  };
}

/** Exponential backoff with full jitter, capped at maxDelayMs. */
export function backoffDelay(attempt: number, r: ResolvedRetry): number {
  const exp = Math.min(r.maxDelayMs, r.baseDelayMs * 2 ** attempt);
  const jitterRange = exp * r.jitter;
  const delta = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(exp + delta));
}

/** Parse a Retry-After header (seconds or HTTP date) into ms. */
export function parseRetryAfter(header: string | undefined): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
