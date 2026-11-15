import type { HttpMethod } from "./http";

export type CacheCopyMode = "clone" | "freeze" | "none";

export interface CacheKeyInput {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
}

export interface CacheConfig {
  enabled?: boolean;
  /** Default TTL in ms. @default 30000 */
  ttlMs?: number;
  /** Max entries in the default in-memory store (LRU). @default 500 */
  maxEntries?: number;
  /** Max approximate bytes in the default in-memory store. @default 50 MiB */
  maxSizeBytes?: number;
  /** Serve stale while revalidating in the background. @default false */
  staleWhileRevalidate?: boolean;
  /** Serve stale when upstream fails (network, timeout, 5xx, circuit open). @default false */
  staleIfError?: boolean;
  /** How long past expiry an entry stays usable. @default 300000 */
  staleTtlMs?: number;
  /** Methods eligible for caching. @default ["GET","HEAD"] */
  methods?: HttpMethod[];
  /** Custom store (e.g. `RedisCacheStore` from `got-api-engine/redis`). */
  store?: CacheStore;
  /** ETag / Last-Modified revalidation. @default true */
  conditional?: boolean;
  /**
   * Honour upstream `Cache-Control` (`max-age`, `s-maxage` when `shared`,
   * `no-cache`, `must-revalidate`, `stale-while-revalidate=`, `stale-if-error=`). @default false
   */
  respectCacheControl?: boolean;
  /** Drop cached reads of a resource after a successful mutation. @default true */
  invalidateOnMutation?: boolean;
  /** @deprecated use `copy`. `false` ≙ `copy: "none"`. */
  cloneOnRead?: boolean;
  /**
   * Protect cached data from caller mutation: deep `"clone"` per read,
   * `"freeze"` once on store (fast, read-only data) or `"none"`. @default "clone"
   */
  copy?: CacheCopyMode;
  /**
   * Secret for hashing credentials / query strings inside cache keys (HMAC).
   * Set it when several instances share a store. @default random per process
   */
  keySecret?: string;
  /**
   * Shared (public) cache: entries are NOT partitioned per credential and
   * `Cache-Control: private` responses are not stored. @default false
   */
  shared?: boolean;
  /**
   * Custom key: replaces the query-string and header/response-type parts of
   * the key (origin + path and credentials still apply). Return undefined
   * for the default key.
   */
  key?: (input: CacheKeyInput) => string | undefined;
}

/** Per-request cache options. */
export interface RequestCacheOptions {
  ttlMs?: number;
  staleWhileRevalidate?: boolean;
  /** Tags for `invalidateTags()`. */
  tags?: string[];
  shared?: boolean;
  key?: (input: CacheKeyInput) => string | undefined;
}

/** Pluggable cache store. Defaults to an in-memory LRU. */
export interface CacheStore {
  get(key: string): CachedResponse | undefined | Promise<CachedResponse | undefined>;
  set(key: string, value: CachedResponse, ttlMs: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
  /** Delete every key matching the predicate (resource invalidation). */
  deleteMatching?(predicate: (key: string) => boolean): void | Promise<void>;
  /** Delete every entry carrying any of `tags`. */
  deleteByTags?(tags: string[]): void | Promise<void>;
  /**
   * Delete every entry of the given resources (`origin + pathname`, all
   * variants). Stores that index resources implement this so a mutation does
   * not scan the whole store; otherwise `deleteMatching` is used.
   */
  deleteByResources?(resources: string[]): void | Promise<void>;
}

export interface CachedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** Epoch ms when this entry becomes stale. */
  expiresAt: number;
  storedAt: number;
  etag?: string | undefined;
  lastModified?: string | undefined;
  tags?: string[] | undefined;
  /** Request header values this entry varies on (from `Vary`). */
  vary?: Record<string, string> | undefined;
  /** Per-entry stale window override (ms) from `stale-while-revalidate=` / `stale-if-error=`. */
  staleTtlMs?: number | undefined;
  /** `must-revalidate`: never serve stale. */
  mustRevalidate?: boolean | undefined;
}
