// ── Network stage: the upstream attempt loop ─────────────────────
//
//   upstream pick → circuit → rate limit → bulkhead → (hedged) send
//     → classify → 304 / 401-refresh / retry / final
//
// Every gate guards real upstream attempts only (cache hits and dedupe
// followers never reach this stage).

import type { CredentialManager } from "../auth/credentials";
import { fail } from "../core/result";
import type { UpstreamPool } from "../core/upstreams";
import { AttemptHookError, classifyTransportError, toSafeError } from "../errors/classify";
import type { MessageResolver } from "../errors/messages";
import { decodeBody, parseApiError } from "../http/decode";
import { parseRateLimitHeaders, parseRetryAfter } from "../http/directives";
import { deleteHeader, getHeader, hasHeader, setHeader } from "../http/headers";
import type { HookRunner } from "../observability/hooks";
import type { MetricsCollector } from "../observability/metrics";
import { backoffDelay, isRetryableMethod, sleep } from "../resilience/backoff";
import { type Bulkhead, ConcurrencyLimitError, type Release } from "../resilience/bulkhead";
import type { CircuitBreaker } from "../resilience/circuit-breaker";
import type { CircuitRegistry } from "../resilience/circuit-registry";
import { RateLimitError } from "../resilience/rate-limiter";
import type { RetryBudget } from "../resilience/retry-budget";
import type { HeaderMap, Timings } from "../types/http";
import type { HedgeConfig, RateLimiterLike } from "../types/resilience";
import type { ApiResult, ErrorResult } from "../types/result";
import type { RequestContext } from "./context";
import { type HedgeLauncher, sendHedged } from "./hedge";
import { type AttemptRequest, type AttemptResponse, readStreamLimited, type Transport } from "./transport";

const DEFAULT_FAILURE_STATUS: ReadonlySet<number> = new Set([500, 502, 503, 504]);

export interface NetworkDeps {
  transport: Transport;
  pool: UpstreamPool;
  credentials: CredentialManager;
  circuits: CircuitRegistry | null;
  limiter: RateLimiterLike | null;
  adaptiveRateLimit: boolean;
  bulkhead: Bulkhead | null;
  budget: RetryBudget | null;
  hedge: Required<HedgeConfig> | null;
  metrics: MetricsCollector | null;
  hooks: HookRunner;
  messages: MessageResolver;
  allowCredentials: (url: URL) => boolean;
  logUrl: (url: string) => string;
}

export interface Conditional {
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export type NetworkOutcome =
  | { kind: "result"; result: ApiResult<unknown> }
  | { kind: "not-modified"; headers: HeaderMap; attempts: number; timings: Timings | undefined };

interface Gate {
  breaker: CircuitBreaker | null;
  release: Release | null;
}

const OPEN_GATE: Gate = { breaker: null, release: null };

export class NetworkStage {
  private readonly gated: boolean;

  constructor(private readonly d: NetworkDeps) {
    this.gated = Boolean(d.circuits || d.limiter || d.bulkhead);
  }

