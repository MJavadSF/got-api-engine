// =================================================================
// got-api-engine/next — Next.js Adapter
// Route Handlers (App Router) + Server Actions (RSC)
// =================================================================

import { GotApiEngine } from "../core/engine";
import type {
  EngineConfig,
  RequestOptions,
  ApiResult,
  AuthMode,
  HttpMethod,
  ZodLike,
} from "../types";
import {
  generateRequestId,
  isAuthRequired,
  isAuthOptional,
  isAuthDisabled,
  mergeHeaders,
  sanitizeForwardedFor,
  startTimer,
} from "../utils/helpers";
import { createConsoleLogger } from "../utils/logger";

// Lazy import Next.js to avoid bundling it in non-Next environments
type NextResponseLike = {
  json(body: unknown, init?: { status?: number }): NextResponseLike;
};

async function getNextResponse(): Promise<{
  NextResponse: { json: (body: unknown, init?: ResponseInit) => Response };
}> {
  try {
    return await import("next/server" as string) as any;
  } catch {
    // Fallback for non-Next environments: use standard Response
    return {
      NextResponse: {
        json: (body: unknown, init?: ResponseInit) =>
          new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json" },
            ...init,
          }),
      },
    };
  }
}

// =================================================================
// NEXT.JS ENGINE — extends GotApiEngine with Next-specific methods
// =================================================================

export interface NextRouteHandlerOptions<TBody = unknown> {
  endpoint: string;
  method?: HttpMethod;
  auth?: AuthMode;
  schema?: ZodLike<TBody>;
  timeoutMs?: number;
  retryLimit?: number;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  /** Custom body override (ignores req.body) */
  body?: TBody;
  /** Forward X-Forwarded-For from incoming request */
  forwardClientIp?: boolean;
}

export type ServerActionOptions<TBody = unknown, TResponse = unknown> = Omit<
  RequestOptions<TBody, TResponse>,
  "endpoint" | "method"
