// ── Prepare stage: options → RequestContext (or an early error) ──
//
// URL (normalised, traversal-checked, SSRF-checked) → credentials (scoped
// to trusted origins) → headers (validated) → body (validated, encoded) →
// retry policy → cancellation signals.

import { isAuthDisabled, isAuthOptional, isAuthRequired, normalizeAuthorization } from "../auth/normalize";
import { IDEMPOTENCY_METHODS, SAFE_METHODS } from "../core/constants";
import { fail } from "../core/result";
import type { Runtime } from "../core/runtime";
import type { ErrorCode } from "../errors/codes";
import { findInvalidHeader, hasHeader, mergeHeaders, setHeader, setHeaderIfAbsent } from "../http/headers";
import { generateIdempotencyKey } from "../http/misc";
import { appendParams, buildUrl, checkRelativePath, isAbsoluteUrl } from "../http/url";
import { type ResolvedRetry, resolveRetry } from "../resilience/backoff";
import { assertUrlAllowed } from "../security/ssrf";
import type { HeaderMap, HttpMethod, ResponseType } from "../types/http";
import type { LoggerInterface } from "../types/observability";
import type { KeyCase, RequestOptions } from "../types/request";
import type { ErrorResult } from "../types/result";
import { bodyKeyMaterial, encodeBody } from "./body";
import type { RequestContext } from "./context";

export type Prepared = { ok: true; ctx: RequestContext } | { ok: false; result: ErrorResult };

export interface PrepareInput {
  options: RequestOptions<unknown, unknown>;
  method: HttpMethod;
  requestId: string;
  log: LoggerInterface;
  elapsed: () => number;
}

const ACCEPT: Record<ResponseType, string> = {
  buffer: "*/*",
  stream: "*/*",
  text: "text/plain, */*;q=0.8",
  json: "application/json, text/plain;q=0.9, */*;q=0.8",
  auto: "application/json, text/plain;q=0.9, */*;q=0.8",
};

