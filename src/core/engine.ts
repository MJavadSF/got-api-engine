// =================================================================
// got-api-engine — Core Engine (v3)
//
// Request pipeline (outermost → innermost):
//   prepare (url, auth, body validation)
//     → in-flight dedupe → response cache (fresh / stale-while-revalidate)
//       → network attempt loop: circuit-breaker → rate-limit → got
//         → retry with backoff / 401 refresh → decode → validate
//           → cache store + mutation invalidation → metrics
//
// Cache hits and deduplicated followers never consume rate-limit tokens or
// circuit-breaker capacity: those gates guard real upstream attempts only.
// =================================================================

import got, { type Got, type OptionsInit, type OptionsOfBufferResponseBody } from "got";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

import type {
  ApiResult,
  AuthMode,
  CacheConfig,
  CacheStore,
  CachedResponse,
  CircuitState,
  EngineConfig,
  ErrorResult,
  HttpMethod,
  LoggerInterface,
  MetricsSnapshot,
  RequestOptions,
  ResponseType,
  ResultMeta,
  SuccessResult,
  ZodLike,
} from "../types";

import {
  appendParams,
  authFingerprint,
  buildCacheKey,
  buildUrl,
  cloneBody,
  decodeBody,
  deleteHeader,
  flattenHeaders,
  generateIdempotencyKey,
  generateRequestId,
  getHeader,
  hasHeader,
  isAuthDisabled,
  isAuthOptional,
  isAuthRequired,
  mergeHeaders,
  normalizeAuthorization,
  parseApiError,
  parseCacheControl,
  resolveAuthHeaders,
  sanitizeRequestId,
  schemaErrorDetails,
  setHeader,
  setHeaderIfAbsent,
  startTimer,
  stripQuery,
  toBuffer,
  variantFingerprint,
  type HeaderMap,
} from "../utils/helpers";

import { createConsoleLogger } from "../utils/logger";
import { CircuitBreaker } from "./circuit-breaker";
import { MemoryCacheStore } from "./cache-store";
import { TokenBucket, RateLimitError } from "./rate-limiter";
import { MetricsCollector } from "./metrics";
import {
  resolveRetry,
  backoffDelay,
  isRetryableMethod,
  parseRetryAfter,
  sleep,
  type ResolvedRetry,
} from "./backoff";
import {
  resolveSsrfConfig,
  assertUrlAllowed,
  buildGuardedLookup,
  buildRedirectGuard,
  buildRedactor,
  findSsrfError,
  isCredentialTarget,
  redactUrl,
  withRedaction,
  SsrfError,
} from "./security";

const BODY_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(["POST", "PUT", "PATCH", "DELETE", "QUERY"]);
const IDEMPOTENCY_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(["POST", "PUT", "PATCH"]);
const MUTATION_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_METHODS: HttpMethod[] = ["GET", "HEAD"];
const CACHEABLE_STATUS: ReadonlySet<number> = new Set([200, 203, 204]);

type NodeError = Error & { code?: string };
type ResolvedCache = Required<Omit<CacheConfig, "store" | "enabled">>;

/** Per-request state shared by the pipeline stages. */
interface RequestContext {
  options: RequestOptions<unknown, unknown>;
  method: HttpMethod;
  requestId: string;
  log: LoggerInterface;
  elapsed: () => number;
  fullUrl: string;
  headers: HeaderMap;
  credHeaders: HeaderMap;
  /** Credentials came from the engine's `auth` config (so a 401 may trigger refreshAuth). */
  usedConfigAuth: boolean;
  bodyOpts: { json?: unknown; body?: unknown };
  /** False for streamed bodies: cannot be re-sent, so no retries / replays. */
  replayable: boolean;
  responseType: ResponseType;
  retry: ResolvedRetry;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  deadline: AbortSignal | undefined;
  authFp: string;
  variantFp: string;
  authRefreshed: boolean;
}

