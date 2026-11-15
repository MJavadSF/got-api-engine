// ── GotApiEngine — the public facade ─────────────────────────────
//
// Request pipeline (outermost → innermost):
//   prepare → middleware → dedupe → cache → network (gates → send → retry)
//   → finalize (per caller: key transforms, responseSchema) → fallback
//
// The class wires stages together; the logic lives in `pipeline/*`.

import { ApiError } from "../errors/api-error";
import { toSafeError } from "../errors/classify";
import { type Batcher, type BatcherOptions, type BatchLoadFn, createBatcher } from "../features/batcher";
import { bindEndpoint, bindEndpoints, type Endpoint, type EndpointDefinition } from "../features/endpoint";
import { type PaginateOptions, paginate } from "../features/paginate";
import { toCurl } from "../http/curl";
import { generateRequestId, sanitizeRequestId, startTimer } from "../http/misc";
import { cloneBody } from "../http/transform";
import { appendParams, buildUrl, normalizeUrl } from "../http/url";
import { toPrometheus } from "../observability/metrics";
import type { RequestContext } from "../pipeline/context";
import { SingleFlight } from "../pipeline/dedupe";
import { applyFallback, finalizeResult } from "../pipeline/finalize";
import { compose } from "../pipeline/middleware";
import { prepareRequest } from "../pipeline/prepare";
import { buildKeyMatcher } from "../security/redact";
import type { EngineConfig } from "../types/config";
import type { HttpMethod, ParamValue } from "../types/http";
import type { Middleware, MiddlewareContext } from "../types/middleware";
import type { HealthReport, LoggerInterface, MetricsSnapshot } from "../types/observability";
import type { RequestOptions } from "../types/request";
import type { CircuitState } from "../types/resilience";
import type { ApiResult } from "../types/result";
import { mergeEngineConfig } from "./config";
import { SAFE_METHODS } from "./constants";
import { fail, withMeta } from "./result";
import { createRuntime, type Runtime } from "./runtime";

/**
 * Per-request child logger, created only when something is actually logged —
 * most requests log nothing, and building a redacted child costs allocations.
 */
function lazyChild(base: LoggerInterface, meta: Record<string, unknown>): LoggerInterface {
  if (!base.child) return base;
  let child: LoggerInterface | undefined;
  const get = (): LoggerInterface => (child ??= (base.child as (m: Record<string, unknown>) => LoggerInterface)(meta));
  const enabled = base.isLevelEnabled?.bind(base);
  const at =
    (level: "debug" | "info" | "warn" | "error") =>
    (m: string, x?: Record<string, unknown>): void => {
      if (enabled && !enabled(level)) return;
      get()[level](m, x);
    };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (m) => get().child?.(m) ?? get(),
    ...(enabled ? { isLevelEnabled: enabled } : {}),
  };
}

/** Options of the bodyless verb helpers (`get`, `head`, `options`). */
export type BodylessOptions<TResponse> = Omit<RequestOptions<never, TResponse>, "endpoint" | "method" | "body">;
/** Options of the verb helpers that take a body (`post`, `put`, `patch`, `query`). */
export type BodyOptions<TBody, TResponse> = Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method" | "body">;

export class GotApiEngine {
  /** Resolved subsystems (advanced use: custom adapters, tests). */
  /** @internal Resolved subsystems; not part of the public API. */
  protected readonly rt: Runtime;
  private readonly flights = new SingleFlight<ApiResult<unknown>>();
  private disposed = false;

  constructor(config: EngineConfig) {
    this.rt = createRuntime(config);
  }

  /** The configuration this engine was built from (plus middleware added via `use`). */
  get config(): Readonly<EngineConfig> {
    return { ...this.rt.config, middleware: this.rt.middleware };
  }

  protected get log() {
    return this.rt.log;
  }

  // ── Middleware ────────────────────────────────────────────────
  /** Append middleware (runs in registration order). */
  use(...middleware: Middleware[]): this {
    this.rt.middleware.push(...middleware);
    return this;
  }

  // ── Requests ──────────────────────────────────────────────────
  async request<TResponse = unknown, TBody = unknown>(options: RequestOptions<TBody, TResponse>): Promise<ApiResult<TResponse>> {
    const result = (await this.run(options as RequestOptions<unknown, unknown>)) as ApiResult<TResponse>;
    if (!result.ok && (options.throwOnError ?? this.rt.config.throwOnError)) throw new ApiError(result);
    return result;
  }