export async function prepareRequest(rt: Runtime, input: PrepareInput): Promise<Prepared> {
  const { options, method, requestId, log, elapsed } = input;
  const { config } = rt;
  const reject = (code: ErrorCode, status: number, message?: string, details?: unknown): Prepared => ({
    ok: false,
    result: fail(message ?? rt.messages(code), status, { code, details, meta: { requestId, durationMs: elapsed() } }),
  });

  // ── URL ────────────────────────────────────────────────────────
  const relative = !isAbsoluteUrl(options.endpoint);
  const base = rt.pool.primary.base;
  let url: string;
  let parsed: URL;
  try {
    let raw = buildUrl(options.endpoint, base);
    if (options.params) raw = appendParams(raw, options.params);
    // Parsed once; the URL object is reused for every check below.
    parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("protocol");
    if (relative && (config.strictPath ?? true)) {
      const check = checkRelativePath(options.endpoint, rt.pool.primary.url, parsed);
      if (!check.ok) return reject("INVALID_URL", 400, `${rt.messages("INVALID_URL")} (${check.reason})`);
    }
    parsed.hash = "";
    url = parsed.href;
  } catch {
    return reject("INVALID_URL", 400, `${rt.messages("INVALID_URL")} ${rt.logUrl(options.endpoint)}`);
  }

  if (rt.ssrf) {
    try {
      assertUrlAllowed(parsed, rt.ssrf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : rt.messages("SSRF_BLOCKED");
      log.error(`SSRF blocked: ${msg}`);
      return reject("SSRF_BLOCKED", 403, msg);
    }
  }

  // ── Credentials ────────────────────────────────────────────────
  const authMode = options.auth ?? config.defaultAuth ?? true;
  let credHeaders: HeaderMap = {};
  let usedConfigAuth = false;

  if (!isAuthDisabled(authMode)) {
    if (options.authToken) {
      credHeaders = { Authorization: normalizeAuthorization(options.authToken) };
    } else if (rt.credentials.configured) {
      if (!rt.allowCredentials(parsed)) {
        if (isAuthRequired(authMode)) {
          const host = parsed.host;
          log.warn(`Refusing to send engine credentials to foreign host ${host}`);
          return reject(
            "CREDENTIALS_BLOCKED",
            403,
            `Refusing to send credentials to ${host}. Pass \`auth: false\`, an explicit \`authToken\`, or add the host to \`credentialHosts\`.`,
          );
        }
        // "optional": silently send no credentials to foreign origins.
      } else {
        try {
          credHeaders = await rt.credentials.resolve();
          usedConfigAuth = Object.keys(credHeaders).length > 0;
        } catch (err) {
          log.error("Auth provider threw", { err: err instanceof Error ? err.message : String(err) });
          return reject("AUTH_PROVIDER_ERROR", 500);
        }
      }
    }
    if (isAuthRequired(authMode) && Object.keys(credHeaders).length === 0) {
      log.warn("Auth required but no token available");
      return reject("AUTH_REQUIRED", 401);
    }
    if (isAuthOptional(authMode) && Object.keys(credHeaders).length === 0) usedConfigAuth = false;
  }

  // ── Headers ────────────────────────────────────────────────────
  const responseType = options.responseType ?? config.responseType ?? "auto";
  const headers = mergeHeaders(config.defaultHeaders, options.headers);
  for (const [k, v] of Object.entries(credHeaders)) setHeader(headers, k, v);
  setHeaderIfAbsent(headers, "Accept", ACCEPT[responseType]);
  if (config.requestIdHeader) setHeaderIfAbsent(headers, config.requestIdHeader, requestId);
  if (
    (config.idempotency || options.idempotencyKey) &&
    IDEMPOTENCY_METHODS.has(method) &&
    !hasHeader(headers, "Idempotency-Key")
  ) {
    headers["Idempotency-Key"] = options.idempotencyKey ?? generateIdempotencyKey();
  }
  const badHeader = findInvalidHeader(headers);
  if (badHeader) return reject("REQUEST_INVALID", 400, `Invalid header: ${badHeader}`);

  // ── Body ───────────────────────────────────────────────────────
  const keyCase: KeyCase | undefined =
    options.transformKeys === false ? undefined : (options.transformKeys?.request ?? config.transformKeys?.request);
  const compress = config.compressRequest
    ? {
        threshold: (config.compressRequest === true ? undefined : config.compressRequest.threshold) ?? 1024,
        encoding: (config.compressRequest === true ? undefined : config.compressRequest.encoding) ?? "gzip",
      }
    : null;
  const built = await encodeBody({ raw: options.body, method, headers, schema: options.schema, keyCase, compress });
  if (!built.ok) {
    log.warn(`Request body rejected: ${built.code}`, { errors: rt.redact(built.details) as Record<string, unknown> });
    return reject(
      built.code,
      400,
      built.message === "Validation error." ? rt.messages("REQUEST_VALIDATION") : built.message,
      built.details,
    );
  }

  // ── Retry policy ───────────────────────────────────────────────
  let retry: ResolvedRetry;
  if (options.retry === false) retry = { ...rt.retry, limit: 0 };
  else if (options.retry) {
    retry = resolveRetry(
      { ...(options.retryLimit !== undefined ? { limit: options.retryLimit } : {}), ...options.retry },
      rt.retry,
    );
  } else if (options.retryLimit !== undefined) retry = resolveRetry({ limit: options.retryLimit }, rt.retry);
  else retry = rt.retry;
  if (!built.replayable) retry = { ...retry, limit: 0 };

  // ── Cancellation: caller + deadline + engine shutdown ──────────
  // Created last: early returns above must not leave a timer behind.
  const totalTimeoutMs = options.totalTimeoutMs ?? config.totalTimeoutMs ?? 30_000;
  const cancel = rt.cancellations.create().follow(options.signal, "caller").deadline(totalTimeoutMs);

  // ── Keys ───────────────────────────────────────────────────────
  // Only safe, cacheable methods with a body (QUERY) need the body in their key.
  const keyedByBody = !SAFE_METHODS.has(method) && (rt.cacheCfg?.methods.has(method) ?? false);
  const bodyMaterial = keyedByBody ? bodyKeyMaterial(built.body) : undefined;
  const variantBase = rt.fingerprint.variant(options.headers, responseType, config.responseType ?? "auto");
  const variantFp = bodyMaterial === undefined ? variantBase : `${variantBase}.${rt.fingerprint.hash(bodyMaterial, 16)}`;
  const hedgeAllowed = SAFE_METHODS.has(method) && built.replayable && responseType !== "stream";

  return {
    ok: true,
    ctx: {
      options,
      method,
      requestId,
      log,
      elapsed,
      url,
      parsedUrl: parsed,
      relative,
      headers,
      credHeaders,
      usedConfigAuth,
      authRefreshed: false,
      body: built.body,
      replayable: built.replayable,
      responseType,
      retry,
      timeoutMs: options.timeoutMs ?? config.timeoutMs ?? 10_000,
      maxResponseBytes: options.maxResponseBytes ?? config.maxResponseBytes ?? 50 * 1024 * 1024,
      cancel,
      signal: cancel.signal,
      callerSignal: options.signal,
      totalTimeoutMs,
      authFp: rt.fingerprint.credentials(credHeaders),
      variantFp,
      hedge: hedgeAllowed && (options.hedge ?? rt.hedge !== null),
      metricsLabel: options.metricsLabel ?? "",
      state: {},
      attemptHooks: [],
    },
  };
}
