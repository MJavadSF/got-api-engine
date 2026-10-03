// =================================================================
// got-api-engine — In-memory LRU Cache Store
//
// Default response cache. O(1) get/set/evict using a Map's insertion-order
// guarantee (re-insert on access to mark as most-recently-used). Entries are
// physically dropped once their TTL elapses (the engine passes
// fresh-TTL + stale-TTL so stale-while-revalidate keeps working).
// =================================================================

import type { CacheStore, CachedResponse } from "../types";

interface Slot {
  value: CachedResponse;
  evictAt: number;
}

export class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, Slot>();
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(key: string): CachedResponse | undefined {
    const slot = this.map.get(key);
    if (!slot) return undefined;
    if (Date.now() >= slot.evictAt) {
      this.map.delete(key);
      return undefined;
    }
    // Mark as most-recently-used.
    this.map.delete(key);
    this.map.set(key, slot);
    return slot.value;
  }

  set(key: string, value: CachedResponse, ttlMs = Number.POSITIVE_INFINITY): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, evictAt: Date.now() + ttlMs });
    // Evict least-recently-used while over capacity.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deleteMatching(predicate: (key: string) => boolean): void {
    for (const key of [...this.map.keys()]) {
      if (predicate(key)) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
