// ── In-memory LRU cache store (entry- and byte-bounded) ──────────

import { DEFAULTS } from "../core/constants";
import type { CachedResponse, CacheStore } from "../types/cache";
import { resourceOfKey } from "./cache-key";

function index(map: Map<string, Set<string>>, name: string | undefined, key: string): void {
  if (name === undefined) return;
  const keys = map.get(name) ?? new Set<string>();
  keys.add(key);
  map.set(name, keys);
}

function unindex(map: Map<string, Set<string>>, name: string | undefined, key: string): void {
  if (name === undefined) return;
  const keys = map.get(name);
  keys?.delete(key);
  if (keys?.size === 0) map.delete(name);
}

interface Slot {
  value: CachedResponse;
  evictAt: number;
  size: number;
}

/** Rough byte size of a cached body (bounded work, never throws). */
export function estimateSize(value: unknown): number {
  if (value === null || value === undefined) return 8;
  if (typeof value === "string") return value.length * 2;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  if (typeof value !== "object") return 16;
  try {
    return (JSON.stringify(value)?.length ?? 16) * 2;
  } catch {
    return 1024;
  }
}

export interface MemoryCacheStoreOptions {
  maxEntries?: number;
  maxSizeBytes?: number;
}

export class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, Slot>();
  private readonly tagIndex = new Map<string, Set<string>>();
  /** resource (origin + path) → keys: O(variants) invalidation instead of a full scan. */
  private readonly resourceIndex = new Map<string, Set<string>>();
  private readonly maxEntries: number;
  private readonly maxSizeBytes: number;
  private bytes = 0;

  constructor(options: MemoryCacheStoreOptions | number = {}) {
    const opts = typeof options === "number" ? { maxEntries: options } : options;
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULTS.cacheMaxEntries);
    this.maxSizeBytes = Math.max(1, opts.maxSizeBytes ?? DEFAULTS.cacheMaxBytes);
  }

  get size(): number {
    return this.map.size;
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  get(key: string): CachedResponse | undefined {
    const slot = this.map.get(key);
    if (!slot) return undefined;
    if (Date.now() >= slot.evictAt) {
      this.remove(key);
      return undefined;
    }
    this.map.delete(key); // mark as most-recently-used
    this.map.set(key, slot);
    return slot.value;
  }

  set(key: string, value: CachedResponse, ttlMs = Number.POSITIVE_INFINITY): void {
    this.remove(key);
    const size = estimateSize(value.body) + 256;
    if (size > this.maxSizeBytes) return; // never cache something bigger than the whole cache
    this.map.set(key, { value, evictAt: Date.now() + ttlMs, size });
    this.bytes += size;
    index(this.resourceIndex, resourceOfKey(key), key);
    for (const tag of value.tags ?? []) index(this.tagIndex, tag, key);
    while (this.map.size > this.maxEntries || this.bytes > this.maxSizeBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  delete(key: string): void {
    this.remove(key);
  }

  deleteMatching(predicate: (key: string) => boolean): void {
    for (const key of [...this.map.keys()]) if (predicate(key)) this.remove(key);
  }

  deleteByResources(resources: string[]): void {
    for (const resource of resources) {
      for (const key of [...(this.resourceIndex.get(resource) ?? [])]) this.remove(key);
    }
  }

  deleteByTags(tags: string[]): void {
    for (const tag of tags) {
      for (const key of [...(this.tagIndex.get(tag) ?? [])]) this.remove(key);
      this.tagIndex.delete(tag);
    }
  }

  clear(): void {
    this.map.clear();
    this.tagIndex.clear();
    this.resourceIndex.clear();
    this.bytes = 0;
  }

  private remove(key: string): void {
    const slot = this.map.get(key);
    if (!slot) return;
    this.map.delete(key);
    this.bytes -= slot.size;
    unindex(this.resourceIndex, resourceOfKey(key), key);
    for (const tag of slot.value.tags ?? []) unindex(this.tagIndex, tag, key);
  }
}
