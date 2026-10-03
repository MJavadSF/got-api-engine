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
  /** Explicit method list, or null = idempotent methods (+ POST/PATCH with an Idempotency-Key). */
  methods: Set<HttpMethod> | null;
  respectRetryAfter: boolean;
  maxRetryAfterMs: number;
}

const DEFAULT_RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];
/** Methods that are idempotent per RFC 9110 (QUERY is safe + idempotent). */
const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
  "QUERY",
]);

export function resolveRetry(config?: RetryConfig, base?: ResolvedRetry): ResolvedRetry {
  const maxDelayMs = config?.maxDelayMs ?? base?.maxDelayMs ?? 10_000;
  return {
    limit: Math.max(0, Math.floor(config?.limit ?? base?.limit ?? 2)),
    baseDelayMs: config?.baseDelayMs ?? base?.baseDelayMs ?? 200,
    maxDelayMs,
    jitter: Math.min(1, Math.max(0, config?.jitter ?? base?.jitter ?? 0.2)),
    retryStatusCodes: config?.retryStatusCodes
      ? new Set(config.retryStatusCodes)
      : (base?.retryStatusCodes ?? new Set(DEFAULT_RETRY_STATUS)),
    methods: config?.methods ? new Set(config.methods) : (base?.methods ?? null),
    respectRetryAfter: config?.respectRetryAfter ?? base?.respectRetryAfter ?? true,
    maxRetryAfterMs: config?.maxRetryAfterMs ?? base?.maxRetryAfterMs ?? maxDelayMs,
  };
}

/** Is `method` eligible for retry? `hasIdempotencyKey` unlocks POST/PATCH. */
export function isRetryableMethod(r: ResolvedRetry, method: HttpMethod, hasIdempotencyKey: boolean): boolean {
  if (r.methods) return r.methods.has(method);
  if (IDEMPOTENT_METHODS.has(method)) return true;
  return hasIdempotencyKey && (method === "POST" || method === "PATCH");
}

/** Exponential backoff with symmetric jitter (±jitter × delay), capped at maxDelayMs. */
export function backoffDelay(attempt: number, r: ResolvedRetry): number {
  const exp = Math.min(r.maxDelayMs, r.baseDelayMs * 2 ** attempt);
  const jitterRange = exp * r.jitter;
  const delta = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(exp + delta));
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into ms. */
export function parseRetryAfter(header: string | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("Aborted", "AbortError");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