  async run(ctx: RequestContext, conditional?: Conditional): Promise<NetworkOutcome> {
    const { d } = this;
    if (d.hooks.has("onRequest"))
      await d.hooks.emit("onRequest", {
        url: ctx.url,
        method: ctx.method,
        headers: ctx.headers,
        body: ctx.options.body,
        requestId: ctx.requestId,
      });

    const hasIdempotencyKey = hasHeader(ctx.headers, "Idempotency-Key");
    const tried = new Set<string>();
    let attempt = 0; // retries performed
    let tries = 0; // upstream calls made

    const result = (r: ApiResult<unknown>): NetworkOutcome => ({ kind: "result", result: r });
    // `notSent`: the failed attempt never reached the server, so re-sending
    // cannot duplicate side effects — any method may retry / fail over.
    const canRetry = (notSent = false): boolean =>
      ctx.replayable &&
      attempt < ctx.retry.limit &&
      (notSent || isRetryableMethod(ctx.retry, ctx.method, hasIdempotencyKey)) &&
      (d.budget?.tryRetry() ?? true);

    d.budget?.recordRequest();

    for (;;) {
      if (ctx.signal.aborted) return result(this.abortResult(ctx));

      const upstream = ctx.relative ? d.pool.pick(tried) : null;
      const url = upstream ? d.pool.rebase(ctx.url, upstream) : ctx.url;
      // Reuse the URL parsed in prepare when the attempt targets the canonical URL.
      const target = url === ctx.url ? ctx.parsedUrl : new URL(url);
      const meta = (extra: object = {}) => ({ attempts: tries, ...(upstream ? { upstream: upstream.origin } : {}), ...extra });

      // ── Gates ────────────────────────────────────────────────
      // No gates configured → no extra await on the hot path.
      const gate = this.gated ? await this.acquireGates(ctx, target) : OPEN_GATE;
      if ("error" in gate) {
        // An open circuit on one upstream → fail over to another, if any.
        if (gate.error.code === "CIRCUIT_OPEN" && upstream && tried.size + 1 < d.pool.upstreams.length) {
          tried.add(upstream.base);
          continue;
        }
        return result({ ...gate.error, meta: meta() });
      }

      // ── Send ─────────────────────────────────────────────────
      const headers: HeaderMap = { ...ctx.headers };
      if (conditional?.etag) setHeader(headers, "If-None-Match", conditional.etag);
      if (conditional?.lastModified) setHeader(headers, "If-Modified-Since", conditional.lastModified);
      const request = this.attemptRequest(ctx, url, headers);

      tries++;
      const started = performance.now();
      let response: AttemptResponse;
      let hedged = false;
      try {
        const sent = await this.send(ctx, request, upstream?.base, tries);
        response = sent.response;
        hedged = sent.hedged;
      } catch (err) {
        const latency = Math.round(performance.now() - started);
        const cls = classifyTransportError(err);
        // Caller abort, total deadline or engine shutdown — not an upstream fault.
        if (ctx.signal.aborted && cls.code !== "RESPONSE_TOO_LARGE" && cls.code !== "SSRF_BLOCKED") {
          this.settle(gate, "neutral");
          await this.emitError(ctx, err);
          return result({ ...this.abortResult(ctx), meta: meta() });
        }

        this.settle(gate, cls.circuit === "failure" ? "failure" : "neutral", cls.overload);
        d.metrics?.recordAttempt(this.route(ctx, target), undefined, latency);
        if (cls.circuit === "failure" && upstream) d.pool.markUnhealthy(upstream.base);

        if (cls.retryable && canRetry(cls.notSent)) {
          if (upstream) tried.add(upstream.base);
          const aborted2 = await this.waitRetry(ctx, attempt, backoffDelay(attempt, ctx.retry), cls.code.toLowerCase());
          if (aborted2) return result({ ...aborted2, meta: meta() });
          attempt++;
          continue;
        }

        await this.emitError(ctx, err);
        ctx.log[cls.code === "REQUEST_INVALID" ? "warn" : "error"](`Upstream attempt failed: ${cls.code}`, {
          err: toSafeError(err),
          url: d.logUrl(url),
        });
        // Localised message for the result; the raw transport message stays in `details`.
        return result(fail(d.messages(cls.code), cls.status, { code: cls.code, details: { cause: cls.message }, meta: meta() }));
      }

      // ── Response ─────────────────────────────────────────────
      const status = response.status;
      const latency = response.timings?.total ?? Math.round(performance.now() - started);
      d.metrics?.recordAttempt(this.route(ctx, target), status, latency);
      this.adaptRateLimit(status, response.headers);

      if (status === 304 && conditional) {
        this.settle(gate, "success");
        if (upstream) d.pool.markHealthy(upstream.base);
        if (d.hooks.has("onResponse"))
          await d.hooks.emit("onResponse", {
            url,
            method: ctx.method,
            status,
            body: undefined,
            durationMs: latency,
            requestId: ctx.requestId,
          });
        return { kind: "not-modified", headers: response.headers, attempts: tries, timings: response.timings };
      }

      const isStream = !Buffer.isBuffer(response.body);
      const raw = isStream
        ? status >= 400
          ? await readStreamLimited(response.body as ReadableStream<Uint8Array>)
          : undefined
        : (response.body as Buffer);
      const contentType = getHeader(response.headers, "content-type");
      const mode = ctx.responseType === "stream" ? "auto" : ctx.responseType;
      // Error bodies decode leniently (never fail); only success bodies can be unparseable.
      const decoded = raw ? decodeBody(raw, contentType, mode, status >= 400) : { ok: true as const, value: response.body };
      const bodyValue = decoded.ok ? decoded.value : raw?.toString("utf8");

      if (d.hooks.has("onResponse"))
        await d.hooks.emit("onResponse", {
          url,
          method: ctx.method,
          status,
          body: bodyValue,
          durationMs: latency,
          requestId: ctx.requestId,
        });

      // ── 401 → refresh credentials once, then replay ──────────
      if (status === 401 && ctx.usedConfigAuth && !ctx.authRefreshed && ctx.replayable && d.credentials.refreshable) {
        ctx.authRefreshed = true;
        this.settle(gate, "status", false, status);
        if (await this.refreshCredentials(ctx)) {
          ctx.log.debug("Replaying request after credential refresh");
          continue;
        }
      }

      // ── Retryable status ─────────────────────────────────────
      if (status >= 400 && ctx.retry.retryStatusCodes.has(status) && canRetry()) {
        const ra = ctx.retry.respectRetryAfter ? parseRetryAfter(getHeader(response.headers, "retry-after")) : null;
        this.settle(gate, "status", status === 429 || status === 503, status);
        if (upstream && this.isUpstreamFailure(gate, status)) d.pool.markUnhealthy(upstream.base);

        if (ra !== null && ra > ctx.retry.maxRetryAfterMs) {
          ctx.log.warn(`Retry-After ${ra}ms exceeds maxRetryAfterMs; not retrying`, { status });
          return result(this.httpFailure(status, bodyValue, response.headers, meta({ retryAfterMs: ra })));
        }
        if (upstream) tried.add(upstream.base);
        const aborted = await this.waitRetry(ctx, attempt, ra ?? backoffDelay(attempt, ctx.retry), `status ${status}`);
        if (aborted) return result({ ...aborted, meta: meta() });
        attempt++;
        continue;
      }

      // ── Final HTTP error ─────────────────────────────────────
      if (status >= 400) {
        this.settle(gate, "status", status === 429 || status === 503, status);
        if (upstream && this.isUpstreamFailure(gate, status)) d.pool.markUnhealthy(upstream.base);
        const ra = parseRetryAfter(getHeader(response.headers, "retry-after"));
        ctx.log[status >= 500 ? "error" : "warn"]("Request failed", { url: d.logUrl(url), status, durationMs: latency });
        return result(
          this.httpFailure(
            status,
            bodyValue,
            response.headers,
            meta({ timings: response.timings, ...(ra !== null ? { retryAfterMs: ra } : {}) }),
          ),
        );
      }

      // ── Success ──────────────────────────────────────────────
      if (!decoded.ok) {
        this.settle(gate, "failure");
        ctx.log.warn("Upstream response could not be decoded", { status, contentType });
        return result(fail(`${d.messages("PARSE_ERROR")} ${decoded.error}`, 502, { code: "PARSE_ERROR", meta: meta() }));
      }
      this.settle(gate, "success");
      if (upstream) d.pool.markHealthy(upstream.base);
      // Formatting (URL redaction) is skipped entirely when debug logging is off.
      if (ctx.log.isLevelEnabled?.("debug") !== false)
        ctx.log.debug(`✓ ${ctx.method} ${d.logUrl(url)} → ${status} (${latency}ms)`);
      return result({
        ok: true,
        data: decoded.value,
        status,
        headers: response.headers,
        meta: meta({ timings: response.timings, ...(hedged ? { hedged: true } : {}) }),
      });
    }
  }

