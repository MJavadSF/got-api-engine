// =================================================================
// got-api-engine/next — Next.js Adapter
// Route Handlers (App Router) + Server Actions (RSC)
//
// Uses only the standard Web `Response` — no runtime dependency on
// `next/server`, so it works with any Next.js version (13 → 16), the Edge-free
// Node runtime, and other Web-standard frameworks.
// =================================================================

import { GotApiEngine } from "../core/engine";
import type {
  ApiResult,
  AuthMode,
  EngineConfig,
  ErrorResult,
  HttpMethod,
  ParamValue,
  RequestOptions,
  ResponseType,
  ZodLike,
} from "../types";
import {
  generateRequestId,
  getHeader,
  isAuthDisabled,
  isAuthOptional,
  isAuthRequired,
  mergeHeaders,
  sanitizeForwardedFor,
  sanitizeRequestId,
  schemaErrorDetails,
  startTimer,
  setHeader,
} from "../utils/helpers";

const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE", "QUERY"]);
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304]);
const DEFAULT_FORWARD_HEADERS = ["content-disposition", "content-language", "etag", "last-modified", "retry-after"];

export interface NextRouteHandlerOptions<TBody = unknown> {
  endpoint: string;
  method?: HttpMethod;
  auth?: AuthMode;
  schema?: ZodLike<TBody>;
  timeoutMs?: number;
  retryLimit?: number;
  headers?: Record<string, string>;
  params?: Record<string, ParamValue>;
  /** Custom body override (ignores req.body) */
  body?: TBody;
  /** Forward X-Forwarded-For from the incoming request. @default true */
  forwardClientIp?: boolean;
  /** How to decode the upstream response. @default engine default ("auto") */
  responseType?: ResponseType;
  /**
   * Upstream response headers copied to the client (case-insensitive).
   * `false` forwards none. `Set-Cookie` is never forwarded unless listed.
   * @default content-disposition, content-language, etag, last-modified, retry-after
   */
  forwardResponseHeaders?: string[] | false;
  /**
   * Include the upstream error body (`details`) in error responses.
   * @default true for 4xx, false for 5xx (avoids leaking backend internals)
   */
  exposeUpstreamDetails?: boolean;
  /**
   * If the incoming request has no `Authorization` header, authenticate with
   * the engine's own `auth` (service credentials). Off by default: enabling it
   * lets unauthenticated clients act with the engine's credentials.
   * @default false
   */
  useEngineAuth?: boolean;
  /** Forward the query string of the incoming request. @default true */
  forwardQuery?: boolean;
}

export type ServerActionOptions<TBody = unknown, TResponse = unknown> = Omit<
  RequestOptions<TBody, TResponse>,
  "endpoint" | "method"
> & {
  /** next-auth / Auth.js session-like object carrying an access token */
  session?: { access_token?: string; accessToken?: string; user?: { id?: string } } | null;
};

export class NextApiEngine extends GotApiEngine {
  constructor(config: EngineConfig) {
    super(config);
  }

