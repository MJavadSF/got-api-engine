// ── DataLoader-style batching (fixes N+1 request patterns) ───────
//
//   const users = createBatcher(async (ids) => { …one request for all ids… });
//   await Promise.all([users.load(1), users.load(2)]);   // → 1 upstream call

export interface BatcherOptions<K> {
  /** Max keys per batch. @default 100 */
  maxBatch?: number;
  /** Collect window in ms (0 = same tick). @default 0 */
  delayMs?: number;
  /** Key identity for de-duplication. @default String(key) */
  cacheKey?: (key: K) => string;
}

export type BatchLoadFn<K, V> = (keys: readonly K[]) => Promise<ReadonlyArray<V | Error> | ReadonlyMap<K, V | Error>>;

export interface Batcher<K, V> {
  load(key: K): Promise<V | undefined>;
  loadMany(keys: readonly K[]): Promise<Array<V | undefined>>;
}

interface Pending<V> {
  resolve: (v: V | undefined) => void;
  reject: (e: unknown) => void;
}

export function createBatcher<K, V>(loadFn: BatchLoadFn<K, V>, options: BatcherOptions<K> = {}): Batcher<K, V> {
  const maxBatch = Math.max(1, options.maxBatch ?? 100);
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const idOf = options.cacheKey ?? ((k: K) => String(k));

  let queue = new Map<string, { key: K; waiters: Pending<V>[] }>();
  let scheduled = false;

  const dispatch = async (batch: Map<string, { key: K; waiters: Pending<V>[] }>): Promise<void> => {
    const entries = [...batch.values()];
    const keys = entries.map((e) => e.key);
    try {
      const result = await loadFn(keys);
      entries.forEach((entry, i) => {
        const value = result instanceof Map ? result.get(entry.key) : (result as ReadonlyArray<V | Error>)[i];
        for (const w of entry.waiters) value instanceof Error ? w.reject(value) : w.resolve(value);
      });
    } catch (err) {
      for (const entry of entries) for (const w of entry.waiters) w.reject(err);
    }
  };

  const flush = (): void => {
    scheduled = false;
    const all = queue;
    queue = new Map();
    let chunk = new Map<string, { key: K; waiters: Pending<V>[] }>();
    for (const [id, entry] of all) {
      chunk.set(id, entry);
      if (chunk.size >= maxBatch) {
        void dispatch(chunk);
        chunk = new Map();
      }
    }
    if (chunk.size) void dispatch(chunk);
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    if (delayMs > 0) setTimeout(flush, delayMs);
    else queueMicrotask(flush);
  };

  const load = (key: K): Promise<V | undefined> =>
    new Promise<V | undefined>((resolve, reject) => {
      const id = idOf(key);
      const entry = queue.get(id) ?? { key, waiters: [] };
      entry.waiters.push({ resolve, reject });
      queue.set(id, entry);
      schedule();
    });

  return { load, loadMany: (keys) => Promise.all(keys.map(load)) };
}