  // ── Gates ──────────────────────────────────────────────────────
  private async acquireGates(ctx: RequestContext, url: URL): Promise<Gate | { error: ErrorResult }> {
    const { d } = this;
    const breaker = d.circuits?.get(url) ?? null;
    if (breaker && !breaker.tryAcquire()) {
      d.metrics?.inc("circuitRejectedCount");
      ctx.log.warn("Circuit open — request short-circuited");
      return {
        error: fail(d.messages("CIRCUIT_OPEN"), 503, {
          code: "CIRCUIT_OPEN",
          details: { retryAfterSeconds: Math.ceil(breaker.retryAfterMs() / 1000) },
        }),
      };
    }

    if (d.limiter) {
      try {
        await d.limiter.acquire(ctx.signal);
      } catch (err) {
        breaker?.recordNeutral();
        if (err instanceof RateLimitError) {
          d.metrics?.inc("rateLimitedCount");
          ctx.log.warn("Rate limited locally");
          return { error: fail(d.messages("RATE_LIMITED"), 429, { code: "RATE_LIMITED" }) };
        }
        return { error: this.abortResult(ctx) };
      }
    }

    let release: Release | null = null;
    if (d.bulkhead) {
      try {
        release = await d.bulkhead.acquire(ctx.signal);
      } catch (err) {
        breaker?.recordNeutral();
        if (err instanceof ConcurrencyLimitError) {
          d.metrics?.inc("concurrencyLimitedCount");
          return { error: fail(d.messages("CONCURRENCY_LIMITED"), 503, { code: "CONCURRENCY_LIMITED" }) };
        }
        return { error: this.abortResult(ctx) };
      }
    }
    return { breaker, release };
  }

