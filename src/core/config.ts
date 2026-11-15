// ── Configuration: validation, defaults, merging ────────────────

import { mergeHeaders } from "../http/headers";
import { asArray } from "../http/misc";
import type { CacheCopyMode } from "../types/cache";
import type { EngineConfig } from "../types/config";
import type { HttpMethod } from "../types/http";
import { DEFAULTS, SAFE_METHODS } from "./constants";

export interface ResolvedCacheConfig {
  ttlMs: number;
  maxEntries: number;
  maxSizeBytes: number;
  staleWhileRevalidate: boolean;
  staleIfError: boolean;
  staleTtlMs: number;
  methods: ReadonlySet<HttpMethod>;
  conditional: boolean;
  respectCacheControl: boolean;
  invalidateOnMutation: boolean;
  copy: CacheCopyMode;
  shared: boolean;
  key: NonNullable<EngineConfig["cache"]>["key"];
}

/** Normalise a base URL: canonical host, no trailing slash. Throws TypeError. */
export function normalizeBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TypeError(`got-api-engine: invalid baseUrl "${raw}".`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new TypeError("got-api-engine: baseUrl must use http: or https:.");
  }
  u.hash = "";
  u.search = "";
  return u.href.replace(/\/+$/, "");
}

export function resolveBases(baseUrl: EngineConfig["baseUrl"] | undefined): string[] {
  const list = asArray(baseUrl as string | string[] | undefined).filter((b) => typeof b === "string" && b.trim() !== "");
  if (list.length === 0) throw new TypeError("got-api-engine: `baseUrl` is required.");
  return list.map(normalizeBase);
}

export function resolveCacheConfig(cfg: EngineConfig["cache"]): ResolvedCacheConfig | null {
  if (!cfg?.enabled) return null;
  return {
    ttlMs: cfg.ttlMs ?? DEFAULTS.cacheTtlMs,
    maxEntries: cfg.maxEntries ?? DEFAULTS.cacheMaxEntries,
    maxSizeBytes: cfg.maxSizeBytes ?? DEFAULTS.cacheMaxBytes,
    staleWhileRevalidate: cfg.staleWhileRevalidate ?? false,
    staleIfError: cfg.staleIfError ?? false,
    staleTtlMs: cfg.staleTtlMs ?? DEFAULTS.staleTtlMs,
    methods: new Set(cfg.methods ?? [...SAFE_METHODS]),
    conditional: cfg.conditional ?? true,
    respectCacheControl: cfg.respectCacheControl ?? false,
    invalidateOnMutation: cfg.invalidateOnMutation ?? true,
    copy: cfg.copy ?? (cfg.cloneOnRead === false ? "none" : "clone"),
    shared: cfg.shared ?? false,
    key: cfg.key,
  };
}

/**
 * Merge for `extend()`: config objects are shallow-merged, headers merged,
 * hooks / middleware appended, key lists unioned.
 */
export function mergeEngineConfig(base: EngineConfig, o: Partial<EngineConfig>): EngineConfig {
  const defined = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<EngineConfig>;
  const merged: EngineConfig = { ...base, ...defined };

  if (base.defaultHeaders || o.defaultHeaders) merged.defaultHeaders = mergeHeaders(base.defaultHeaders, o.defaultHeaders);
  if (base.cache && o.cache) merged.cache = { ...base.cache, ...o.cache };
  if (base.circuitBreaker && o.circuitBreaker) merged.circuitBreaker = { ...base.circuitBreaker, ...o.circuitBreaker };
  if (base.rateLimit && o.rateLimit) merged.rateLimit = { ...base.rateLimit, ...o.rateLimit };
  if (base.retry && o.retry) merged.retry = { ...base.retry, ...o.retry };
  if (base.concurrency && o.concurrency) merged.concurrency = { ...base.concurrency, ...o.concurrency };
  if (base.timeouts && o.timeouts) merged.timeouts = { ...base.timeouts, ...o.timeouts };
  if (base.tls && o.tls) merged.tls = { ...base.tls, ...o.tls };
  if (typeof base.ssrfProtection === "object" && typeof o.ssrfProtection === "object") {
    merged.ssrfProtection = { ...base.ssrfProtection, ...o.ssrfProtection };
  }
  if (base.redactKeys || o.redactKeys) merged.redactKeys = [...(base.redactKeys ?? []), ...(o.redactKeys ?? [])];
  if (base.credentialHosts || o.credentialHosts) {
    merged.credentialHosts = [...(base.credentialHosts ?? []), ...(o.credentialHosts ?? [])];
  }
  if (base.middleware || o.middleware) merged.middleware = [...(base.middleware ?? []), ...(o.middleware ?? [])];
  if (base.hooks || o.hooks) {
    const bh = base.hooks ?? {};
    const oh = o.hooks ?? {};
    merged.hooks = {
      onRequest: [...asArray(bh.onRequest), ...asArray(oh.onRequest)],
      onResponse: [...asArray(bh.onResponse), ...asArray(oh.onResponse)],
      onError: [...asArray(bh.onError), ...asArray(oh.onError)],
      onCircuitStateChange: [...asArray(bh.onCircuitStateChange), ...asArray(oh.onCircuitStateChange)],
      onRetry: [...asArray(bh.onRetry), ...asArray(oh.onRetry)],
    };
  }
  return merged;
}
