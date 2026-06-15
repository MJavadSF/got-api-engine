// =================================================================
// got-api-engine — Core Engine (v2.1)
//
// Request pipeline (outermost → innermost):
//   rate-limit → circuit-breaker → in-flight dedupe → response cache
//     → execute (got) with backoff retry → validate → metrics
// =================================================================

import got, { type Got, type OptionsInit } from "got";
import https from "https";
import http from "http";

import type {
  EngineConfig,
  RequestOptions,
  ApiResult,
  HttpMethod,
  LoggerInterface,
  AuthMode,
  CacheConfig,
  CachedResponse,
  CacheStore,
  CircuitState,
  MetricsSnapshot,
  ResultMeta,
} from "../types";

import {
  generateRequestId,
  parseApiError,
  buildUrl,
  appendParams,
  resolveAuthHeader,
  isAuthRequired,
  isAuthOptional,
  isAuthDisabled,
  mergeHeaders,
  startTimer,
  buildCacheKey,
  generateIdempotencyKey,
  flattenHeaders,
} from "../utils/helpers";

import { createConsoleLogger } from "../utils/logger";
import { CircuitBreaker } from "./circuit-breaker";
import { MemoryCacheStore } from "./cache-store";
import { TokenBucket, RateLimitError } from "./rate-limiter";
import { MetricsCollector } from "./metrics";
import {
  resolveRetry,
  backoffDelay,
  parseRetryAfter,
  sleep,
  type ResolvedRetry,
} from "./backoff";
import {
  resolveSsrfConfig,
  assertUrlAllowed,
  buildRedirectGuard,
  buildRedactor,
  SsrfError,
} from "./security";

const BODY_METHODS: HttpMethod[] = ["POST", "PUT", "PATCH"];
const SAFE_METHODS: HttpMethod[] = ["GET", "HEAD" as HttpMethod];

// =================================================================
// ENGINE CLASS
// =================================================================

export class GotApiEngine {
  protected readonly config: Required<
    Pick<
      EngineConfig,
      | "baseUrl"
      | "timeoutMs"
      | "retryLimit"
      | "debug"
      | "serviceName"
      | "defaultAuth"
      | "rejectUnauthorized"
    >
  > &
    Pick<EngineConfig, "auth" | "defaultHeaders" | "hooks" | "logger">;

  protected readonly httpClient: Got;
  protected readonly log: LoggerInterface;

  // ── Production subsystems ──────────────────────────────────────
  protected readonly circuit: CircuitBreaker | null;
  protected readonly cacheStore: CacheStore | null;
  protected readonly cacheCfg: Required<Omit<CacheConfig, "store">> | null;
  protected readonly bucket: TokenBucket | null;
  protected readonly metricsCollector: MetricsCollector | null;
  protected readonly retryCfg: ResolvedRetry;
  protected readonly dedupeEnabled: boolean;
  protected readonly idempotencyEnabled: boolean;
  protected readonly ssrf: ReturnType<typeof resolveSsrfConfig>;
  protected readonly redact: (meta: unknown) => unknown;

  // In-flight request registry for dedupe (key → shared promise).
  private readonly inflight = new Map<string, Promise<ApiResult<unknown>>>();

  constructor(config: EngineConfig) {
    const isDev = process.env.NODE_ENV !== "production";

    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      timeoutMs: config.timeoutMs ?? 10_000,
      retryLimit: config.retryLimit ?? 2,
      debug: config.debug ?? false,
      serviceName: config.serviceName ?? "got-api-engine",
      defaultAuth: config.defaultAuth ?? true,
      rejectUnauthorized: config.rejectUnauthorized ?? !isDev,
      auth: config.auth,
      defaultHeaders: config.defaultHeaders,
      hooks: config.hooks,
      logger: config.logger,
    };

    this.redact = buildRedactor(config.redactKeys ?? []);
    this.log = config.logger ?? createConsoleLogger(this.config.serviceName, this.config.debug);

    // ── Retry layer (engine-managed backoff over got) ────────────
    this.retryCfg = resolveRetry(
      config.retry ?? { limit: config.retryLimit ?? 2 },
    );