> & {
  /** next-auth Session-like object with access_token */
  session?: { access_token?: string; user?: { id?: string } } | null;
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
    const { NextResponse } = await getNextResponse();
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
    } = options;

    const authMode: AuthMode = auth ?? this.config.defaultAuth;
    const requestId = generateRequestId();
    const elapsed = startTimer();
    const log = this.log.child
      ? this.log.child({ requestId })
      : this.log ?? createConsoleLogger("got-api-engine");

    log.info(`[Route] ${method} ${endpoint}`);

    try {
      const headers: Record<string, string> = mergeHeaders(
        { "Cache-Control": "no-store" },
        this.config.defaultHeaders,
        extraHeaders,
      );

      // Forward client IP
      if (forwardClientIp) {
        const xff = sanitizeForwardedFor(req.headers.get("x-forwarded-for"));
        if (xff) headers["x-forwarded-for"] = xff;
      }

      // Auth from incoming request
      if (!isAuthDisabled(authMode)) {
        const incomingToken = req.headers.get("Authorization");
        if (isAuthRequired(authMode) && !incomingToken?.startsWith("Bearer ")) {
          log.warn("[Route] Missing Authorization header");
          return NextResponse.json(
            { error: "Authorization token is required." },
            { status: 401 },
          );
        }
        if (incomingToken?.startsWith("Bearer ") && (isAuthRequired(authMode) || isAuthOptional(authMode))) {
          headers["Authorization"] = incomingToken;
        }
      }

      // Build URL (params handled by request(); query string forwarded for GET)
      let endpointWithQuery = endpoint;
      if (method === "GET") {
        const incoming = new URL(req.url).searchParams;
        if (incoming.toString()) {
          endpointWithQuery += (endpoint.includes("?") ? "&" : "?") + incoming.toString();
        }
      }

      // Parse body
      let requestBody: unknown = undefined;
      const isBodyMethod = ["POST", "PUT", "PATCH"].includes(method);
      const contentType = req.headers.get("Content-Type") ?? "";

      if (customBody !== undefined && isBodyMethod) {
        requestBody = customBody;
      } else if (isBodyMethod && contentType.includes("multipart/form-data")) {
        requestBody = await req.formData();
      } else if (isBodyMethod && contentType.includes("application/json")) {
        try {
          const rawBody = await req.json();
          if (schema) {
            const parsed = schema.safeParse(rawBody);
            if (!parsed.success) {
              log.warn("[Route] Body validation failed");
              return NextResponse.json(
                { error: "Validation error.", details: parsed.error.flatten() },
                { status: 400 },
              );
            }
            requestBody = parsed.data;
          } else {
            requestBody = rawBody;
          }
        } catch {
          return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
        }
      }

      // ── Execute through the resilient core pipeline ────────────
      // (circuit breaker, cache, rate limit, retry, metrics, SSRF)
      // Auth was already resolved from the incoming request above and placed
      // in `headers`, so disable engine-side auth resolution to avoid override.
      const result = await this.request<unknown>({
        endpoint: endpointWithQuery,
        method,
        auth: false,
        ...(requestBody !== undefined ? { body: requestBody as never } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(retryLimit !== undefined ? { retry: { limit: retryLimit } } : {}),
        ...(params ? { params } : {}),
        headers,
        signal: req.signal,
      });

      const durationMs = elapsed();

      if (!result.ok) {
        log.error(`[Route] Failed: ${result.status}`, { url: endpoint, durationMs });
        return NextResponse.json(
          { error: result.error, ...(result.details ? { details: result.details } : {}) },
          { status: result.status },
        );
      }

      log.info(`[Route] OK ${result.status} (${durationMs}ms)`);
      return NextResponse.json(result.data, { status: result.status });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || (error as any).code === "ABORT_ERR")
      ) {
        return NextResponse.json({ error: "Request aborted." }, { status: 499 });
      }
      const msg = error instanceof Error ? error.message : "Internal server error.";
      log.error(`[Route] Exception: ${msg}`);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // ── Server Action proxy (RSC / Server Components) ────────────
  async serverAction<TResponse = unknown, TBody = unknown>(
    method: HttpMethod,
    endpoint: string,
    options?: ServerActionOptions<TBody, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    const { session, ...reqOpts } = options ?? {};

    // If session is provided, inject the token
    let authToken = reqOpts.authToken;
    if (!authToken && session?.access_token) {
      authToken = session.access_token;
    }

    return this.request<TResponse, TBody>({
      ...reqOpts,
      endpoint,
      method,
      authToken,
    });
  }

  // ── Shorthand server actions ──────────────────────────────────

  serverGet<TResponse = unknown>(
    endpoint: string,
    options?: ServerActionOptions<never, TResponse>,
  ) {
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

  serverDelete<TResponse = unknown>(
    endpoint: string,
    options?: ServerActionOptions<never, TResponse>,
  ) {
    return this.serverAction<TResponse, never>("DELETE", endpoint, options);
  }

  // ── Build route handler set (like the original `api` object) ──
  buildRouteHandlers() {
    const self = this;
    return {
      GET: (req: Request, endpoint: string, auth?: AuthMode) =>
        self.handleRoute(req, { endpoint, method: "GET", auth }),

      POST: <TBody = unknown>(req: Request, opts: Omit<NextRouteHandlerOptions<TBody>, "method">) =>
        self.handleRoute<TBody>(req, { ...opts, method: "POST" }),

      PUT: <TBody = unknown>(req: Request, opts: Omit<NextRouteHandlerOptions<TBody>, "method">) =>
        self.handleRoute<TBody>(req, { ...opts, method: "PUT" }),

      PATCH: <TBody = unknown>(req: Request, opts: Omit<NextRouteHandlerOptions<TBody>, "method">) =>
        self.handleRoute<TBody>(req, { ...opts, method: "PATCH" }),

      DELETE: (req: Request, endpoint: string, auth?: AuthMode) =>
        self.handleRoute(req, { endpoint, method: "DELETE", auth }),
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────
export function createNextEngine(config: EngineConfig): NextApiEngine {
  return new NextApiEngine(config);
}

// Re-export core types for convenience
export type { EngineConfig, RequestOptions, ApiResult, AuthMode };
