/**
 * Redis-backed cache store and distributed rate limiter (no Redis dependency).
 *
 * @packageDocumentation
 * @module got-api-engine/redis
 */
// ── got-api-engine/redis — shared cache store + distributed limiter ──
//
// Works with any client exposing the commands below (ioredis, node-redis v4+
// via a tiny wrapper). No runtime dependency on a Redis package.

import { resourceOfKey } from "../cache/cache-key";
import { sleep } from "../resilience/backoff";
import { RateLimitError } from "../resilience/rate-limiter";
import type { CachedResponse, CacheStore } from "../types/cache";
import type { RateLimiterLike } from "../types/resilience";

/** Minimal Redis command surface (ioredis-compatible signatures). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string, match: "MATCH", pattern: string, count: "COUNT", n: number): Promise<[string, string[]]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  pexpire(key: string, ms: number): Promise<number>;
  incr(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  /**
   * Optional (ioredis signature). When present, tag bookkeeping is atomic;
   * without it, concurrent writers may briefly under-extend a tag index.
   */
  eval?(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * Add `ARGV[1]` to the index set (tag or resource) `KEYS[1]` and extend its TTL to at least
 * `ARGV[2]` ms — never shorten it. PTTL is -1 (no TTL) or -2 (missing) for new
 * sets, both below any positive TTL.
 */
export const ADD_TO_INDEX_SCRIPT = `redis.call("SADD", KEYS[1], ARGV[1])
local ttl = tonumber(ARGV[2])
if redis.call("PTTL", KEYS[1]) < ttl then redis.call("PEXPIRE", KEYS[1], ttl) end
return 1`;

/** Tag indexes outlive their entries by this margin (clock / rounding safety). */
const TAG_TTL_MARGIN_MS = 60_000;

/** Escape glob metacharacters for SCAN MATCH. */
const escapeGlob = (s: string): string => s.replace(/[*?[\]\\]/g, "\\$&");

// Buffers survive JSON round-trips as tagged base64.
const replacer = (_k: string, v: unknown): unknown =>
  v && typeof v === "object" && (v as { type?: unknown }).type === "Buffer" && Array.isArray((v as { data?: unknown }).data)
    ? { __b64: Buffer.from((v as { data: number[] }).data).toString("base64") }
    : v;
const reviver = (_k: string, v: unknown): unknown =>
  v && typeof v === "object" && typeof (v as { __b64?: unknown }).__b64 === "string"
    ? Buffer.from((v as { __b64: string }).__b64, "base64")
    : v;

export interface RedisCacheStoreOptions {
  /** Key namespace. @default "gae:" */
  prefix?: string;
  /** SCAN batch size for resource invalidation. @default 500 */
  scanCount?: number;
}

export class RedisCacheStore implements CacheStore {
  private readonly prefix: string;
  private readonly scanCount: number;

  constructor(
    private readonly redis: RedisLike,
    options: RedisCacheStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? "gae:";
    this.scanCount = options.scanCount ?? 500;
  }

  private k(key: string): string {
    return `${this.prefix}c:${key}`;
  }

  private tagKey(tag: string): string {
    return `${this.prefix}t:${tag}`;
  }

  private resourceKey(resource: string): string {
    return `${this.prefix}r:${resource}`;
  }

  async get(key: string): Promise<CachedResponse | undefined> {
    const raw = await this.redis.get(this.k(key));
    return raw ? (JSON.parse(raw, reviver) as CachedResponse) : undefined;
  }

  async set(key: string, value: CachedResponse, ttlMs: number): Promise<void> {
    const ttl = Math.max(1, Math.ceil(Number.isFinite(ttlMs) ? ttlMs : 86_400_000));
    // Index first: an entry must never exist without being reachable from its
    // tags and its resource (mutation invalidation without SCAN).
    const indexTtl = ttl + TAG_TTL_MARGIN_MS;
    const resource = resourceOfKey(key);
    if (resource !== undefined) await this.addToIndex(this.resourceKey(resource), key, indexTtl);
    for (const tag of value.tags ?? []) await this.addToIndex(this.tagKey(tag), key, indexTtl);
    await this.redis.set(this.k(key), JSON.stringify(value, replacer), "PX", ttl);
  }

  /**
   * An index set (tag or resource) must live as long as its longest-lived member. Its TTL is
   * only ever extended — a short-lived entry must not shorten the index and
   * strand longer-lived entries (they would survive `invalidateTags`).
   */
  private async addToIndex(indexKey: string, key: string, ttl: number): Promise<void> {
    if (this.redis.eval) {
      await this.redis.eval(ADD_TO_INDEX_SCRIPT, 1, indexKey, key, ttl);
      return;
    }
    await this.redis.sadd(indexKey, key);
    if ((await this.redis.pttl(indexKey)) < ttl) await this.redis.pexpire(indexKey, ttl);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.k(key));
  }

  private async scan(pattern: string, onBatch: (keys: string[]) => Promise<void>): Promise<void> {
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", this.scanCount);
      cursor = next;
      if (keys.length) await onBatch(keys);
    } while (cursor !== "0");
  }

  async deleteMatching(predicate: (key: string) => boolean): Promise<void> {
    const strip = `${this.prefix}c:`.length;
    await this.scan(`${escapeGlob(this.prefix)}c:*`, async (keys) => {
      const doomed = keys.filter((k) => predicate(k.slice(strip)));
      if (doomed.length) await this.redis.del(...doomed);
    });
  }

  async deleteByTags(tags: string[]): Promise<void> {
    for (const tag of tags) await this.dropIndex(this.tagKey(tag));
  }

  /** Mutation invalidation via the resource index — no keyspace SCAN. */
  async deleteByResources(resources: string[]): Promise<void> {
    for (const resource of resources) await this.dropIndex(this.resourceKey(resource));
  }

  private async dropIndex(indexKey: string): Promise<void> {
    const keys = await this.redis.smembers(indexKey);
    if (keys.length) await this.redis.del(...keys.map((k) => this.k(k)));
    await this.redis.del(indexKey);
  }

  /** Remove cache entries and tag indexes only (other data under the prefix, e.g. limiters, is kept). */
  async clear(): Promise<void> {
    const prefix = escapeGlob(this.prefix);
    for (const pattern of [`${prefix}c:*`, `${prefix}t:*`, `${prefix}r:*`]) {
      await this.scan(pattern, async (keys) => {
        await this.redis.del(...keys);
      });
    }
  }
}