type Prepared = { ok: true; ctx: RequestContext } | { ok: false; result: ErrorResult };

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
      | "responseType"
    >
  > &
    Pick<
      EngineConfig,
      "auth" | "defaultHeaders" | "hooks" | "logger" | "totalTimeoutMs" | "requestIdHeader" | "credentialHosts"
    >;

  /** The (normalised) configuration this engine was built from — used by `extend()`. */
  protected readonly rawConfig: EngineConfig;

  protected readonly httpClient: Got;
  protected readonly log: LoggerInterface;

  // ── Production subsystems ──────────────────────────────────────
  protected readonly circuit: CircuitBreaker | null;
  protected readonly cacheStore: CacheStore | null;
  protected readonly cacheCfg: ResolvedCache | null;
  protected readonly bucket: TokenBucket | null;
  protected readonly metricsCollector: MetricsCollector | null;
  protected readonly retryCfg: ResolvedRetry;
  protected readonly dedupeEnabled: boolean;
  protected readonly idempotencyEnabled: boolean;
  protected readonly ssrf: ReturnType<typeof resolveSsrfConfig>;
  protected readonly redact: (meta: unknown) => unknown;
  protected readonly redactKeys: string[];

  private readonly agents: { http: http.Agent; https: https.Agent | null };
  private readonly inflight = new Map<string, Promise<ApiResult<unknown>>>();
  private readonly revalidating = new Set<string>();
  private authRefreshInflight: Promise<void> | null = null;
  private tokenOverride: string | null = null;
  private disposed = false;

  constructor(config: EngineConfig) {
    if (typeof config?.baseUrl !== "string" || config.baseUrl.trim() === "") {
      throw new TypeError("got-api-engine: `baseUrl` is required.");
    }
    let base: URL;
    try {
      base = new URL(config.baseUrl);
    } catch {
      throw new TypeError(`got-api-engine: invalid baseUrl "${config.baseUrl}".`);
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new TypeError("got-api-engine: baseUrl must use http: or https:.");
    }

    const serviceName = config.serviceName ?? process.env.LOG_NAME ?? "got-api-engine";

    this.rawConfig = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, "") };
    this.config = {
      baseUrl: this.rawConfig.baseUrl,
      timeoutMs: config.timeoutMs ?? 10_000,
      retryLimit: config.retryLimit ?? 2,
      debug: config.debug ?? false,
      serviceName,
      defaultAuth: config.defaultAuth ?? true,
      // Secure by default in EVERY environment. Opt out explicitly for local dev.
      rejectUnauthorized: config.rejectUnauthorized ?? true,
      responseType: config.responseType ?? "auto",
      auth: config.auth,
      defaultHeaders: config.defaultHeaders,
      hooks: config.hooks,
      logger: config.logger,
      totalTimeoutMs: config.totalTimeoutMs,
      requestIdHeader: config.requestIdHeader,
      credentialHosts: config.credentialHosts,
    };

    this.redactKeys = config.redactKeys ?? [];
    this.redact = buildRedactor(this.redactKeys);
    this.log = withRedaction(
      config.logger ?? createConsoleLogger(serviceName, this.config.debug, config.logLevel),
      this.redact,
    );

    if (!this.config.rejectUnauthorized) {
      this.log.warn("TLS certificate verification is DISABLED (rejectUnauthorized: false).");
    }

    // ── Retry layer (engine-managed backoff over got) ────────────
    this.retryCfg = resolveRetry({
      limit: this.config.retryLimit,
      ...(config.retry ?? {}),
      ...(config.retry?.limit === undefined ? { limit: this.config.retryLimit } : {}),
    });

    // ── Circuit breaker ──────────────────────────────────────────
    this.circuit = config.circuitBreaker?.enabled
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
        ttlMs: config.cache.ttlMs ?? 30_000,
        maxEntries: config.cache.maxEntries ?? 500,
        staleWhileRevalidate: config.cache.staleWhileRevalidate ?? false,
        staleIfError: config.cache.staleIfError ?? false,
        staleTtlMs: config.cache.staleTtlMs ?? 300_000,
        methods: config.cache.methods ?? SAFE_METHODS,
        conditional: config.cache.conditional ?? true,
        respectCacheControl: config.cache.respectCacheControl ?? false,
        invalidateOnMutation: config.cache.invalidateOnMutation ?? true,
        cloneOnRead: config.cache.cloneOnRead ?? true,
      };
      this.cacheStore = config.cache.store ?? new MemoryCacheStore(this.cacheCfg.maxEntries);
    } else {
      this.cacheCfg = null;
      this.cacheStore = null;
    }

    this.bucket = config.rateLimit?.enabled ? new TokenBucket(config.rateLimit) : null;
    this.metricsCollector = (config.metrics ?? true) ? new MetricsCollector() : null;
    this.dedupeEnabled = config.dedupe ?? true;
    this.idempotencyEnabled = config.idempotency ?? false;
    this.ssrf = resolveSsrfConfig(config.ssrfProtection);

    // ── HTTP client ──────────────────────────────────────────────
    // With `http2: true` we leave the https agent to got's built-in HTTP/2
    // session pool (a custom https agent forces the HTTP/1.1 path in got 16).
    const keepAlive = { keepAlive: true, keepAliveMsecs: 1000, maxSockets: 128, maxFreeSockets: 32 };
    this.agents = {
      http: new http.Agent(keepAlive),
      https: config.http2
        ? null
        : new https.Agent({ ...keepAlive, rejectUnauthorized: this.config.rejectUnauthorized }),
    };

    const gotOptions: OptionsInit = {
      agent: this.agents.https
        ? { http: this.agents.http, https: this.agents.https }
        : { http: this.agents.http },
      https: { rejectUnauthorized: this.config.rejectUnauthorized },
      headers: { "Cache-Control": "no-store", ...this.config.defaultHeaders },
      // Bodies are decoded by the engine (json / text / buffer / auto).
      responseType: "buffer",
      // got's built-in retry is disabled; the engine manages retries so it can
      // coordinate with the circuit breaker, metrics and Retry-After.
      retry: { limit: 0 },
      timeout: { request: this.config.timeoutMs },
      throwHttpErrors: false,
      followRedirect: true,
      maxRedirects: 5,
      ...(config.http2 ? { http2: true } : {}),
      ...(config.dnsCache ? { dnsCache: true } : {}),
    };

    if (this.ssrf) {
      gotOptions.hooks = { beforeRedirect: [buildRedirectGuard(this.ssrf)] };
      if (this.ssrf.checkResolvedAddresses) {
        gotOptions.dnsLookup = buildGuardedLookup(this.ssrf) as unknown as NonNullable<OptionsInit["dnsLookup"]>;
      }
    }
    this.httpClient = got.extend(gotOptions);
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

  // =================================================================
  // PUBLIC: request
  // =================================================================
  async request<TResponse = unknown, TBody = unknown>(
    options: RequestOptions<TBody, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    const opts = options as RequestOptions<unknown, unknown>;
    const method: HttpMethod = opts.method ?? "GET";
    const requestId = sanitizeRequestId(opts.requestId) ?? generateRequestId();
    const elapsed = startTimer();
    const log = this.log.child ? this.log.child({ requestId }) : this.log;

    this.metricsCollector?.recordRequest();

    if (this.disposed) {
      return this.fail("Engine has been disposed.", 503, { code: "ENGINE_DISPOSED", meta: { requestId } }) as ApiResult<TResponse>;
    }

    const prepared = await this.prepare(opts, method, requestId, log, elapsed);
    if (!prepared.ok) return prepared.result as ApiResult<TResponse>;
    const ctx = prepared.ctx;

    // ── Dedupe (safe, body-less requests) ────────────────────────
    const canDedupe =
      this.dedupeEnabled &&
      opts.dedupe !== false &&
      SAFE_METHODS.includes(method) &&
      opts.body === undefined &&
      ctx.replayable;

    if (!canDedupe) {
      return (await this.execute(ctx)) as ApiResult<TResponse>;
    }

    const key = `${buildCacheKey(method, ctx.fullUrl, ctx.authFp, ctx.variantFp)}`;
    const existing = this.inflight.get(key);
    if (existing) {
      this.metricsCollector?.recordDedupeHit();
      log.debug("Joined in-flight request (dedupe)");
      let shared: ApiResult<unknown>;
      try {
        shared = await this.raceAbort(existing, opts.signal);
      } catch {
        return this.fail("Request aborted.", 499, {
          code: "ABORTED",
          meta: { requestId, durationMs: elapsed() },
        }) as ApiResult<TResponse>;
      }
      return this.forFollower(shared, requestId, elapsed()) as ApiResult<TResponse>;
    }

    // A request carrying its own AbortSignal must not become the leader:
    // cancelling it would fail every follower.
    if (opts.signal) return (await this.execute(ctx)) as ApiResult<TResponse>;

    const exec = this.execute(ctx);
    this.inflight.set(key, exec);
    void exec.finally(() => {
      if (this.inflight.get(key) === exec) this.inflight.delete(key);
    });
    return (await exec) as ApiResult<TResponse>;
  }

  private raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return p;
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  private forFollower(shared: ApiResult<unknown>, requestId: string, durationMs: number): ApiResult<unknown> {
    const meta: ResultMeta = { ...shared.meta, deduped: true, requestId, durationMs };
    return shared.ok
      ? { ...shared, data: cloneBody(shared.data), meta }
      : { ...shared, meta };
  }

  // =================================================================
  // PREPARE: url, credentials, headers, body
  // =================================================================
  private async prepare(
    options: RequestOptions<unknown, unknown>,
    method: HttpMethod,
    requestId: string,
    log: LoggerInterface,
    elapsed: () => number,
  ): Promise<Prepared> {
    const fail = (message: string, status: number, extra: Parameters<GotApiEngine["fail"]>[2]): Prepared => ({
      ok: false,
      result: this.fail(message, status, { ...extra, meta: { requestId, durationMs: elapsed(), ...extra?.meta } }),
    });

    // ── URL ────────────────────────────────────────────────────
    let fullUrl = buildUrl(options.endpoint, this.config.baseUrl);
    if (options.params) fullUrl = appendParams(fullUrl, options.params);
    try {
      const u = new URL(fullUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new TypeError("bad protocol");
    } catch {
      return fail(`Invalid URL: ${redactUrl(fullUrl, this.redactKeys)}`, 400, { code: "INVALID_URL" });
    }

    // ── SSRF (static host/IP checks; DNS results are checked at connect time) ──
    if (this.ssrf) {
      try {
        assertUrlAllowed(fullUrl, this.ssrf);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Blocked by SSRF protection.";
        log.error(`SSRF blocked: ${msg}`);
        return fail(msg, 403, { code: "SSRF_BLOCKED" });
      }
    }

    // ── Credentials ────────────────────────────────────────────
    const authMode: AuthMode = options.auth ?? this.config.defaultAuth;
    let credHeaders: HeaderMap = {};
    let usedConfigAuth = false;

    if (!isAuthDisabled(authMode)) {
      if (options.authToken) {
        // Explicit per-request token: the caller chose to send it.
        credHeaders = { Authorization: normalizeAuthorization(options.authToken) };
      } else if (this.config.auth !== undefined || this.tokenOverride) {
        if (!isCredentialTarget(fullUrl, this.config.baseUrl, this.config.credentialHosts)) {
          if (isAuthRequired(authMode)) {
            const host = new URL(fullUrl).host;
            log.warn(`Refusing to send engine credentials to foreign host ${host}`);
            return fail(
              `Refusing to send credentials to ${host}. Pass \`auth: false\`, an explicit \`authToken\`, or add the host to \`credentialHosts\`.`,
              403,
              { code: "CREDENTIALS_BLOCKED" },
            );
          }
          // "optional": silently send no credentials to foreign origins.
        } else {
          try {
            credHeaders = await this.resolveCredentialHeaders();
            usedConfigAuth = Object.keys(credHeaders).length > 0;
          } catch (err) {
            log.error("Auth provider threw", { err: err instanceof Error ? err.message : String(err) });
            return fail("Failed to obtain credentials.", 500, { code: "AUTH_PROVIDER_ERROR" });
          }
        }
      }

      if (isAuthRequired(authMode) && Object.keys(credHeaders).length === 0) {
        log.warn("Auth required but no token available");
        return fail("Authorization token is required.", 401, { code: "AUTH_REQUIRED" });
      }
      if (isAuthOptional(authMode) && Object.keys(credHeaders).length === 0) {
        usedConfigAuth = false;
      }
    }

    // ── Headers ────────────────────────────────────────────────
    const responseType = options.responseType ?? this.config.responseType;
    const headers = mergeHeaders({ "Cache-Control": "no-store" }, this.config.defaultHeaders, options.headers);
    for (const [k, v] of Object.entries(credHeaders)) setHeader(headers, k, v);

    setHeaderIfAbsent(
      headers,
      "Accept",
      responseType === "buffer"
        ? "*/*"
        : responseType === "text"
          ? "text/plain, */*;q=0.8"
          : "application/json, text/plain;q=0.9, */*;q=0.8",
    );
    if (this.config.requestIdHeader) setHeaderIfAbsent(headers, this.config.requestIdHeader, requestId);

    if (
      (this.idempotencyEnabled || options.idempotencyKey) &&
      IDEMPOTENCY_METHODS.has(method) &&
      !hasHeader(headers, "Idempotency-Key")
    ) {
      headers["Idempotency-Key"] = options.idempotencyKey ?? generateIdempotencyKey();
    }

    // ── Body ───────────────────────────────────────────────────
    const built = await this.buildBody(options, method, headers, log);
    if (!built.ok) return { ok: false, result: { ...built.result, meta: { requestId, durationMs: elapsed() } } };

    // ── Retry policy (per-request options merge over engine config) ──
    let retry: ResolvedRetry;
    if (options.retry === false) retry = { ...this.retryCfg, limit: 0 };
    else if (options.retry) {
      retry = resolveRetry(
        {
          ...(options.retryLimit !== undefined ? { limit: options.retryLimit } : {}),
          ...options.retry,
        },
        this.retryCfg,
      );
    } else if (options.retryLimit !== undefined) retry = resolveRetry({ limit: options.retryLimit }, this.retryCfg);
    else retry = this.retryCfg;
    if (!built.replayable) retry = { ...retry, limit: 0 };

    // ── Cancellation: caller signal + overall deadline ─────────
    const totalMs = options.totalTimeoutMs ?? this.config.totalTimeoutMs;
    const deadline = totalMs && totalMs > 0 ? AbortSignal.timeout(totalMs) : undefined;
    const signals = [options.signal, deadline].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    return {
      ok: true,
      ctx: {
        options,
        method,
        requestId,
        log,
        elapsed,
        fullUrl,
        headers,
        credHeaders,
        usedConfigAuth,
        bodyOpts: built.bodyOpts,
        replayable: built.replayable,
        responseType,
        retry,
        timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
        signal,
        deadline,
        authFp: authFingerprint(credHeaders),
        variantFp: variantFingerprint(options.headers, responseType, this.config.responseType),
        authRefreshed: false,
      },
    };
  }

  /** Credentials from `tokenOverride` (set by refreshAuth) or the configured `auth`. */
  private async resolveCredentialHeaders(): Promise<HeaderMap> {
    if (this.tokenOverride) return { Authorization: this.tokenOverride };
    return resolveAuthHeaders({ auth: this.config.auth });
  }

  private async buildBody(
    options: RequestOptions<unknown, unknown>,
    method: HttpMethod,
    headers: HeaderMap,
    log: LoggerInterface,
  ): Promise<
    | { ok: true; bodyOpts: { json?: unknown; body?: unknown }; replayable: boolean }
    | { ok: false; result: ErrorResult }
  > {
    const raw = options.body;
    if (raw === undefined || raw === null || !BODY_METHODS.has(method)) {
      return { ok: true, bodyOpts: {}, replayable: true };
    }

    // FormData → multipart; got sets the boundary, so drop any stale Content-Type.
    if (typeof FormData !== "undefined" && raw instanceof FormData) {
      deleteHeader(headers, "content-type");
      return { ok: true, bodyOpts: { body: raw }, replayable: true };
    }

    // Raw payloads are sent untouched.
    if (typeof raw === "string") return { ok: true, bodyOpts: { body: raw }, replayable: true };
    if (raw instanceof Uint8Array) return { ok: true, bodyOpts: { body: raw }, replayable: true };
    if (raw instanceof ArrayBuffer) return { ok: true, bodyOpts: { body: Buffer.from(raw) }, replayable: true };
    if (raw instanceof URLSearchParams) {
      setHeaderIfAbsent(headers, "Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
      return { ok: true, bodyOpts: { body: raw.toString() }, replayable: true };
    }
    if (typeof Blob !== "undefined" && raw instanceof Blob) {
      if (raw.type) setHeaderIfAbsent(headers, "Content-Type", raw.type);
      return { ok: true, bodyOpts: { body: Buffer.from(await raw.arrayBuffer()) }, replayable: true };
    }
    if (raw instanceof Readable || (typeof raw === "object" && Symbol.asyncIterator in raw)) {
      return { ok: true, bodyOpts: { body: raw }, replayable: false };
    }
    if (typeof raw !== "object") {
      return { ok: true, bodyOpts: { body: String(raw) }, replayable: true };
    }

    // Plain object / array → validate (optional) then JSON.
    let payload: unknown = raw;
    if (options.schema) {
      let parsed: ReturnType<ZodLike<unknown>["safeParse"]>;
      try {
        parsed = options.schema.safeParse(raw);
      } catch (err) {
        parsed = { success: false, error: { issues: [{ message: err instanceof Error ? err.message : String(err) }] } };
      }
      if (!parsed.success) {
        const details = schemaErrorDetails(parsed.error);
        log.warn("Request body validation failed", { errors: this.redact(details) as Record<string, unknown> });
        return {
          ok: false,
          result: this.fail("Validation error.", 400, { code: "REQUEST_VALIDATION", details }),
        };
      }
      payload = parsed.data;
    }
    setHeaderIfAbsent(headers, "Content-Type", "application/json");
    return { ok: true, bodyOpts: { json: payload }, replayable: true };
  }

  // =================================================================
  // EXECUTE: cache layer
  // =================================================================
  private async execute(ctx: RequestContext): Promise<ApiResult<unknown>> {
    try {
      return await this.executeInner(ctx);
    } catch (err) {
      ctx.log.error("Unexpected engine error", { err: err instanceof Error ? err.message : String(err) });
      this.metricsCollector?.recordError();
      return this.fail(err instanceof Error ? err.message : "Internal engine error.", 500, {
        code: "INTERNAL_ERROR",
        meta: { requestId: ctx.requestId, durationMs: ctx.elapsed() },
      });
    }
  }

  private async executeInner(ctx: RequestContext): Promise<ApiResult<unknown>> {
    const cfg = this.cacheCfg;
    const store = this.cacheStore;
    const eligible = cfg !== null && store !== null && ctx.options.cache !== false && cfg.methods.includes(ctx.method);

    let cacheKey: string | null = null;
    let cached: CachedResponse | undefined;

    if (eligible && cfg && store) {
      cacheKey = buildCacheKey(ctx.method, ctx.fullUrl, ctx.authFp, ctx.variantFp);
      cached = await this.storeGet(cacheKey);

      // Entries older than the stale window are useless (even for revalidation).
      if (cached && Date.now() >= cached.expiresAt + cfg.staleTtlMs) cached = undefined;

      if (cached && Date.now() < cached.expiresAt) {
        const hit = this.fromCache(ctx, cached, {});
        if (hit) {
          this.metricsCollector?.recordCacheHit();
          ctx.log.debug("Cache hit");
          return hit;
        }
        cached = undefined; // cached body no longer satisfies responseSchema
      }

      const swr =
        typeof ctx.options.cache === "object" && ctx.options.cache.staleWhileRevalidate !== undefined
          ? ctx.options.cache.staleWhileRevalidate
          : cfg.staleWhileRevalidate;
      const mustRevalidate = cached !== undefined && cached.expiresAt <= cached.storedAt; // Cache-Control: no-cache

      if (cached && swr && !mustRevalidate) {
        const stale = this.fromCache(ctx, cached, { stale: true, staleReason: "revalidating" });
        if (stale) {
          this.metricsCollector?.recordCacheHit();
          this.metricsCollector?.recordStale();
          ctx.log.debug("Cache stale — serving stale, revalidating");
          this.revalidateInBackground(ctx, cacheKey, cached);
          return stale;
        }
      }

      this.metricsCollector?.recordCacheMiss();
    }

    const result = await this.runNetwork(ctx, cached, cacheKey);

    if (!result.ok && cached && cfg?.staleIfError && this.isUpstreamFailure(result)) {
      const stale = this.fromCache(ctx, cached, { stale: true, staleReason: "error" });
      if (stale) {
        this.metricsCollector?.recordStale();
        ctx.log.warn(`Upstream failed (${result.code ?? result.status}) — serving stale cache`);
        return stale;
      }
    }

    return this.withMeta(result, { requestId: ctx.requestId, durationMs: ctx.elapsed() });
  }

  private isUpstreamFailure(r: ErrorResult): boolean {
    return r.status >= 500 || r.code === "NETWORK_ERROR" || r.code === "TIMEOUT" || r.code === "CIRCUIT_OPEN";
  }

  /** One background revalidation per key (single-flight); never cancelled by the caller's signal. */
  private revalidateInBackground(ctx: RequestContext, cacheKey: string, cached: CachedResponse): void {
    if (this.revalidating.has(cacheKey) || this.disposed) return;
    this.revalidating.add(cacheKey);
    const bg: RequestContext = { ...ctx, headers: { ...ctx.headers }, signal: undefined, deadline: undefined };
    void this.runNetwork(bg, cached, cacheKey)
      .catch((err: unknown) => ctx.log.warn("Background revalidation failed", { err: String(err) }))
      .finally(() => this.revalidating.delete(cacheKey));
  }

  private async storeGet(key: string): Promise<CachedResponse | undefined> {
    try {
      return (await this.cacheStore?.get(key)) ?? undefined;
    } catch (err) {
      this.log.warn("Cache store get failed", { err: String(err) });
      return undefined;
    }
  }

  private validate(
    schema: ZodLike<unknown>,
    value: unknown,
  ): { ok: true; data: unknown } | { ok: false; details: unknown } {
    try {
      const parsed = schema.safeParse(value);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : { ok: false, details: schemaErrorDetails(parsed.error) };
    } catch (err) {
      return { ok: false, details: { message: err instanceof Error ? err.message : String(err) } };
    }
  }

  private fromCache(ctx: RequestContext, cached: CachedResponse, extra: ResultMeta): SuccessResult<unknown> | null {
    let data: unknown = this.cacheCfg?.cloneOnRead ? cloneBody(cached.body) : cached.body;
    if (ctx.options.responseSchema) {
      const v = this.validate(ctx.options.responseSchema, data);
      if (!v.ok) return null;
      data = v.data;
    }
    return {
      ok: true,
      data,
      status: cached.status,
      headers: cached.headers,
      meta: { cached: true, requestId: ctx.requestId, durationMs: ctx.elapsed(), ...extra },
    };
  }

  // =================================================================
  // NETWORK: attempt loop (circuit → rate limit → got → retry)
  // =================================================================
  private abortResult(ctx: RequestContext): ErrorResult {
    const meta = { requestId: ctx.requestId, durationMs: ctx.elapsed() };
    if (ctx.deadline?.aborted && !ctx.options.signal?.aborted) {
      return this.fail("Total request timeout exceeded.", 504, { code: "TIMEOUT", meta });
    }
    return this.fail("Request aborted.", 499, { code: "ABORTED", meta });
  }

  private settleCircuit(status: number): void {
    if (!this.circuit) return;
    if (this.circuit.isFailureStatus(status)) this.circuit.recordFailure();
    else if (status < 500) this.circuit.recordSuccess();
    else this.circuit.recordNeutral();
  }

  private async runNetwork(
    ctx: RequestContext,
    cached: CachedResponse | undefined,
    cacheKey: string | null,
  ): Promise<ApiResult<unknown>> {
    const { method, log, options } = ctx;
    const signal = ctx.signal;

    await this.runHooks(this.config.hooks?.onRequest, (hook) =>
      hook({ url: ctx.fullUrl, method, headers: ctx.headers, body: options.body, requestId: ctx.requestId }),
    );

    const hasIdempotencyKey = hasHeader(ctx.headers, "Idempotency-Key");
    let attempt = 0; // retries performed
    let tries = 0; // upstream calls made

    for (;;) {
      if (signal?.aborted) return this.abortResult(ctx);

      // ── Circuit breaker gate (per real upstream attempt) ─────
      if (this.circuit && !this.circuit.tryAcquire()) {
        this.metricsCollector?.recordCircuitRejected();
        const retryAfter = Math.ceil(this.circuit.retryAfterMs() / 1000);
        log.warn("Circuit open — request short-circuited");
        return this.fail("Service temporarily unavailable (circuit open).", 503, {
          code: "CIRCUIT_OPEN",
          details: { retryAfterSeconds: retryAfter },
          meta: { attempts: tries, requestId: ctx.requestId, durationMs: ctx.elapsed() },
        });
      }

      // ── Rate limit gate (per real upstream attempt, including retries) ──
      if (this.bucket) {
        try {
          await this.bucket.acquire(signal);
        } catch (err) {
          this.circuit?.recordNeutral();
          if (err instanceof RateLimitError) {
            this.metricsCollector?.recordRateLimited();
            log.warn("Rate limited locally");
            return this.fail("Too many requests (client-side rate limit).", 429, {
              code: "RATE_LIMITED",
              meta: { attempts: tries, requestId: ctx.requestId, durationMs: ctx.elapsed() },
            });
          }
          if (signal?.aborted) return this.abortResult(ctx);
          throw err;
        }
      }

      // ── Send ─────────────────────────────────────────────────
      const attemptHeaders: HeaderMap = { ...ctx.headers };
      if (cached && this.cacheCfg?.conditional) {
        if (cached.etag) setHeader(attemptHeaders, "If-None-Match", cached.etag);
        if (cached.lastModified) setHeader(attemptHeaders, "If-Modified-Since", cached.lastModified);
      }

      const gotOpts: OptionsOfBufferResponseBody = {
        headers: attemptHeaders,
        method,
        retry: { limit: 0 },
        timeout: { request: ctx.timeoutMs },
        throwHttpErrors: false,
        responseType: "buffer",
        ...(signal ? { signal } : {}),
        ...(ctx.bodyOpts as Partial<OptionsOfBufferResponseBody>),
      };

      const tryTimer = startTimer();
      tries++;
      let response: Awaited<ReturnType<typeof this.sendOnce>>;
      try {
        response = await this.sendOnce(ctx.fullUrl, gotOpts);
      } catch (err) {
        const ssrfErr = findSsrfError(err);
        if (ssrfErr) {
          this.circuit?.recordNeutral();
          log.error(`SSRF blocked: ${ssrfErr.message}`);
          await this.emitError(ctx, err);
          return this.fail(ssrfErr.message, 403, { code: "SSRF_BLOCKED", meta: { attempts: tries } });
        }
        if (this.isAbort(err) || signal?.aborted) {
          this.circuit?.recordNeutral();
          await this.emitError(ctx, err);
          return this.abortResult(ctx);
        }

        // Network-level failure → counts once against the circuit; retry if allowed.
        this.circuit?.recordFailure();
        if (attempt < ctx.retry.limit && isRetryableMethod(ctx.retry, method, hasIdempotencyKey)) {
          const delay = backoffDelay(attempt, ctx.retry);
          const aborted = await this.prepareRetry(ctx, attempt, delay, "network error");
          if (aborted) return aborted;
          attempt++;
          continue;
        }

        this.metricsCollector?.recordError();
        await this.emitError(ctx, err);
        return this.networkFailure(err, ctx, tries);
      }

      const status = response.statusCode;
      const durationMs = tryTimer();
      this.metricsCollector?.recordLatency(durationMs);
      this.metricsCollector?.recordStatus(status);
      const respHeaders = flattenHeaders(response.headers as Record<string, string | string[] | undefined>);
      const contentType = getHeader(respHeaders, "content-type");
      const rawBuf = toBuffer(response.body);

      // ── 304: cached content is still fresh ───────────────────
      if (status === 304 && cached) {
        this.refreshCacheTtl(cacheKey, cached, options);
        await this.runHooks(this.config.hooks?.onResponse, (h) =>
          h({ url: ctx.fullUrl, method, status, body: cached.body, durationMs, requestId: ctx.requestId }),
        );
        this.circuit?.recordSuccess();
        const hit = this.fromCache(ctx, cached, { attempts: tries });
        if (hit) return hit;
        // cached body fails the caller's schema → fall through to a plain success below
      }

      // ── Decode (never throws; lenient for error bodies) ──────
      const decoded = decodeBody(rawBuf, contentType, ctx.responseType, status >= 400);

      await this.runHooks(this.config.hooks?.onResponse, (hook) =>
        hook({
          url: ctx.fullUrl,
          method,
          status,
          body: decoded.ok ? decoded.value : rawBuf.toString("utf8"),
          durationMs,
          requestId: ctx.requestId,
        }),
      );

      // ── 401 → refresh credentials once, then replay ──────────
      if (
        status === 401 &&
        ctx.usedConfigAuth &&
        this.rawConfig.refreshAuth &&
        !ctx.authRefreshed &&
        ctx.replayable
      ) {
        ctx.authRefreshed = true;
        this.settleCircuit(status);
        if (await this.refreshCredentials(ctx)) {
          log.debug("Replaying request after credential refresh");
          continue;
        }
      }

      // ── Retryable status? ────────────────────────────────────
      if (
        status >= 400 &&
        ctx.retry.retryStatusCodes.has(status) &&
        attempt < ctx.retry.limit &&
        isRetryableMethod(ctx.retry, method, hasIdempotencyKey)
      ) {
        const ra = ctx.retry.respectRetryAfter
          ? parseRetryAfter(getHeader(respHeaders, "retry-after"))
          : null;

        if (ra !== null && ra > ctx.retry.maxRetryAfterMs) {
          // Upstream wants us to wait longer than we're willing to — give up now.
          this.settleCircuit(status);
          this.metricsCollector?.recordError();
          log.warn(`Retry-After ${ra}ms exceeds maxRetryAfterMs; not retrying`, { status });
          return this.httpFailure(status, decoded, tries, ra);
        }

        const delay = ra ?? backoffDelay(attempt, ctx.retry);
        this.settleCircuit(status);
        const aborted = await this.prepareRetry(ctx, attempt, delay, `status ${status}`);
        if (aborted) return aborted;
        attempt++;
        continue;
      }

      // ── HTTP error (final) ───────────────────────────────────
      if (status >= 400) {
        this.settleCircuit(status);
        this.metricsCollector?.recordError();
        const lvl = status >= 500 ? "error" : "warn";
        log[lvl]("Request failed", { url: this.logUrl(ctx.fullUrl), status, durationMs });
        return this.httpFailure(status, decoded, tries);
      }

      // ── Success ──────────────────────────────────────────────
      if (!decoded.ok) {
        this.circuit?.recordFailure();
        this.metricsCollector?.recordError();
        log.warn("Upstream response could not be decoded", { status, contentType });
        return this.fail(`Invalid response body from upstream: ${decoded.error}`, 502, {
          code: "PARSE_ERROR",
          meta: { attempts: tries },
        });
      }

      this.circuit?.recordSuccess();
      this.metricsCollector?.recordSuccess();

      let data: unknown = decoded.value;
      if (options.responseSchema) {
        const v = this.validate(options.responseSchema, data);
        if (!v.ok) {
          log.warn("Response validation failed", { errors: this.redact(v.details) as Record<string, unknown> });
          return this.fail("Response validation error.", 502, {
            code: "RESPONSE_VALIDATION",
            details: v.details,
            meta: { attempts: tries },
          });
        }
        data = v.data;
      }

      if (cacheKey) await this.storeInCache(cacheKey, status, decoded.value, respHeaders, options);
      if (MUTATION_METHODS.has(method) && status < 400) await this.invalidateAfterMutation(ctx, respHeaders);

      log.debug(`✓ ${method} ${this.logUrl(ctx.fullUrl)} → ${status} (${durationMs}ms)`);
      return { ok: true, data, status, headers: respHeaders, meta: { attempts: tries } };
    }
  }

  private sendOnce(url: string, opts: OptionsOfBufferResponseBody) {
    return this.httpClient(url, opts);
  }

  /** Emit onRetry, log, sleep. Returns an ErrorResult if the wait was aborted. */
  private async prepareRetry(
    ctx: RequestContext,
    attempt: number,
    delayMs: number,
    reason: string,
  ): Promise<ErrorResult | null> {
    this.metricsCollector?.recordRetry();
    await this.runHooks(this.config.hooks?.onRetry, (h) =>
      h({ url: ctx.fullUrl, method: ctx.method, attempt: attempt + 1, delayMs, reason }),
    );
    ctx.log.debug(`Retrying after ${delayMs}ms (${reason})`, { attempt: attempt + 1 });
    try {
      await sleep(delayMs, ctx.signal);
      return null;
    } catch {
      return this.abortResult(ctx);
    }
  }

  private async refreshCredentials(ctx: RequestContext): Promise<boolean> {
    const hook = this.rawConfig.refreshAuth;
    if (!hook) return false;

    const usedAuth = getHeader(ctx.credHeaders, "authorization");
    let current: HeaderMap | null = null;
    try {
      current = await this.resolveCredentialHeaders();
    } catch {
      current = null;
    }

    // Another in-flight request may already have refreshed the token.
    const alreadyRefreshed =
      current !== null && usedAuth !== undefined && getHeader(current, "authorization") !== usedAuth;

    if (!alreadyRefreshed) {
      this.authRefreshInflight ??= (async () => {
        this.metricsCollector?.recordAuthRefresh();
        const res = await hook({ url: ctx.fullUrl, method: ctx.method, requestId: ctx.requestId });
        if (typeof res === "string" && res) this.tokenOverride = normalizeAuthorization(res);
      })().finally(() => {
        this.authRefreshInflight = null;
      });
      try {
        await this.authRefreshInflight;
      } catch (err) {
        ctx.log.warn("refreshAuth failed", { err: err instanceof Error ? err.message : String(err) });
        return false;
      }
    }

    let fresh: HeaderMap;
    try {
      fresh = await this.resolveCredentialHeaders();
    } catch {
      return false;
    }
    if (Object.keys(fresh).length === 0) return false;
    for (const k of Object.keys(ctx.credHeaders)) deleteHeader(ctx.headers, k);
    for (const [k, v] of Object.entries(fresh)) setHeader(ctx.headers, k, v);
    ctx.credHeaders = fresh;
    return true;
  }

  private async emitError(ctx: RequestContext, error: unknown): Promise<void> {
    await this.runHooks(this.config.hooks?.onError, (hook) =>
      hook({
        url: ctx.fullUrl,
        method: ctx.method,
        error,
        durationMs: ctx.elapsed(),
        requestId: ctx.requestId,
      }),
    );
  }

  private httpFailure(
    status: number,
    decoded: ReturnType<typeof decodeBody>,
    attempts: number,
    retryAfterMs?: number,
  ): ErrorResult {
    const body = decoded.ok ? decoded.value : undefined;
    const details =
      body !== undefined && body !== "" && !Buffer.isBuffer(body) ? body : undefined;
    return this.fail(parseApiError(body), status, {
      code: "HTTP_ERROR",
      ...(details !== undefined ? { details } : {}),
      meta: { attempts, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    });
  }

  private networkFailure(error: unknown, ctx: RequestContext, attempts: number): ErrorResult {
    const code = error instanceof Error ? (error as NodeError).code : undefined;
    const isTimeout = code === "ETIMEDOUT" || (error as Error | undefined)?.name === "TimeoutError";
    const message = error instanceof Error ? error.message : "An internal error occurred.";

    ctx.log.error(`Proxy error: ${message}`, {
      err: error instanceof Error ? { name: error.name, message: error.message, code } : undefined,
    });

    return this.fail(message, isTimeout ? 504 : 500, {
      code: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      meta: { attempts },
    });
  }

  private isAbort(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as NodeError).code;
    return error.name === "AbortError" || code === "ABORT_ERR" || code === "ERR_ABORTED";
  }

  private logUrl(url: string): string {
    return redactUrl(url, this.redactKeys);
  }

  // ── Cache helpers ────────────────────────────────────────────
  private resolveTtl(
    options: RequestOptions<unknown, unknown>,
    headers?: Record<string, string>,
  ): number | null {
    if (typeof options.cache === "number") return options.cache;
    if (typeof options.cache === "object" && options.cache.ttlMs !== undefined) return options.cache.ttlMs;

    const cfg = this.cacheCfg;
    if (cfg?.respectCacheControl && headers) {
      const cc = parseCacheControl(getHeader(headers, "cache-control"));
      if (cc.noStore) return null;
      if (cc.noCache) return 0;
      if (cc.maxAgeMs !== undefined) return cc.maxAgeMs;
    }
    return cfg?.ttlMs ?? 30_000;
  }

  private async storeInCache(
    key: string,
    status: number,
    body: unknown,
    headers: Record<string, string>,
    options: RequestOptions<unknown, unknown>,
  ): Promise<void> {
    const cfg = this.cacheCfg;
    if (!this.cacheStore || !cfg || !CACHEABLE_STATUS.has(status)) return;

    // Always honour upstream `no-store`. (`private` is fine: entries are keyed per credential.)
    if (parseCacheControl(getHeader(headers, "cache-control")).noStore) return;

    const ttl = this.resolveTtl(options, headers);
    if (ttl === null) return;

    const now = Date.now();
    const entry: CachedResponse = {
      status,
      body: cfg.cloneOnRead ? cloneBody(body) : body,
      headers,
      storedAt: now,
      expiresAt: now + ttl,
      etag: getHeader(headers, "etag"),
      lastModified: getHeader(headers, "last-modified"),
    };
    try {
      await this.cacheStore.set(key, entry, ttl + cfg.staleTtlMs);
    } catch (err) {
      this.log.warn("Cache store set failed", { err: String(err) });
    }
  }

  private refreshCacheTtl(
    key: string | null,
    cached: CachedResponse,
    options: RequestOptions<unknown, unknown>,
  ): void {
    if (!key || !this.cacheStore || !this.cacheCfg) return;
    const ttl = this.resolveTtl(options) ?? this.cacheCfg.ttlMs;
    const now = Date.now();
    void Promise.resolve(
      this.cacheStore.set(key, { ...cached, storedAt: now, expiresAt: now + ttl }, ttl + this.cacheCfg.staleTtlMs),
    ).catch((err: unknown) => this.log.warn("Cache store set failed", { err: String(err) }));
  }

  /** Drop cached reads of the resource a mutation touched (+ Location, + parent collection). */
  private async invalidateAfterMutation(ctx: RequestContext, respHeaders: Record<string, string>): Promise<void> {
    if (!this.cacheStore || !this.cacheCfg?.invalidateOnMutation) return;

    const targets = new Set<string>();
    const add = (u: string | undefined, base: string): void => {
      if (!u) return;
      try {
        targets.add(stripQuery(new URL(u, base).toString()));
      } catch {
        /* ignore malformed */
      }
    };
    add(ctx.fullUrl, ctx.fullUrl);
    add(getHeader(respHeaders, "location"), ctx.fullUrl);
    add(getHeader(respHeaders, "content-location"), ctx.fullUrl);
    try {
      const parent = new URL(ctx.fullUrl);
      parent.search = "";
      parent.hash = "";
      parent.pathname = parent.pathname.replace(/\/[^/]*\/?$/, "") || "/";
      targets.add(parent.toString());
      if (parent.pathname !== "/") targets.add(parent.toString().replace(/\/$/, "") + "/");
    } catch {
      /* ignore */
    }

    await this.deleteCachedResources(targets);
  }

  private async deleteCachedResources(targets: Set<string>): Promise<void> {
    const store = this.cacheStore;
    if (!store) return;
    try {
      if (store.deleteMatching) {
        await store.deleteMatching((key) => {
          const sp = key.indexOf(" ");
          const i2 = key.lastIndexOf("|");
          const i1 = key.lastIndexOf("|", i2 - 1);
          if (sp === -1 || i1 <= sp) return false;
          return targets.has(stripQuery(key.slice(sp + 1, i1)));
        });
      } else {
        for (const url of targets) {
          await store.delete(buildCacheKey("GET", url, "", ""));
          await store.delete(buildCacheKey("HEAD", url, "", ""));
        }
      }
    } catch (err) {
      this.log.warn("Cache invalidation failed", { err: String(err) });
    }
  }

  private withMeta<T>(result: ApiResult<T>, meta: ResultMeta): ApiResult<T> {
    return { ...result, meta: { ...result.meta, ...meta } } as ApiResult<T>;
  }

  protected fail(
    error: string,
    status: number,
    extra?: { code?: string; details?: unknown; meta?: ResultMeta },
  ): ErrorResult {
    return {
      ok: false,
      error,
      status,
      ...(extra?.code ? { code: extra.code } : {}),
      ...(extra?.details !== undefined ? { details: extra.details } : {}),
      ...(extra?.meta ? { meta: extra.meta } : {}),
    };
  }

  // =================================================================
  // PUBLIC: observability / control
  // =================================================================

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

  /** Invalidate one exact cache entry (same credentials / headers / response type). */
  async invalidateCache<TBody = unknown, TResponse = unknown>(
    method: HttpMethod,
    endpoint: string,
    options?: Pick<
      RequestOptions<TBody, TResponse>,
      "params" | "auth" | "authToken" | "headers" | "responseType"
    >,
  ): Promise<void> {
    if (!this.cacheStore) return;
    let url = buildUrl(endpoint, this.config.baseUrl);
    if (options?.params) url = appendParams(url, options.params);

    const authMode = options?.auth ?? this.config.defaultAuth;
    let cred: HeaderMap = {};
    if (!isAuthDisabled(authMode)) {
      try {
        cred = options?.authToken
          ? { Authorization: normalizeAuthorization(options.authToken) }
          : await this.resolveCredentialHeaders();
      } catch {
        cred = {};
      }
    }
    const rt = options?.responseType ?? this.config.responseType;
    await this.cacheStore.delete(
      buildCacheKey(method, url, authFingerprint(cred), variantFingerprint(options?.headers, rt, this.config.responseType)),
    );
  }

  /**
   * Invalidate every cached entry of a resource — all principals, all query
   * strings and header variants.
   */
  async invalidateResource(endpoint: string): Promise<void> {
    const url = stripQuery(buildUrl(endpoint, this.config.baseUrl));
    await this.deleteCachedResources(new Set([url]));
  }

  /**
   * Release sockets and timers. In-flight and later requests fail with
   * `ENGINE_DISPOSED`. Also enables `await using engine = createEngine(...)`.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.bucket?.dispose();
    this.inflight.clear();
    this.agents.http.destroy();
    this.agents.https?.destroy();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  // =================================================================
  // Convenience wrappers
  // =================================================================

  get<TResponse = unknown>(
    endpoint: string,
    options?: Omit<RequestOptions<never, TResponse>, "endpoint" | "method" | "body">,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, never>({ ...options, endpoint, method: "GET" });
  }

  head(
    endpoint: string,
    options?: Omit<RequestOptions<never, unknown>, "endpoint" | "method" | "body">,
  ): Promise<ApiResult<unknown>> {
    return this.request<unknown, never>({ ...options, endpoint, method: "HEAD" });
  }

  options<TResponse = unknown>(
    endpoint: string,
    options?: Omit<RequestOptions<never, TResponse>, "endpoint" | "method" | "body">,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, never>({ ...options, endpoint, method: "OPTIONS" });
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

  delete<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    options?: Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method"> ,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, TBody>({ ...options, endpoint, method: "DELETE" });
  }

  /** HTTP `QUERY` — a safe, idempotent request that carries a body (got 16). */
  query<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method" | "body">,
  ): Promise<ApiResult<TResponse>> {
    return this.request<TResponse, TBody>({ ...options, endpoint, method: "QUERY", body });
  }

  // ── Fork: create a child engine with overridden config ────────
  /**
   * Create a new engine from this one's *complete* configuration plus
   * `overrides`. Config objects (cache, circuitBreaker, retry, rateLimit) are
   * shallow-merged, `defaultHeaders` are merged, hooks are appended, and
   * `redactKeys` / `credentialHosts` are unioned. State (cache contents,
   * breaker, metrics, sockets) is NOT shared with the parent.
   */
  extend(overrides: Partial<EngineConfig>): this {
    const merged = mergeEngineConfig(this.rawConfig, overrides);
    const Ctor = this.constructor as new (config: EngineConfig) => this;
    return new Ctor(merged);
  }
}

