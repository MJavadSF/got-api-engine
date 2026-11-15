// ── Building the outgoing Response ───────────────────────────────

import { NULL_BODY_STATUS } from "../../core/constants";
import { isErrorCode } from "../../errors/codes";
import type { MessageResolver } from "../../errors/messages";
import { getHeader } from "../../http/headers";
import type { ErrorResult, SuccessResult } from "../../types/result";
import type { NextRouteHandlerOptions } from "./types";

const DEFAULT_FORWARD_HEADERS = [
  "content-disposition",
  "content-language",
  "etag",
  "last-modified",
  "retry-after",
  "cache-control",
];

/** Error codes whose message / details describe *our* infrastructure. */
const INTERNAL_CODES = new Set([
  "NETWORK_ERROR",
  "TIMEOUT",
  "INTERNAL_ERROR",
  "PARSE_ERROR",
  "RESPONSE_VALIDATION",
  "RESPONSE_TOO_LARGE",
  "SSRF_BLOCKED",
  "CREDENTIALS_BLOCKED",
  "AUTH_PROVIDER_ERROR",
  "ENGINE_DISPOSED",
  "INVALID_URL",
]);

export function jsonResponse(body: unknown, status: number, requestId: string, extra?: Headers): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json");
  headers.set("X-Request-Id", requestId);
  if (NULL_BODY_STATUS.has(status)) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Sanitised error response: infrastructure errors and upstream 5xx get a
 * generic (localised) message and no details, so internal hosts, IPs and
 * stack traces never reach the browser.
 */
export function errorResponse(
  result: ErrorResult,
  options: Pick<NextRouteHandlerOptions, "exposeUpstreamDetails" | "mapError">,
  requestId: string,
  messages: MessageResolver,
): Response {
  if (options.mapError) {
    const mapped = options.mapError(result);
    if (mapped instanceof Response) return mapped;
    return jsonResponse(mapped.body, mapped.status, requestId);
  }

  const internal = (result.code !== undefined && INTERNAL_CODES.has(result.code)) || result.status >= 500;
  const expose = options.exposeUpstreamDetails ?? !internal;
  const message =
    internal && !options.exposeUpstreamDetails
      ? messages(isErrorCode(result.code) ? result.code : "INTERNAL_ERROR")
      : result.error;

  const payload: Record<string, unknown> = { error: message };
  if (expose && result.details !== undefined) payload["details"] = result.details;
  if (result.code) payload["code"] = result.code;

  const headers = new Headers();
  const retryAfter = result.meta?.retryAfterMs;
  if (retryAfter !== undefined) headers.set("Retry-After", String(Math.ceil(retryAfter / 1000)));
  return jsonResponse(payload, result.status, requestId, headers);
}

function isWebStream(v: unknown): v is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && v instanceof ReadableStream;
}

export function successResponse(
  result: SuccessResult<unknown>,
  options: Pick<NextRouteHandlerOptions, "forwardResponseHeaders">,
  requestId: string,
): Response {
  const { status, data, headers: upstream = {} } = result;
  const out = new Headers();
  out.set("X-Request-Id", requestId);
  const allow = options.forwardResponseHeaders === false ? [] : (options.forwardResponseHeaders ?? DEFAULT_FORWARD_HEADERS);
  for (const name of allow) {
    const v = getHeader(upstream, name);
    if (v !== undefined) out.set(name, v);
  }
  if (result.meta?.cached) out.set("X-Cache", result.meta.stale ? "STALE" : "HIT");

  const upstreamType = getHeader(upstream, "content-type");
  if (NULL_BODY_STATUS.has(status)) return new Response(null, { status, headers: out });

  if (isWebStream(data)) {
    if (upstreamType) out.set("Content-Type", upstreamType);
    return new Response(data, { status, headers: out });
  }
  if (Buffer.isBuffer(data)) {
    out.set("Content-Type", upstreamType ?? "application/octet-stream");
    return new Response(new Uint8Array(data), { status, headers: out });
  }
  if (typeof data === "string") {
    out.set("Content-Type", upstreamType ?? "text/plain; charset=utf-8");
    return new Response(data, { status, headers: out });
  }
  // Keep JSON flavours such as application/problem+json or vnd.api+json.
  out.set("Content-Type", upstreamType && /[/+]json/i.test(upstreamType) ? upstreamType : "application/json");
  return new Response(JSON.stringify(data ?? null), { status, headers: out });
}