  // ── Route Handler proxy (App Router) ─────────────────────────
  async handleRoute<TBody = unknown>(
    req: Request,
    options: NextRouteHandlerOptions<TBody>,
  ): Promise<Response> {
    const {
      endpoint,
      method = "GET",
      auth,
      schema,
      timeoutMs,
      retryLimit,
      headers: extraHeaders,
      params,
      body: customBody,
      forwardClientIp = true,
      forwardQuery = true,
      responseType,
      useEngineAuth = false,
    } = options;

    const authMode: AuthMode = auth ?? this.config.defaultAuth;
    const requestId =
      sanitizeRequestId(req.headers.get("x-request-id")) ?? generateRequestId();
    const elapsed = startTimer();
    const log = this.log.child ? this.log.child({ requestId }) : this.log;

    const respond = (body: unknown, status: number): Response =>
      jsonResponse(body, status, requestId);

    log.info(`[Route] ${method} ${endpoint}`);

    try {
      const headers: Record<string, string> = mergeHeaders(
        { "Cache-Control": "no-store" },
        this.config.defaultHeaders,
        extraHeaders,
      );

      if (forwardClientIp) {
        const xff = sanitizeForwardedFor(req.headers.get("x-forwarded-for"));
        if (xff) setHeader(headers, "x-forwarded-for", xff);
      }

      // ── Auth: forward the caller's credentials ────────────────
      let engineAuthMode: AuthMode = false;
      if (!isAuthDisabled(authMode)) {
        const incoming = req.headers.get("Authorization")?.trim();
        if (incoming) {
          setHeader(headers, "Authorization", incoming);
        } else if (useEngineAuth && this.config.auth !== undefined) {
          engineAuthMode = authMode; // let the engine resolve service credentials
        } else if (isAuthRequired(authMode)) {
          log.warn("[Route] Missing Authorization header");
          return respond({ error: "Authorization token is required." }, 401);
        } else if (!isAuthOptional(authMode)) {
          return respond({ error: "Authorization token is required." }, 401);
        }
      }

      // ── Query string ──────────────────────────────────────────
      let endpointWithQuery = endpoint;
      if (forwardQuery) {
        const incomingQuery = new URL(req.url).searchParams.toString();
        if (incomingQuery) endpointWithQuery += (endpoint.includes("?") ? "&" : "?") + incomingQuery;
      }

      // ── Body ──────────────────────────────────────────────────
      let requestBody: unknown = undefined;
      const isBodyMethod = BODY_METHODS.has(method);
      const contentType = req.headers.get("Content-Type") ?? "";

      if (customBody !== undefined && isBodyMethod) {
        requestBody = customBody;
      } else if (isBodyMethod && req.body !== null) {
        if (contentType.includes("multipart/form-data")) {
          requestBody = await req.formData();
        } else if (/[/+]json/i.test(contentType)) {
          const text = await req.text();
          if (text.trim() !== "") {
            let rawBody: unknown;
            try {
              rawBody = JSON.parse(text);
            } catch {
              return respond({ error: "Invalid JSON body." }, 400);
            }
            if (schema) {
              const parsed = schema.safeParse(rawBody);
              if (!parsed.success) {
                log.warn("[Route] Body validation failed");
                return respond(
                  { error: "Validation error.", details: schemaErrorDetails(parsed.error) },
                  400,
                );
              }
              requestBody = parsed.data;
            } else {
              requestBody = rawBody;
            }
          }
        } else {
          // Any other payload (text, form-urlencoded, octet-stream…) is proxied verbatim.
          const buf = Buffer.from(await req.arrayBuffer());
          if (buf.length > 0) {
            requestBody = buf;
            if (contentType) setHeader(headers, "Content-Type", contentType);
          }
        }
      }

      // ── Execute through the resilient core pipeline ───────────
      const result = await this.request<unknown>({
        endpoint: endpointWithQuery,
        method,
        auth: engineAuthMode,
        requestId,
        ...(requestBody !== undefined ? { body: requestBody as never } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(retryLimit !== undefined ? { retryLimit } : {}),
        ...(responseType ? { responseType } : {}),
        ...(params ? { params } : {}),
        headers,
        signal: req.signal,
      });

      const durationMs = elapsed();

      if (!result.ok) {
        log.error(`[Route] Failed: ${result.status}`, { url: endpoint, durationMs });
        return this.errorResponse(result, options, requestId);
      }

      log.info(`[Route] OK ${result.status} (${durationMs}ms)`);
      return this.successResponse(result, options, requestId);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || (error as { code?: string }).code === "ABORT_ERR")
      ) {
        return respond({ error: "Request aborted." }, 499);
      }
      const msg = error instanceof Error ? error.message : "Internal server error.";
      log.error(`[Route] Exception: ${msg}`);
      return respond({ error: msg }, 500);
    }
  }

  private errorResponse(
    result: ErrorResult,
    options: NextRouteHandlerOptions<never> | NextRouteHandlerOptions<unknown>,
    requestId: string,
  ): Response {
    const expose =
      options.exposeUpstreamDetails ??
      (result.code !== "HTTP_ERROR" || result.status < 500);
    const payload: Record<string, unknown> = { error: result.error };
    if (expose && result.details !== undefined) payload["details"] = result.details;
    if (result.code) payload["code"] = result.code;

    const res = jsonResponse(payload, result.status, requestId);
    const retryAfter = result.meta?.retryAfterMs;
    if (retryAfter !== undefined) res.headers.set("Retry-After", String(Math.ceil(retryAfter / 1000)));
    return res;
  }

  private successResponse(
    result: Extract<ApiResult<unknown>, { ok: true }>,
    options: NextRouteHandlerOptions<never> | NextRouteHandlerOptions<unknown>,
    requestId: string,
  ): Response {
    const { status, data, headers: upstream = {} } = result;
    const out = new Headers();
    out.set("X-Request-Id", requestId);

    const allow =
      options.forwardResponseHeaders === false
        ? []
        : (options.forwardResponseHeaders ?? DEFAULT_FORWARD_HEADERS);
    for (const name of allow) {
      const v = getHeader(upstream, name);
      if (v !== undefined) out.set(name, v);
    }

    if (NULL_BODY_STATUS.has(status)) return new Response(null, { status, headers: out });

    if (Buffer.isBuffer(data)) {
      out.set("Content-Type", getHeader(upstream, "content-type") ?? "application/octet-stream");
      return new Response(new Uint8Array(data), { status, headers: out });
    }
    if (typeof data === "string") {
      out.set("Content-Type", getHeader(upstream, "content-type") ?? "text/plain; charset=utf-8");
      return new Response(data, { status, headers: out });
    }
    out.set("Content-Type", "application/json");
    return new Response(JSON.stringify(data ?? null), { status, headers: out });
  }

  // ── Server Action proxy (RSC / Server Components) ────────────
  async serverAction<TResponse = unknown, TBody = unknown>(
    method: HttpMethod,
    endpoint: string,
    options?: ServerActionOptions<TBody, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    const { session, ...reqOpts } = options ?? {};

    // If a session is provided, inject its token
    const sessionToken = session?.access_token ?? session?.accessToken;
    const authToken = reqOpts.authToken ?? sessionToken;

    return this.request<TResponse, TBody>({
      ...reqOpts,
      endpoint,
      method,
      ...(authToken ? { authToken } : {}),
    });
  }

  // ── Shorthand server actions ──────────────────────────────────

  serverGet<TResponse = unknown>(endpoint: string, options?: ServerActionOptions<never, TResponse>) {
    return this.serverAction<TResponse, never>("GET", endpoint, options);
  }

  serverPost<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: ServerActionOptions<TBody, TResponse>,
  ) {
    return this.serverAction<TResponse, TBody>("POST", endpoint, { ...options, body });
  }

  serverPut<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: ServerActionOptions<TBody, TResponse>,
  ) {
    return this.serverAction<TResponse, TBody>("PUT", endpoint, { ...options, body });
  }

  serverPatch<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: ServerActionOptions<TBody, TResponse>,
  ) {
    return this.serverAction<TResponse, TBody>("PATCH", endpoint, { ...options, body });
  }

  serverDelete<TResponse = unknown>(endpoint: string, options?: ServerActionOptions<never, TResponse>) {
    return this.serverAction<TResponse, never>("DELETE", endpoint, options);
  }

  // ── Build route handler set ───────────────────────────────────
  buildRouteHandlers() {
    return {
      GET: (req: Request, endpoint: string, auth?: AuthMode) =>
        this.handleRoute(req, { endpoint, method: "GET", ...(auth !== undefined ? { auth } : {}) }),

      POST: <TBody = unknown>(req: Request, opts: Omit<NextRouteHandlerOptions<TBody>, "method">) =>
        this.handleRoute<TBody>(req, { ...opts, method: "POST" }),

      PUT: <TBody = unknown>(req: Request, opts: Omit<NextRouteHandlerOptions<TBody>, "method">) =>
        this.handleRoute<TBody>(req, { ...opts, method: "PUT" }),

      PATCH: <TBody = unknown>(req: Request, opts: Omit<NextRouteHandlerOptions<TBody>, "method">) =>
        this.handleRoute<TBody>(req, { ...opts, method: "PATCH" }),

      DELETE: (req: Request, endpoint: string, auth?: AuthMode) =>
        this.handleRoute(req, { endpoint, method: "DELETE", ...(auth !== undefined ? { auth } : {}) }),
    };
  }
}

function jsonResponse(body: unknown, status: number, requestId: string): Response {
  const headers = new Headers({ "Content-Type": "application/json", "X-Request-Id": requestId });
  if (NULL_BODY_STATUS.has(status)) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers });
}

// ── Factory ───────────────────────────────────────────────────────
export function createNextEngine(config: EngineConfig): NextApiEngine {
  return new NextApiEngine(config);
}

// Re-export core types for convenience
export type { EngineConfig, RequestOptions, ApiResult, AuthMode };
