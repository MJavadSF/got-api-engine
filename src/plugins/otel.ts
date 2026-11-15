// ── OpenTelemetry tracing middleware (no hard dependency) ────────
//
//   import { trace, context, propagation } from "@opentelemetry/api";
//   api.use(otel({
//     tracer: trace.getTracer("my-app"),
//     inject: (headers) => propagation.inject(context.active(), headers),
//   }));

import { redactUrl } from "../security/redact";
import type { Middleware } from "../types/middleware";

/** Structural subset of `@opentelemetry/api` Span. */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException?(exception: { name: string; message: string }): unknown;
  end(): void;
}

export interface TracerLike {
  startSpan(name: string, options?: { kind?: number; attributes?: Record<string, string | number | boolean> }): SpanLike;
}

export interface OtelOptions {
  tracer: TracerLike;
  /** Inject W3C trace context (`traceparent`) into outgoing headers. */
  inject?: (headers: Record<string, string>) => void;
  /** @default `HTTP ${method}` */
  spanName?: (method: string, url: URL) => string;
  /** Extra attributes per request. */
  attributes?: (url: URL) => Record<string, string | number | boolean>;
}

const SPAN_KIND_CLIENT = 2;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

export function otel(options: OtelOptions): Middleware {
  return async (ctx, next) => {
    const url = new URL(ctx.url);
    const span = options.tracer.startSpan(options.spanName?.(ctx.method, url) ?? `HTTP ${ctx.method}`, {
      kind: SPAN_KIND_CLIENT,
      attributes: {
        "http.request.method": ctx.method,
        "url.full": redactUrl(ctx.url),
        "server.address": url.hostname,
        ...(url.port ? { "server.port": Number(url.port) } : {}),
        "got_api_engine.request_id": ctx.requestId,
        ...options.attributes?.(url),
      },
    });
    options.inject?.(ctx.headers);
    try {
      const result = await next();
      span.setAttribute("http.response.status_code", result.status);
      if (result.meta?.cached) span.setAttribute("got_api_engine.cached", true);
      if (result.meta?.attempts !== undefined) span.setAttribute("got_api_engine.attempts", result.meta.attempts);
      if (result.ok) span.setStatus({ code: STATUS_OK });
      else {
        span.setAttribute("error.type", result.code ?? String(result.status));
        span.setStatus({ code: STATUS_ERROR, message: result.error });
      }
      return result;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      span.recordException?.({ name: e.name, message: e.message });
      span.setStatus({ code: STATUS_ERROR, message: e.message });
      throw err;
    } finally {
      span.end();
    }
  };
}