  /** Like `request()` but resolves to `data` and throws `ApiError` on failure. */
  async requestData<TResponse = unknown, TBody = unknown>(options: RequestOptions<TBody, TResponse>): Promise<TResponse> {
    const result = await this.request<TResponse, TBody>({ ...options, throwOnError: true });
    return (result as Extract<ApiResult<TResponse>, { ok: true }>).data;
  }

  private async run(options: RequestOptions<unknown, unknown>): Promise<ApiResult<unknown>> {
    const rt = this.rt;
    const method: HttpMethod = options.method ?? "GET";
    const requestId = sanitizeRequestId(options.requestId) ?? generateRequestId();
    const elapsed = startTimer();
    const log = lazyChild(rt.log, { requestId });
    rt.metrics?.inc("totalRequests");

    let result: ApiResult<unknown>;
    if (this.disposed) {
      result = fail(rt.messages("ENGINE_DISPOSED"), 503, { code: "ENGINE_DISPOSED" });
    } else {
      const prepared = await prepareRequest(rt, { options, method, requestId, log, elapsed });
      if (prepared.ok) {
        try {
          result = await this.execute(prepared.ctx);
        } finally {
          prepared.ctx.cancel.release();
          rt.cancellations.unregister(prepared.ctx.cancel);
        }
      } else result = prepared.result;
    }

    result = (await applyFallback(result, options)) ?? result;
    if (result.ok && result.meta?.fallback) rt.metrics?.inc("fallbackServed");
    result = withMeta(result, { requestId, durationMs: elapsed() });
    rt.metrics?.recordResult(result.ok, result.ok ? undefined : result.code);
    return result;
  }

  private async execute(ctx: RequestContext): Promise<ApiResult<unknown>> {
    const rt = this.rt;
    const mwCtx: MiddlewareContext = {
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
      headers: ctx.headers,
      body: ctx.body,
      options: ctx.options,
      signal: ctx.callerSignal,
      state: ctx.state,
      onAttempt: (hook) => {
        ctx.attemptHooks.push(hook);
      },
    };
    try {
      const raw = await compose(rt.middleware, () => this.core(ctx))(mwCtx);
      const result = await finalizeResult(raw, ctx.options, rt.config, rt.messages);
      // A cached body that no longer satisfies the caller's schema → refetch once.
      if (!result.ok && result.code === "RESPONSE_VALIDATION" && raw.ok && raw.meta?.cached) {
        const fresh = await this.core({ ...ctx, options: { ...ctx.options, cache: false } });
        return finalizeResult(fresh, ctx.options, rt.config, rt.messages);
      }
      return result;
    } catch (err) {
      ctx.log.error("Unexpected engine error", { err: toSafeError(err) });
      return fail(rt.messages("INTERNAL_ERROR"), 500, { code: "INTERNAL_ERROR", details: toSafeError(err) });
    }
  }

  /** Dedupe (safe, replayable requests) → executor. */
  private async core(ctx: RequestContext): Promise<ApiResult<unknown>> {
    const rt = this.rt;
    const canDedupe =
      (rt.config.dedupe ?? true) &&
      ctx.options.dedupe !== false &&
      SAFE_METHODS.has(ctx.method) &&
      ctx.replayable &&
      ctx.responseType !== "stream";
    if (!canDedupe) return rt.executor.execute(ctx);

    // In-process only (never stored), so the raw URL is fine — no HMAC on the hot path.
    const key = `${ctx.method} ${ctx.url}|${ctx.authFp}|${ctx.variantFp}`;
    const handle = this.flights.join(key, ctx.callerSignal, async (shared) => {
      // The shared execution outlives any single caller: it stops when all callers
      // abort, at the leader's deadline, or on dispose.
      const cancel = rt.cancellations.create().follow(shared, "shared").deadline(ctx.totalTimeoutMs);
      try {
        return await rt.executor.execute({ ...ctx, cancel, signal: cancel.signal, callerSignal: undefined });
      } finally {
        cancel.release();
        rt.cancellations.unregister(cancel);
      }
    });
    if (!handle.leader) {
      rt.metrics?.inc("dedupeHits");
      ctx.log.debug("Joined in-flight request (dedupe)");
    }

    let shared: ApiResult<unknown>;
    try {
      shared = await handle.promise;
    } catch {
      return fail(rt.messages("ABORTED"), 499, { code: "ABORTED" });
    }
    if (handle.leader) return shared;
    const meta = { ...shared.meta, deduped: true };
    return shared.ok ? { ...shared, data: cloneBody(shared.data), meta } : { ...shared, meta };
  }