    // ── Circuit breaker ──────────────────────────────────────────
    this.circuit =
      config.circuitBreaker?.enabled
        ? new CircuitBreaker(config.circuitBreaker, (ctx) => {
            void this.runHooks(this.config.hooks?.onCircuitStateChange, (h) =>
              h({ ...ctx, serviceName: this.config.serviceName }),
            );
            this.log.warn(`Circuit ${ctx.from} → ${ctx.to}`);
          })
        : null;

    // ── Response cache ───────────────────────────────────────────
    if (config.cache?.enabled) {
      this.cacheCfg = {
        enabled: true,
        ttlMs: config.cache.ttlMs ?? 30_000,
        maxEntries: config.cache.maxEntries ?? 500,
        staleWhileRevalidate: config.cache.staleWhileRevalidate ?? false,
        methods: config.cache.methods ?? SAFE_METHODS,
        conditional: config.cache.conditional ?? true,
      };
      this.cacheStore = config.cache.store ?? new MemoryCacheStore(this.cacheCfg.maxEntries);
    } else {
      this.cacheCfg = null;
      this.cacheStore = null;
    }

    // ── Rate limiter ─────────────────────────────────────────────
    this.bucket = config.rateLimit?.enabled ? new TokenBucket(config.rateLimit) : null;

    // ── Metrics ──────────────────────────────────────────────────
    this.metricsCollector = (config.metrics ?? true) ? new MetricsCollector() : null;

    // ── Dedupe + idempotency ─────────────────────────────────────
    this.dedupeEnabled = config.dedupe ?? true;
    this.idempotencyEnabled = config.idempotency ?? false;

    // ── SSRF ─────────────────────────────────────────────────────
    this.ssrf = resolveSsrfConfig(config.ssrfProtection);

    // ── HTTP client (keep-alive agents for connection reuse) ─────
    const redirectGuard = this.ssrf
      ? buildRedirectGuard(this.ssrf, this.config.baseUrl)
      : undefined;

