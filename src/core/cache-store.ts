// =================================================================
// got-api-engine — In-memory LRU Cache Store
//
// Default response cache. O(1) get/set/evict using a Map's insertion-order
// guarantee (re-insert on access to mark as most-recently-used).
// =================================================================

import type { CacheStore, CachedResponse } from "../types";

export class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, CachedResponse>();
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(key: string): CachedResponse | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Mark as most-recently-used.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, value: CachedResponse): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
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

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