export interface RedisRateLimiterOptions {
  /** Requests allowed per window, across all instances. */
  limit: number;
  /** Window length (ms). @default 1000 */
  windowMs?: number;
  /** @default "gae:rl:" */
  prefix?: string;
  /** "wait" for the next window (bounded by maxWaitMs) or "reject". @default "wait" */
  onLimit?: "wait" | "reject";
  /** @default 10000 */
  maxWaitMs?: number;
  /** Logical limiter name (share a quota between engines). @default "default" */
  name?: string;
}

/** Fixed-window limiter shared by every instance using the same Redis. */
export class RedisRateLimiter implements RateLimiterLike {
  private readonly windowMs: number;
  private readonly prefix: string;
  private pausedUntil = 0;

  constructor(
    private readonly redis: RedisLike,
    private readonly opts: RedisRateLimiterOptions,
  ) {
    this.windowMs = Math.max(1, opts.windowMs ?? 1000);
    this.prefix = `${opts.prefix ?? "gae:rl:"}${opts.name ?? "default"}:`;
  }

  pauseUntil(epochMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, epochMs);
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.opts.maxWaitMs ?? 10_000);
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        if (this.opts.onLimit === "reject" || this.pausedUntil > deadline) throw new RateLimitError();
        await sleep(this.pausedUntil - now, signal);
        continue;
      }
      const window = Math.floor(now / this.windowMs);
      const key = `${this.prefix}${window}`;
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.pexpire(key, this.windowMs * 2);
      if (count <= this.opts.limit) return;

      const wait = (window + 1) * this.windowMs - now;
      if (this.opts.onLimit === "reject" || now + wait > deadline) throw new RateLimitError();
      await sleep(wait, signal);
    }
  }
}