// ── Config merging for extend() ──────────────────────────────────
function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export function mergeEngineConfig(base: EngineConfig, o: Partial<EngineConfig>): EngineConfig {
  const defined = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<EngineConfig>;
  const merged: EngineConfig = { ...base, ...defined };

  if (base.defaultHeaders || o.defaultHeaders) {
    merged.defaultHeaders = mergeHeaders(base.defaultHeaders, o.defaultHeaders);
  }
  if (base.cache && o.cache) merged.cache = { ...base.cache, ...o.cache };
  if (base.circuitBreaker && o.circuitBreaker) merged.circuitBreaker = { ...base.circuitBreaker, ...o.circuitBreaker };
  if (base.rateLimit && o.rateLimit) merged.rateLimit = { ...base.rateLimit, ...o.rateLimit };
  if (base.retry && o.retry) merged.retry = { ...base.retry, ...o.retry };
  if (typeof base.ssrfProtection === "object" && typeof o.ssrfProtection === "object") {
    merged.ssrfProtection = { ...base.ssrfProtection, ...o.ssrfProtection };
  }
  if (base.redactKeys || o.redactKeys) merged.redactKeys = [...(base.redactKeys ?? []), ...(o.redactKeys ?? [])];
  if (base.credentialHosts || o.credentialHosts) {
    merged.credentialHosts = [...(base.credentialHosts ?? []), ...(o.credentialHosts ?? [])];
  }
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

// ── Factory function ─────────────────────────────────────────────
export function createEngine(config: EngineConfig): GotApiEngine {
  return new GotApiEngine(config);
}

export { SsrfError };
