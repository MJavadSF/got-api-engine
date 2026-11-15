// ── Shared constants ─────────────────────────────────────────────

import type { HttpMethod } from "../types/http";

const set = (...m: HttpMethod[]): ReadonlySet<HttpMethod> => new Set<HttpMethod>(m);

/** Methods that may carry a request body. */
export const BODY_METHODS = set("POST", "PUT", "PATCH", "DELETE", "QUERY");
/** Methods that get an auto `Idempotency-Key`. */
export const IDEMPOTENCY_METHODS = set("POST", "PUT", "PATCH");
/** Methods whose success invalidates cached reads. */
export const MUTATION_METHODS = set("POST", "PUT", "PATCH", "DELETE");
/** Safe methods eligible for dedupe and hedging. */
export const SAFE_METHODS = set("GET", "HEAD");
/** Idempotent per RFC 9110 (QUERY is safe + idempotent). */
export const IDEMPOTENT_METHODS = set("GET", "HEAD", "PUT", "DELETE", "OPTIONS", "QUERY");

export const CACHEABLE_STATUS: ReadonlySet<number> = new Set([200, 203, 204]);
export const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304]);

export const MiB = 1024 * 1024;

export const DEFAULTS = {
  timeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  retryLimit: 2,
  maxResponseBytes: 50 * MiB,
  cacheTtlMs: 30_000,
  cacheMaxEntries: 500,
  cacheMaxBytes: 50 * MiB,
  staleTtlMs: 300_000,
  upstreamCooldownMs: 10_000,
  agent: { maxSockets: 128, maxFreeSockets: 32, keepAliveMsecs: 1000, idleTimeoutMs: 4000 },
} as const;
