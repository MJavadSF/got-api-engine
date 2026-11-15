// ── Execution stage: cache policy around the network stage ───────
//
//   fresh hit → return | stale + SWR → return stale, revalidate in background
//   miss → network (conditional when we hold validators)
//        → 304: refresh entry | 2xx: store | failure: stale-if-error
//   successful mutation → invalidate resource + tags

import { mutationTargets, type ResponseCache } from "../cache/response-cache";
import type { BackgroundTasks } from "../core/background";
import type { CancellationRegistry } from "../core/cancellation";
import { MUTATION_METHODS } from "../core/constants";
import type { MetricsCollector } from "../observability/metrics";
import type { CachedResponse } from "../types/cache";
import type { LoggerInterface } from "../types/observability";
import type { ApiResult, ErrorResult, ResultMeta, SuccessResult } from "../types/result";
import type { RequestContext } from "./context";
import type { NetworkStage } from "./network";

export interface ExecutorDeps {
  network: NetworkStage;
  cache: ResponseCache | null;
  metrics: MetricsCollector | null;
  background: BackgroundTasks;
  log: LoggerInterface;
  invalidateTags: (tags: string[]) => Promise<void>;
  /** Live cancellations (background work is aborted by dispose). */
  cancellations: CancellationRegistry;
}

const isUpstreamFailure = (r: ErrorResult): boolean =>
  r.status >= 500 || r.code === "NETWORK_ERROR" || r.code === "TIMEOUT" || r.code === "CIRCUIT_OPEN";

export class Executor {
  private readonly revalidating = new Set<string>();

  constructor(private readonly d: ExecutorDeps) {}

  async execute(ctx: RequestContext): Promise<ApiResult<unknown>> {
    const result = await this.withCache(ctx);
    if (result.ok && MUTATION_METHODS.has(ctx.method)) await this.afterMutation(ctx, result);
    return result;
  }

  private async withCache(ctx: RequestContext): Promise<ApiResult<unknown>> {
    const cache = this.d.cache;
    if (!cache?.eligible(ctx)) return this.plainNetwork(ctx);

    const key = cache.keyFor(ctx);
    const entry = await cache.get(key, ctx.headers);
    const state = entry ? cache.freshness(entry) : "expired";

    if (entry && state === "fresh" && !cache.mustRevalidate(entry)) {
      this.d.metrics?.inc("cacheHits");
      ctx.log.debug("Cache hit");
      return this.fromEntry(cache, entry, {});
    }
    if (entry && state === "stale" && cache.swrEnabled(ctx.options) && !cache.mustRevalidate(entry)) {
      this.d.metrics?.inc("cacheHits");
      this.d.metrics?.inc("staleServed");
      ctx.log.debug("Cache stale — serving stale, revalidating");
      this.revalidate(ctx, key, entry);
      return this.fromEntry(cache, entry, { stale: true, staleReason: "revalidating" });
    }
    this.d.metrics?.inc("cacheMisses");

    const outcome = await this.d.network.run(
      ctx,
      entry && cache.cfg.conditional ? { etag: entry.etag, lastModified: entry.lastModified } : undefined,
    );
    if (outcome.kind === "not-modified") {
      // A 304 is only possible because we sent validators, i.e. we hold `entry`.
      const refreshed = await cache.refresh(key, entry as CachedResponse, outcome.headers, ctx.options);
      return this.fromEntry(cache, refreshed, {
        attempts: outcome.attempts,
        ...(outcome.timings ? { timings: outcome.timings } : {}),
      });
    }

    const result = outcome.result;
    if (result.ok) {
      await cache.put(key, {
        status: result.status,
        body: result.data,
        headers: result.headers ?? {},
        requestHeaders: ctx.headers,
        options: ctx.options,
      });
      return result;
    }
    if (entry && cache.cfg.staleIfError && !entry.mustRevalidate && isUpstreamFailure(result)) {
      this.d.metrics?.inc("staleServed");
      ctx.log.warn(`Upstream failed (${result.code ?? result.status}) — serving stale cache`);
      return this.fromEntry(cache, entry, { stale: true, staleReason: "error" });
    }
    return result;
  }

  private async plainNetwork(ctx: RequestContext): Promise<ApiResult<unknown>> {
    const outcome = await this.d.network.run(ctx);
    if (outcome.kind === "result") return outcome.result;
    // Caller sent its own validators.
    return { ok: true, data: "", status: 304, headers: outcome.headers, meta: { attempts: outcome.attempts } };
  }

  private fromEntry(cache: ResponseCache, entry: CachedResponse, meta: ResultMeta): SuccessResult<unknown> {
    return { ok: true, data: cache.read(entry), status: entry.status, headers: entry.headers, meta: { cached: true, ...meta } };
  }

  /** One background revalidation per key; not tied to the caller's signal. */
  private revalidate(ctx: RequestContext, key: string, entry: CachedResponse): void {
    if (this.revalidating.has(key) || this.d.cancellations.isClosed) return;
    this.revalidating.add(key);
    const cancel = this.d.cancellations.create();
    const bg: RequestContext = {
      ...ctx,
      headers: { ...ctx.headers },
      cancel,
      signal: cancel.signal,
      callerSignal: undefined,
      totalTimeoutMs: 0,
    };
    const cache = this.d.cache as ResponseCache;
    const task = (async () => {
      const outcome = await this.d.network.run(
        bg,
        cache.cfg.conditional ? { etag: entry.etag, lastModified: entry.lastModified } : undefined,
      );
      if (outcome.kind === "not-modified") {
        await cache.refresh(key, entry, outcome.headers, ctx.options);
      } else if (outcome.result.ok) {
        const r = outcome.result;
        await cache.put(key, {
          status: r.status,
          body: r.data,
          headers: r.headers ?? {},
          requestHeaders: bg.headers,
          options: ctx.options,
        });
      } else {
        ctx.log.warn("Background revalidation failed", { status: outcome.result.status, code: outcome.result.code });
      }
    })()
      .catch((err: unknown) => ctx.log.warn("Background revalidation threw", { err: String(err) }))
      .finally(() => this.d.cancellations.unregister(cancel))
      .finally(() => this.revalidating.delete(key));
    this.d.background.run(task);
  }

  private async afterMutation(ctx: RequestContext, result: SuccessResult<unknown>): Promise<void> {
    const cache = this.d.cache;
    if (cache?.cfg.invalidateOnMutation) await cache.invalidateResources(mutationTargets(ctx.url, result.headers ?? {}));
    const tags = ctx.options.invalidateTags;
    if (tags?.length) await this.d.invalidateTags(tags);
  }
}