  // ── Verb helpers ──────────────────────────────────────────────
  get<TResponse = unknown>(endpoint: string, options?: BodylessOptions<TResponse>): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, never>({ ...options, endpoint, method: "GET" });
  }

  head(endpoint: string, options?: BodylessOptions<unknown>): Promise<ApiResult<unknown>> {
    return this.request<unknown, never>({ ...options, endpoint, method: "HEAD" });
  }

  options<TResponse = unknown>(endpoint: string, options?: BodylessOptions<TResponse>): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, never>({ ...options, endpoint, method: "OPTIONS" });
  }

  post<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: BodyOptions<TBody, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, TBody>({ ...options, endpoint, method: "POST", ...(body !== undefined ? { body } : {}) });
  }

  put<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: BodyOptions<TBody, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, TBody>({ ...options, endpoint, method: "PUT", ...(body !== undefined ? { body } : {}) });
  }

  patch<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: BodyOptions<TBody, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, TBody>({ ...options, endpoint, method: "PATCH", ...(body !== undefined ? { body } : {}) });
  }

  delete<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    options?: Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method">,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, TBody>({ ...options, endpoint, method: "DELETE" });
  }

  /** HTTP `QUERY` — safe, idempotent, with a body. */
  query<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: BodyOptions<TBody, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, TBody>({ ...options, endpoint, method: "QUERY", ...(body !== undefined ? { body } : {}) });
  }

  // ── Typed endpoints / pagination / batching ──────────────────
  endpoint<P extends string, TResponse, TBody, TQuery extends Record<string, ParamValue>>(
    def: EndpointDefinition<P, TResponse, TBody, TQuery>,
  ): Endpoint<P, TResponse, TBody, TQuery> {
    return bindEndpoint((o) => this.request(o), def);
  }

  endpoints<D extends Record<string, EndpointDefinition<string, unknown, unknown, Record<string, ParamValue>>>>(defs: D) {
    return bindEndpoints((o) => this.request(o), defs);
  }

  paginate<T>(endpoint: string, options?: PaginateOptions<T>): AsyncGenerator<T, void, undefined> {
    return paginate<T>((o) => this.request(o), this.rt.pool.primary.base, endpoint, options);
  }

  batcher<K, V>(load: BatchLoadFn<K, V>, options?: BatcherOptions<K>): Batcher<K, V> {
    return createBatcher(load, options);
  }

  // ── Cache control ─────────────────────────────────────────────
  /** Warm the cache for a GET (errors are swallowed). */
  async prefetch(endpoint: string, options?: BodylessOptions<unknown>): Promise<void> {
    await this.get(endpoint, { ...options, throwOnError: false }).catch(() => undefined);
  }

  /** Prefetch many endpoints with bounded concurrency. */
  async warm(
    endpoints: ReadonlyArray<string | ({ endpoint: string } & BodylessOptions<unknown>)>,
    concurrency = 4,
  ): Promise<void> {
    const queue = [...endpoints];
    const worker = async (): Promise<void> => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        const { endpoint, ...opts } = typeof item === "string" ? { endpoint: item } : item;
        await this.prefetch(endpoint, opts);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  }

  async clearCache(): Promise<void> {
    await this.rt.cache?.clear();
  }

  /** Invalidate one exact cache entry (same credentials / headers / response type). */
  async invalidateCache<TBody = unknown, TResponse = unknown>(
    method: HttpMethod,
    endpoint: string,
    options?: Pick<RequestOptions<TBody, TResponse>, "params" | "auth" | "authToken" | "headers" | "responseType" | "cache">,
  ): Promise<void> {
    const cache = this.rt.cache;
    if (!cache) return;
    const prepared = await prepareRequest(this.rt, {
      options: { ...options, endpoint, method } as RequestOptions<unknown, unknown>,
      method,
      requestId: "invalidate",
      log: this.rt.log,
      elapsed: () => 0,
    });
    if (!prepared.ok) return;
    await cache.delete(cache.keyFor(prepared.ctx));
  }

  /** Invalidate every cached variant of a resource (all principals, queries, headers). */
  async invalidateResource(endpoint: string): Promise<void> {
    await this.rt.cache?.invalidateResources([normalizeUrl(buildUrl(endpoint, this.rt.pool.primary.base))]);
  }

  /** Drop entries tagged with any of `tags` (and notify `onInvalidateTags`). */
  async invalidateTags(...tags: Array<string | string[]>): Promise<void> {
    await this.rt.invalidateTags(tags.flat());
  }

  // ── Observability ─────────────────────────────────────────────
  getMetrics(): MetricsSnapshot | null {
    return this.rt.metrics?.snapshot(this.getCircuitState()) ?? null;
  }

  resetMetrics(): void {
    this.rt.metrics?.reset();
  }

  /** Metrics in Prometheus text format (empty when metrics are disabled). */
  metricsText(labels: Record<string, string> = {}, prefix?: string): string {
    const snap = this.getMetrics();
    return snap ? toPrometheus(snap, prefix, { service: this.rt.serviceName, ...labels }) : "";
  }

  /** Worst circuit state, or the state of one breaker key (host by default). */
  getCircuitState(key?: string): CircuitState {
    return this.rt.circuits?.state(key) ?? "closed";
  }

  resetCircuit(key?: string): void {
    this.rt.circuits?.reset(key);
  }

  /** Readiness report; `ping` performs a live request. */
  async health(options: { ping?: string } = {}): Promise<HealthReport> {
    const rt = this.rt;
    const snap = this.getMetrics();
    const circuits = rt.circuits?.states() ?? {};
    const upstreams = rt.pool.health();
    let ping: HealthReport["ping"];
    if (options.ping) {
      const timer = startTimer();
      const r = await this.get(options.ping, {
        retry: false,
        cache: false,
        dedupe: false,
        auth: "optional",
        throwOnError: false,
      });
      ping = { ok: r.ok, status: r.status, durationMs: timer() };
    }
    const states = Object.values(circuits);
    const errorRate = snap?.totalRequests ? snap.errorCount / snap.totalRequests : 0;
    const allDown = upstreams.every((u) => !u.healthy) || (states.length > 0 && states.every((s) => s === "open"));
    const degraded = states.some((s) => s !== "closed") || upstreams.some((u) => !u.healthy) || errorRate > 0.5;
    return {
      status: this.disposed || allDown || ping?.ok === false ? "down" : degraded ? "degraded" : "ok",
      circuits,
      upstreams,
      inflight: this.flights.size,
      rateLimiterPending: rt.limiter?.pending ?? 0,
      latencyP95: snap?.latency.p95 ?? 0,
      errorRate: Math.round(errorRate * 1000) / 1000,
      ping,
    };
  }

  /** The request as a cURL command (credentials redacted unless `redact: false`). */
  async toCurl(options: RequestOptions<unknown, unknown>, redact = true): Promise<string> {
    const method = options.method ?? "GET";
    const prepared = await prepareRequest(this.rt, { options, method, requestId: "curl", log: this.rt.log, elapsed: () => 0 });
    const isSensitive = buildKeyMatcher(this.rt.config.redactKeys);
    if (!prepared.ok) {
      let url = buildUrl(options.endpoint, this.rt.pool.primary.base);
      if (options.params) url = appendParams(url, options.params);
      return toCurl({ method, url, headers: options.headers ?? {}, redact, isSensitiveHeader: isSensitive });
    }
    const { ctx } = prepared;
    return toCurl({ method, url: ctx.url, headers: ctx.headers, body: ctx.body, redact, isSensitiveHeader: isSensitive });
  }

  // ── Lifecycle ─────────────────────────────────────────────────
  /**
   * Abort in-flight requests (they resolve with `ENGINE_DISPOSED`), wait
   * briefly for background work, release sockets and timers.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rt.cancellations.abortAll();
    this.rt.lifecycle.abort(new DOMException("Engine disposed", "AbortError"));
    this.rt.limiter?.dispose?.();
    this.rt.bulkhead?.dispose();
    await this.rt.background.drain(1000);
    this.flights.clear();
    this.rt.transport.destroy();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  /**
   * New engine from this one's complete configuration plus `overrides`
   * (objects shallow-merged, headers merged, hooks / middleware appended).
   * State (cache, breakers, metrics, sockets) is not shared.
   */
  extend(overrides: Partial<EngineConfig>): this {
    const Ctor = this.constructor as new (config: EngineConfig) => this;
    return new Ctor(mergeEngineConfig(this.config as EngineConfig, overrides));
  }
}

export function createEngine(config: EngineConfig): GotApiEngine {
  return new GotApiEngine(config);
}