  private settle(gate: Gate, outcome: "success" | "failure" | "neutral" | "status", overload = false, status = 0): void {
    if (outcome === "status") gate.breaker?.recordStatus(status);
    else if (outcome === "success") gate.breaker?.recordSuccess();
    else if (outcome === "failure") gate.breaker?.recordFailure();
    else gate.breaker?.recordNeutral();
    const ok = outcome === "success" || (outcome === "status" && status < 500 && status !== 429);
    gate.release?.(overload ? "overload" : ok ? "success" : "neutral");
  }

  // ── Sending ────────────────────────────────────────────────────
  private attemptRequest(ctx: RequestContext, url: string, headers: HeaderMap): AttemptRequest {
    return {
      url,
      method: ctx.method,
      headers,
      body: ctx.body,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      maxResponseBytes: ctx.maxResponseBytes,
      stream: ctx.responseType === "stream",
      credentialHeaders: Object.keys(ctx.credHeaders),
      allowCredentials: this.d.allowCredentials,
      onUploadProgress: ctx.options.onUploadProgress,
      onDownloadProgress: ctx.options.onDownloadProgress,
    };
  }

  private send(ctx: RequestContext, request: AttemptRequest, base: string | undefined, attempt: number) {
    const send = (r: AttemptRequest, isHedge = false) =>
      this.withAttemptHooks(ctx, r, attempt, isHedge).then((x) => this.d.transport.send(x));
    if (!ctx.hedge || !this.d.hedge) return send(request).then((response) => ({ response, hedged: false }));
    return sendHedged(send, request, this.hedgeLauncher(ctx, request, base));
  }

  /**
   * Run `ctx.onAttempt` hooks on a private copy of the headers, so every
   * attempt (retry, failover, hedge) is signed for its own URL and time.
   * Headers the hooks add or change are treated as credentials.
   */
  private async withAttemptHooks(
    ctx: RequestContext,
    r: AttemptRequest,
    attempt: number,
    hedge: boolean,
  ): Promise<AttemptRequest> {
    if (ctx.attemptHooks.length === 0) return r;
    const headers: HeaderMap = { ...r.headers };
    try {
      for (const hook of ctx.attemptHooks) {
        await hook({ method: r.method, url: r.url, headers, body: r.body, attempt, hedge });
      }
    } catch (err) {
      throw new AttemptHookError(err);
    }
    const touched = Object.keys(headers).filter((k) => headers[k] !== r.headers[k]);
    return { ...r, headers, credentialHeaders: [...new Set([...r.credentialHeaders, ...touched])] };
  }

  private hedgeLauncher(ctx: RequestContext, primary: AttemptRequest, base: string | undefined): HedgeLauncher {
    const { d } = this;
    const cfg = d.hedge as Required<HedgeConfig>;
    return {
      delayMs: () => {
        const ms = cfg.afterMs === "p95" ? d.metrics?.p95() : cfg.afterMs;
        return ms === undefined ? undefined : Math.max(cfg.minDelayMs, ms);
      },
      prepare: () => {
        if (d.limiter?.tryAcquire && !d.limiter.tryAcquire()) return null;
        const release = d.bulkhead ? d.bulkhead.tryAcquire() : () => undefined;
        if (!release) return null;
        if (d.budget && !d.budget.tryRetry()) {
          release();
          return null;
        }
        d.metrics?.inc("hedgeCount");
        const next = ctx.relative ? d.pool.pick(new Set(base ? [base] : [])) : null;
        const url = next ? d.pool.rebase(ctx.url, next) : primary.url;
        return { request: { ...primary, url }, release: () => release() };
      },
    };
  }