    this.httpClient = got.extend({
      agent: {
        https: new https.Agent({
          keepAlive: true,
          keepAliveMsecs: 1000,
          maxSockets: 128,
          maxFreeSockets: 32,
          rejectUnauthorized: this.config.rejectUnauthorized,
        }),
        http: new http.Agent({
          keepAlive: true,
          keepAliveMsecs: 1000,
          maxSockets: 128,
          maxFreeSockets: 32,
        }),
      },
      headers: {
        "Cache-Control": "no-store",
        ...this.config.defaultHeaders,
      },
      responseType: "json",
      // got's built-in retry is disabled; the engine manages retries so it
      // can coordinate with the circuit breaker, metrics and Retry-After.
      retry: { limit: 0 },
      timeout: { request: this.config.timeoutMs },
      throwHttpErrors: false,
      followRedirect: true,
      maxRedirects: 5,
      ...(redirectGuard
        ? { hooks: { beforeRedirect: [redirectGuard as never] } }
        : {}),
    });
  }

  // ── Run a group of lifecycle hooks (handles single fn or array) ──
  protected async runHooks<T>(
    hooks: T | T[] | undefined,
    invoke: (hook: T) => void | Promise<void>,
  ): Promise<void> {
    if (!hooks) return;
    const list = Array.isArray(hooks) ? hooks : [hooks];
    for (const hook of list) {
      try {
        await invoke(hook);
      } catch (err) {
        this.log.warn("Hook threw", { err: String(err) });
      }
    }
  }

  // ── Public: make a request ────────────────────────────────────
  async request<TResponse = unknown, TBody = unknown>(
    options: RequestOptions<TBody, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    const method: HttpMethod = options.method ?? "GET";
    const requestId = generateRequestId();
    const elapsed = startTimer();
    this.metricsCollector?.recordRequest();

    const log = this.log.child ? this.log.child({ requestId }) : this.log;

    // ── Rate limit gate ──────────────────────────────────────────
    if (this.bucket) {
      try {
        await this.bucket.acquire();
      } catch (err) {
        if (err instanceof RateLimitError) {
          this.metricsCollector?.recordRateLimited();
          log.warn("Rate limited locally");
          return this.fail("Too many requests (client-side rate limit).", 429, {
            code: "RATE_LIMITED",
            meta: { requestId, durationMs: elapsed() },
          });
        }
        throw err;
      }
    }

    // ── Circuit breaker gate ─────────────────────────────────────
    if (this.circuit && !this.circuit.canRequest()) {
      this.metricsCollector?.recordCircuitRejected();
      const retryAfter = Math.ceil(this.circuit.retryAfterMs() / 1000);
      log.warn("Circuit open — request short-circuited");
      return this.fail("Service temporarily unavailable (circuit open).", 503, {
        code: "CIRCUIT_OPEN",
        details: { retryAfterSeconds: retryAfter },
        meta: { requestId, durationMs: elapsed() },
      });
    }

    // ── Dedupe gate (safe methods only) ──────────────────────────
    const canDedupe =
      this.dedupeEnabled &&
      (options.dedupe ?? true) &&
      SAFE_METHODS.includes(method) &&
      options.body === undefined;

    let dedupeKey: string | null = null;
    if (canDedupe) {
      dedupeKey = await this.computeKey(method, options);
      const existing = this.inflight.get(dedupeKey);
      if (existing) {
        this.metricsCollector?.recordDedupeHit();
        log.debug("Joined in-flight request (dedupe)");
        const shared = (await existing) as ApiResult<TResponse>;
        return this.withMeta(shared, { deduped: true, requestId });
      }
    }

    const exec = this.executeWithPipeline<TResponse, TBody>(options, method, requestId, log, elapsed);

    if (dedupeKey) {
      const tracked = exec.finally(() => {
        if (dedupeKey) this.inflight.delete(dedupeKey);
      });
      this.inflight.set(dedupeKey, tracked as Promise<ApiResult<unknown>>);
      return tracked;
    }

    return exec;
  }

  // ── Cache + execute pipeline ─────────────────────────────────
  private async executeWithPipeline<TResponse, TBody>(
    options: RequestOptions<TBody, TResponse>,
    method: HttpMethod,
    requestId: string,
    log: LoggerInterface,
    elapsed: () => number,
  ): Promise<ApiResult<TResponse>> {
    // ── Resolve cache settings for this request ──────────────────
    const cacheEligible =
      this.cacheCfg !== null &&
      options.cache !== false &&
      this.cacheCfg.methods.includes(method);

    let cacheKey: string | null = null;
    let cached: CachedResponse | undefined;

    if (cacheEligible && this.cacheStore) {
      cacheKey = await this.computeKey(method, options);
      cached = (await this.cacheStore.get(cacheKey)) ?? undefined;

      if (cached && Date.now() < cached.expiresAt) {
        this.metricsCollector?.recordCacheHit();
        log.debug("Cache hit");
        return this.cachedResult<TResponse>(cached, { requestId, durationMs: elapsed() });
      }

      const swr =
        typeof options.cache === "object" && options.cache?.staleWhileRevalidate !== undefined
          ? options.cache.staleWhileRevalidate
          : this.cacheCfg.staleWhileRevalidate;

      if (cached && swr) {
        // Serve stale immediately, revalidate in background.
        this.metricsCollector?.recordCacheHit();
        log.debug("Cache stale — serving stale, revalidating");
        void this.runRequest<TResponse, TBody>(options, method, log, cached, cacheKey).catch(
          (err) => log.warn("Background revalidation failed", { err: String(err) }),
        );
        return this.cachedResult<TResponse>(cached, {
          requestId,
          durationMs: elapsed(),
          stale: true,
        });
      }

      this.metricsCollector?.recordCacheMiss();
    }

    const result = await this.runRequest<TResponse, TBody>(
      options,
      method,
      log,
      cached,
      cacheKey,
    );
    return this.withMeta(result, { requestId, durationMs: elapsed() });
  }

  // ── Execute with retry/backoff, validation, circuit accounting ─
  private async runRequest<TResponse, TBody>(
    options: RequestOptions<TBody, TResponse>,
    method: HttpMethod,
    log: LoggerInterface,
    cached: CachedResponse | undefined,
    cacheKey: string | null,
  ): Promise<ApiResult<TResponse>> {
    const {
      endpoint,
      body: customBody,
      schema,
      responseSchema,
      timeoutMs,
      headers: extraHeaders,
      params,
      authToken: overrideToken,
      signal,
    } = options;

    const authMode: AuthMode = options.auth ?? this.config.defaultAuth;

    const retry: ResolvedRetry =
      options.retry === false
        ? { ...this.retryCfg, limit: 0 }
        : options.retry
          ? resolveRetry(options.retry)
          : this.retryCfg;

    try {
      // ── Headers ────────────────────────────────────────────────
      const headers: Record<string, string> = mergeHeaders(
        { "Cache-Control": "no-store" },
        this.config.defaultHeaders,
        extraHeaders,
      );

      // ── Auth ───────────────────────────────────────────────────
      if (!isAuthDisabled(authMode)) {
        const authHeader = await resolveAuthHeader({ auth: this.config.auth }, overrideToken);
        if (isAuthRequired(authMode) && !authHeader) {
          log.warn("Auth required but no token available");
          return this.fail("Authorization token is required.", 401, { code: "AUTH_REQUIRED" });
        }
        if (authHeader && (isAuthRequired(authMode) || isAuthOptional(authMode))) {
          headers["Authorization"] = authHeader;
        }
      }

      // ── Conditional revalidation headers ───────────────────────
      if (cached && this.cacheCfg?.conditional) {
        if (cached.etag) headers["If-None-Match"] = cached.etag;
        if (cached.lastModified) headers["If-Modified-Since"] = cached.lastModified;
      }

      // ── Idempotency key for mutating requests ──────────────────
      if (
        (this.idempotencyEnabled || options.idempotencyKey) &&
        BODY_METHODS.includes(method) &&
        !headers["Idempotency-Key"]
      ) {
        headers["Idempotency-Key"] = options.idempotencyKey ?? generateIdempotencyKey();
      }

      // ── URL + params ───────────────────────────────────────────
      let fullUrl = buildUrl(endpoint, this.config.baseUrl);
      if (params) fullUrl = appendParams(fullUrl, params);

      // ── SSRF guard ─────────────────────────────────────────────
      if (this.ssrf) assertUrlAllowed(fullUrl, this.ssrf);

      // ── Body ───────────────────────────────────────────────────
      const requestOpts: OptionsInit = {
        headers,
        method,
        retry: { limit: 0 },
        timeout: { request: timeoutMs ?? this.config.timeoutMs },
        throwHttpErrors: false,
        responseType: "json",
        ...(signal ? { signal } : {}),
      };

      if (customBody !== undefined && BODY_METHODS.includes(method)) {
        if (customBody instanceof FormData) {
          requestOpts.body = customBody;
        } else if (schema) {
          const parsed = schema.safeParse(customBody);
          if (!parsed.success) {
            log.warn("Request body validation failed", {
              errors: this.redact(parsed.error.flatten()) as Record<string, unknown>,
            });
            return this.fail("Validation error.", 400, {
              code: "REQUEST_VALIDATION",
              details: parsed.error.flatten(),
            });
          }
          requestOpts.json = parsed.data;
          headers["Content-Type"] = "application/json";
        } else if (typeof customBody === "object") {
          requestOpts.json = customBody;
          headers["Content-Type"] = "application/json";
        } else {
          requestOpts.body = String(customBody);
        }
      }

      // ── onRequest hooks ────────────────────────────────────────
      await this.runHooks(this.config.hooks?.onRequest, (hook) =>
        hook({ url: fullUrl, method, headers, body: customBody }),
      );

      // ── Retry loop ─────────────────────────────────────────────
      let attempt = 0;
      let lastResult: ApiResult<TResponse> | null = null;

      while (attempt <= retry.limit) {
        const tryTimer = startTimer();
        try {
          const response = await this.httpClient(fullUrl, requestOpts);
          const status = response.statusCode;
          const durationMs = tryTimer();
          this.metricsCollector?.recordLatency(durationMs);
          this.metricsCollector?.recordStatus(status);

          // 304 → cached content still fresh; refresh its TTL and serve it.
          if (status === 304 && cached) {
            this.refreshCacheTtl(cacheKey, cached, options);
            await this.runHooks(this.config.hooks?.onResponse, (h) =>
              h({ url: fullUrl, method, status, body: cached!.body, durationMs }),
            );
            this.circuit?.recordSuccess();
            return this.cachedResult<TResponse>(cached, { attempts: attempt + 1 });
          }

          await this.runHooks(this.config.hooks?.onResponse, (hook) =>
            hook({ url: fullUrl, method, status, body: response.body, durationMs }),
          );

          // Retryable status?
          if (status >= 400 && retry.methods.has(method) && retry.retryStatusCodes.has(status) && attempt < retry.limit) {
            const ra = retry.respectRetryAfter
              ? parseRetryAfter(response.headers["retry-after"] as string | undefined)
              : null;
            const delay = ra ?? backoffDelay(attempt, retry);
            this.metricsCollector?.recordRetry();
            await this.runHooks(this.config.hooks?.onRetry, (h) =>
              h({ url: fullUrl, method, attempt: attempt + 1, delayMs: delay, reason: `status ${status}` }),
            );
            log.debug(`Retrying after ${delay}ms (status ${status})`, { attempt: attempt + 1 });
            if (this.circuit?.isFailureStatus(status)) this.circuit.recordFailure();
            await sleep(delay, signal);
            attempt++;
            continue;
          }

          if (status >= 400) {
            const errorMessage = parseApiError(response.body);
            if (this.circuit?.isFailureStatus(status)) this.circuit.recordFailure();
            else if (this.circuit && status < 500) this.circuit.recordSuccess();
            this.metricsCollector?.recordError();
            log.error("Request failed", { url: fullUrl, status, durationMs });
            return this.fail(errorMessage, status, {
              code: "HTTP_ERROR",
              meta: { attempts: attempt + 1 },
            });
          }

          // ── Success ──────────────────────────────────────────
          this.circuit?.recordSuccess();
          this.metricsCollector?.recordSuccess();

          let data = response.body as TResponse;
          if (responseSchema) {
            const parsed = responseSchema.safeParse(response.body);
            if (!parsed.success) {
              log.warn("Response validation failed", {
                errors: this.redact(parsed.error.flatten()) as Record<string, unknown>,
              });
              return this.fail("Response validation error.", 502, {
                code: "RESPONSE_VALIDATION",
                details: parsed.error.flatten(),
              });
            }
            data = parsed.data;
          }

          const flatHeaders = flattenHeaders(response.headers);

          // ── Store in cache ─────────────────────────────────────
          if (cacheKey && this.cacheStore && this.cacheCfg) {
            await this.storeInCache(cacheKey, status, data, flatHeaders, options);
          }

          log.info(`✓ ${method} ${endpoint} → ${status} (${durationMs}ms)`);
          return {
            ok: true,
            data,
            status,
            headers: flatHeaders,
            meta: { attempts: attempt + 1 },
          };
        } catch (err) {
          // Network-level error → retry if attempts remain.
          if (this.isAbort(err)) throw err;
          if (attempt < retry.limit && retry.methods.has(method)) {
            const delay = backoffDelay(attempt, retry);
            this.metricsCollector?.recordRetry();
            await this.runHooks(this.config.hooks?.onRetry, (h) =>
              h({ url: fullUrl, method, attempt: attempt + 1, delayMs: delay, reason: "network error" }),
            );
            log.debug(`Retrying after ${delay}ms (network error)`, { attempt: attempt + 1 });
            this.circuit?.recordFailure();
            await sleep(delay, signal);
            attempt++;
            continue;
          }
          throw err;
        }
      }

      return lastResult ?? this.fail("Request failed after retries.", 500, { code: "RETRY_EXHAUSTED" });
    } catch (error: unknown) {
      return this.handleError<TResponse>(error, endpoint, method, log);
    }
  }

  // ── Centralised error handling ───────────────────────────────
  private async handleError<TResponse>(
    error: unknown,
    endpoint: string,
    method: HttpMethod,
    log: LoggerInterface,
  ): Promise<ApiResult<TResponse>> {
    await this.runHooks(this.config.hooks?.onError, (hook) =>
      hook({ url: endpoint, method, error, durationMs: 0 }),
    );

    if (error instanceof SsrfError) {
      log.error(`SSRF blocked: ${error.message}`);
      return this.fail(error.message, 403, { code: "SSRF_BLOCKED" });
    }

    if (this.isAbort(error)) {
      log.warn("Request aborted by client");
      return this.fail("Request aborted.", 499, { code: "ABORTED" });
    }

    // Network failures count against the circuit.
    this.circuit?.recordFailure();
    this.metricsCollector?.recordError();

    const code = error instanceof Error ? (error as NodeError).code : undefined;
    const isTimeout = code === "ETIMEDOUT" || (error as Error)?.name === "TimeoutError";
    const message = error instanceof Error ? error.message : "An internal error occurred.";

    log.error(`Proxy error: ${message}`, {
      err: error instanceof Error ? { name: error.name, message: error.message, code } : undefined,
    });

    return this.fail(message, isTimeout ? 504 : 500, {
      code: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
    });
  }

  private isAbort(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.name === "AbortError" || (error as NodeError).code === "ABORT_ERR")
    );
  }

  // ── Cache helpers ────────────────────────────────────────────
  private async computeKey<TBody, TResponse>(
    method: HttpMethod,
    options: RequestOptions<TBody, TResponse>,
  ): Promise<string> {
    let url = buildUrl(options.endpoint, this.config.baseUrl);
    if (options.params) url = appendParams(url, options.params);
    let authHeader: string | null = null;
    if (!isAuthDisabled(options.auth ?? this.config.defaultAuth)) {
      authHeader = await resolveAuthHeader({ auth: this.config.auth }, options.authToken).catch(
        () => null,
      );
    }
    return buildCacheKey(method, url, authHeader);
  }

  private resolveTtl<TBody, TResponse>(options: RequestOptions<TBody, TResponse>): number {
    if (typeof options.cache === "number") return options.cache;
    if (typeof options.cache === "object" && options.cache?.ttlMs !== undefined) {
      return options.cache.ttlMs;
    }
    return this.cacheCfg?.ttlMs ?? 30_000;
  }

  private async storeInCache<TBody, TResponse>(
    key: string,
    status: number,
    body: unknown,
    headers: Record<string, string>,
    options: RequestOptions<TBody, TResponse>,
  ): Promise<void> {
    if (!this.cacheStore) return;
    // Respect upstream no-store directives.
    const cc = headers["cache-control"] ?? "";
    if (/no-store|private/i.test(cc)) return;

    const ttl = this.resolveTtl(options);
    const entry: CachedResponse = {
      status,
      body,
      headers,
      storedAt: Date.now(),
      expiresAt: Date.now() + ttl,
      etag: headers["etag"],
      lastModified: headers["last-modified"],
    };
    await this.cacheStore.set(key, entry, ttl);
  }

  private refreshCacheTtl<TBody, TResponse>(
    key: string | null,
    cached: CachedResponse,
    options: RequestOptions<TBody, TResponse>,
  ): void {
    if (!key || !this.cacheStore) return;
    const ttl = this.resolveTtl(options);
    void this.cacheStore.set(
      key,
      { ...cached, storedAt: Date.now(), expiresAt: Date.now() + ttl },
      ttl,
    );
  }

  private cachedResult<TResponse>(
    cached: CachedResponse,
    extraMeta?: ResultMeta,
  ): ApiResult<TResponse> {
    return {
      ok: true,
      data: cached.body as TResponse,
      status: cached.status,
      headers: cached.headers,
      meta: { cached: true, ...extraMeta },
    };
  }

  private withMeta<T>(result: ApiResult<T>, meta: ResultMeta): ApiResult<T> {
    return { ...result, meta: { ...result.meta, ...meta } };
  }

  private fail(
    error: string,
    status: number,
    extra?: { code?: string; details?: unknown; meta?: ResultMeta },
  ): ApiResult<never> {
    return {
      ok: false,
      error,
      status,
      ...(extra?.code ? { code: extra.code } : {}),
      ...(extra?.details !== undefined ? { details: extra.details } : {}),
      ...(extra?.meta ? { meta: extra.meta } : {}),
    };
  }

  // ── Public observability / control surface ───────────────────

  /** Snapshot of runtime metrics (null if metrics disabled). */
  getMetrics(): MetricsSnapshot | null {
    if (!this.metricsCollector) return null;
    return this.metricsCollector.snapshot(this.circuit?.getState() ?? "closed");
  }

  resetMetrics(): void {
    this.metricsCollector?.reset();
  }

  getCircuitState(): CircuitState {
    return this.circuit?.getState() ?? "closed";
  }

  resetCircuit(): void {
    this.circuit?.reset();
  }

  async clearCache(): Promise<void> {
    await this.cacheStore?.clear();
  }

  async invalidateCache<TBody = unknown, TResponse = unknown>(
    method: HttpMethod,
    endpoint: string,
    options?: Pick<RequestOptions<TBody, TResponse>, "params" | "auth" | "authToken">,
  ): Promise<void> {
    if (!this.cacheStore) return;
    const key = await this.computeKey(method, { endpoint, ...options } as RequestOptions<
      TBody,
      TResponse
    >);
    await this.cacheStore.delete(key);
  }

  // ── Convenience wrappers ─────────────────────────────────────

  get<TResponse = unknown>(
    endpoint: string,
    options?: Omit<RequestOptions<never, TResponse>, "endpoint" | "method" | "body">,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, never>({ ...options, endpoint, method: "GET" });
  }

  post<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method" | "body">,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, TBody>({ ...options, endpoint, method: "POST", body });
  }

  put<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method" | "body">,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, TBody>({ ...options, endpoint, method: "PUT", body });
  }

  patch<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method" | "body">,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, TBody>({ ...options, endpoint, method: "PATCH", body });
  }

  delete<TResponse = unknown>(
    endpoint: string,
    options?: Omit<RequestOptions<never, TResponse>, "endpoint" | "method" | "body">,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, never>({ ...options, endpoint, method: "DELETE" });
  }

  // ── Fork: create a child engine with overridden config ────────
  extend(overrides: Partial<EngineConfig>): GotApiEngine {
    return new GotApiEngine(this.mergeConfig(overrides));
  }

  protected mergeConfig(overrides: Partial<EngineConfig>): EngineConfig {
    return {
      baseUrl: overrides.baseUrl ?? this.config.baseUrl,
      timeoutMs: overrides.timeoutMs ?? this.config.timeoutMs,
      retryLimit: overrides.retryLimit ?? this.config.retryLimit,
      debug: overrides.debug ?? this.config.debug,
      serviceName: overrides.serviceName ?? this.config.serviceName,
      defaultAuth: overrides.defaultAuth ?? this.config.defaultAuth,
      rejectUnauthorized: overrides.rejectUnauthorized ?? this.config.rejectUnauthorized,
      auth: overrides.auth ?? this.config.auth,
      defaultHeaders: mergeHeaders(this.config.defaultHeaders, overrides.defaultHeaders),
      hooks: overrides.hooks ?? this.config.hooks,
      logger: overrides.logger ?? this.config.logger,
      ...(overrides.cache ? { cache: overrides.cache } : {}),
      ...(overrides.circuitBreaker ? { circuitBreaker: overrides.circuitBreaker } : {}),
      ...(overrides.rateLimit ? { rateLimit: overrides.rateLimit } : {}),
      ...(overrides.retry ? { retry: overrides.retry } : {}),
      ...(overrides.dedupe !== undefined ? { dedupe: overrides.dedupe } : {}),
      ...(overrides.ssrfProtection !== undefined ? { ssrfProtection: overrides.ssrfProtection } : {}),
      ...(overrides.metrics !== undefined ? { metrics: overrides.metrics } : {}),
      ...(overrides.idempotency !== undefined ? { idempotency: overrides.idempotency } : {}),
      ...(overrides.redactKeys ? { redactKeys: overrides.redactKeys } : {}),
    };
  }
}

type NodeError = Error & { code?: string };

// ── Factory function ─────────────────────────────────────────────
export function createEngine(config: EngineConfig): GotApiEngine {
  return new GotApiEngine(config);
}