  // ── Helpers ────────────────────────────────────────────────────
  /** Breaker's failure statuses when configured, otherwise the standard gateway / server errors. */
  private isUpstreamFailure(gate: Gate, status: number): boolean {
    return gate.breaker ? gate.breaker.isFailureStatus(status) : DEFAULT_FAILURE_STATUS.has(status);
  }

  private adaptRateLimit(status: number, headers: HeaderMap): void {
    const limiter = this.d.limiter;
    if (!this.d.adaptiveRateLimit || !limiter?.pauseUntil) return;
    const now = Date.now();
    if (status === 429 || status === 503) {
      const ra = parseRetryAfter(getHeader(headers, "retry-after"), now);
      if (ra !== null) {
        limiter.pauseUntil(now + ra);
        return;
      }
    }
    const hint = parseRateLimitHeaders((n) => getHeader(headers, n), now);
    if (hint && hint.remaining <= 0) limiter.pauseUntil(now + hint.resetMs);
  }

  private async refreshCredentials(ctx: RequestContext): Promise<boolean> {
    const usedAuth = getHeader(ctx.credHeaders, "authorization");
    let fresh: HeaderMap | null;
    try {
      fresh = await this.d.credentials.refresh({ url: ctx.url, method: ctx.method, requestId: ctx.requestId }, usedAuth);
    } catch (err) {
      ctx.log.warn("Credential refresh failed", { err: toSafeError(err) });
      return false;
    }
    if (!fresh) return false;
    for (const k of Object.keys(ctx.credHeaders)) deleteHeader(ctx.headers, k);
    for (const [k, v] of Object.entries(fresh)) setHeader(ctx.headers, k, v);
    ctx.credHeaders = fresh;
    return true;
  }

  /** Emit onRetry and sleep; returns an error result if the wait was aborted. */
  private async waitRetry(ctx: RequestContext, attempt: number, delayMs: number, reason: string): Promise<ErrorResult | null> {
    this.d.metrics?.inc("retryCount");
    if (this.d.hooks.has("onRetry"))
      await this.d.hooks.emit("onRetry", { url: ctx.url, method: ctx.method, attempt: attempt + 1, delayMs, reason });
    ctx.log.debug(`Retrying after ${delayMs}ms (${reason})`, { attempt: attempt + 1 });
    try {
      await sleep(delayMs, ctx.signal);
      return null;
    } catch {
      return this.abortResult(ctx);
    }
  }

  private async emitError(ctx: RequestContext, error: unknown): Promise<void> {
    if (this.d.hooks.has("onError"))
      await this.d.hooks.emit("onError", {
        url: ctx.url,
        method: ctx.method,
        error: toSafeError(error),
        durationMs: ctx.elapsed(),
        requestId: ctx.requestId,
      });
  }

  abortResult(ctx: RequestContext): ErrorResult {
    switch (ctx.cancel.cause) {
      case "deadline":
        return fail(this.d.messages("TIMEOUT"), 504, { code: "TIMEOUT" });
      case "dispose":
        return fail(this.d.messages("ENGINE_DISPOSED"), 503, { code: "ENGINE_DISPOSED" });
      default:
        return fail(this.d.messages("ABORTED"), 499, { code: "ABORTED" });
    }
  }

  private httpFailure(status: number, body: unknown, headers: HeaderMap, meta: ErrorResult["meta"]): ErrorResult {
    const details = body !== undefined && body !== "" && !Buffer.isBuffer(body) ? body : undefined;
    return fail(parseApiError(body), status, { code: "HTTP_ERROR", details, headers, meta });
  }

  private route(ctx: RequestContext, url: URL): string {
    return ctx.metricsLabel || `${ctx.method} ${url.host}`;
  }
}
