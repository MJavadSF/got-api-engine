// ── NextApiEngine: Route Handlers + Server Actions ───────────────
//
// Uses only the standard Web `Request` / `Response` — no runtime dependency
// on `next`, so it works with Next.js 13 → 16 and other Web-standard servers
// (Node runtime; got does not run on the Edge runtime).

import { isAuthDisabled, isAuthOptional } from "../../auth/normalize";
import { BODY_METHODS } from "../../core/constants";
import { GotApiEngine } from "../../core/engine";
import { mergeHeaders, setHeader } from "../../http/headers";
import { generateRequestId, sanitizeForwardedFor, sanitizeRequestId, startTimer } from "../../http/misc";
import type { AuthMode, HttpMethod } from "../../types/http";
import type { RequestOptions } from "../../types/request";
import type { ApiResult } from "../../types/result";
import { type FormState, formDataToObject, toFormState } from "./form";
import { authorizationFromCookie, DEFAULT_MAX_BODY, passesCsrf, readIncomingBody } from "./incoming";
import { errorResponse, jsonResponse, successResponse } from "./outgoing";
import type { NextRouteHandlerOptions } from "./types";

export type ServerActionOptions<TBody = unknown, TResponse = unknown> = Omit<
  RequestOptions<TBody, TResponse>,
  "endpoint" | "method"
> & {
  /** Auth.js session-like object carrying an access token. */
  session?: { access_token?: string; accessToken?: string; user?: { id?: string } } | null;
};

export class NextApiEngine extends GotApiEngine {
  // ── Route Handler proxy (App Router) ───────────────────────────
  async handleRoute<TBody = unknown>(req: Request, options: NextRouteHandlerOptions<TBody>): Promise<Response> {
    const { endpoint, method = "GET", forwardQuery = true, useEngineAuth = false } = options;
    const authMode: AuthMode = options.auth ?? this.config.defaultAuth ?? true;
    const requestId = sanitizeRequestId(req.headers.get("x-request-id")) ?? generateRequestId();
    const elapsed = startTimer();
    const log = this.log.child ? this.log.child({ requestId }) : this.log;
    const messages = this.rt.messages;
    const respond = (body: unknown, status: number): Response => jsonResponse(body, status, requestId);

    log.debug(`[Route] ${method} ${endpoint}`);

    try {
      if (options.csrf && !passesCsrf(req, method, options.csrf)) {
        log.warn("[Route] CSRF check failed");
        return respond({ error: "Cross-site request blocked.", code: "CSRF_BLOCKED" }, 403);
      }

      const headers = mergeHeaders(options.headers);
      for (const name of options.forwardRequestHeaders ?? []) {
        const v = req.headers.get(name);
        if (v !== null) setHeader(headers, name, v);
      }
      if (options.forwardClientIp) {
        const xff = sanitizeForwardedFor(req.headers.get("x-forwarded-for"));
        if (xff) setHeader(headers, "x-forwarded-for", xff);
      }

      // ── Auth: forward the caller's credentials ───────────────
      let engineAuthMode: AuthMode = false;
      if (!isAuthDisabled(authMode)) {
        const incoming =
          req.headers.get("authorization")?.trim() ||
          (options.cookieAuth ? authorizationFromCookie(req, options.cookieAuth) : undefined);
        if (incoming) setHeader(headers, "Authorization", incoming);
        else if (useEngineAuth && this.config.auth !== undefined) engineAuthMode = authMode;
        else if (!isAuthOptional(authMode)) {
          log.warn("[Route] Missing credentials");
          return respond({ error: messages("AUTH_REQUIRED"), code: "AUTH_REQUIRED" }, 401);
        }
      }

      // ── Query string ─────────────────────────────────────────
      let target = endpoint;
      if (forwardQuery) {
        const q = new URL(req.url).searchParams.toString();
        if (q) target += (endpoint.includes("?") ? "&" : "?") + q;
      }

      // ── Body ─────────────────────────────────────────────────
      let body: unknown;
      if (BODY_METHODS.has(method)) {
        if (options.body !== undefined) body = options.body;
        else {
          const incoming = await readIncomingBody(req, options.schema, options.maxBodyBytes ?? DEFAULT_MAX_BODY);
          if (!incoming.ok) {
            log.warn(`[Route] Body rejected (${incoming.status})`);
            return respond(
              { error: incoming.error, ...(incoming.details !== undefined ? { details: incoming.details } : {}) },
              incoming.status,
            );
          }
          body = incoming.body;
          if (incoming.contentType) setHeader(headers, "Content-Type", incoming.contentType);
        }
      }

      const result = await this.request<unknown>({
        ...options.requestOptions,
        endpoint: target,
        method,
        auth: engineAuthMode,
        requestId,
        headers: mergeHeaders(options.requestOptions?.headers, headers),
        signal: req.signal,
        throwOnError: false,
        ...(body !== undefined ? { body: body as never } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.retryLimit !== undefined ? { retryLimit: options.retryLimit } : {}),
        ...(options.responseType ? { responseType: options.responseType } : {}),
        ...(options.params ? { params: options.params } : {}),
      });

      const durationMs = elapsed();
      if (!result.ok) {
        log[result.status >= 500 ? "error" : "warn"](`[Route] ${method} ${endpoint} → ${result.status}`, {
          code: result.code,
          durationMs,
        });
        return errorResponse(result, options, requestId, messages);
      }
      log.debug(`[Route] ${method} ${endpoint} → ${result.status} (${durationMs}ms)`);
      return successResponse(result, options, requestId);
    } catch (error: unknown) {
      if (error instanceof Error && (error.name === "AbortError" || (error as { code?: string }).code === "ABORT_ERR")) {
        return respond({ error: messages("ABORTED"), code: "ABORTED" }, 499);
      }
      log.error(`[Route] Exception: ${error instanceof Error ? error.message : String(error)}`);
      return respond({ error: messages("INTERNAL_ERROR"), code: "INTERNAL_ERROR" }, 500);
    }
  }

  // ── Server Actions / Server Components ────────────────────────
  serverAction<TResponse = unknown, TBody = unknown>(
    method: HttpMethod,
    endpoint: string,
    options?: ServerActionOptions<TBody, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    const { session, ...reqOpts } = options ?? {};
    const authToken = reqOpts.authToken ?? session?.access_token ?? session?.accessToken;
    return this.request<TResponse, TBody>({ ...reqOpts, endpoint, method, ...(authToken ? { authToken } : {}) });
  }

  serverGet<TResponse = unknown>(endpoint: string, options?: ServerActionOptions<never, TResponse>) {
    return this.serverAction<TResponse, never>("GET", endpoint, options);
  }

  serverPost<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: ServerActionOptions<TBody, TResponse>,
  ) {
    return this.serverAction<TResponse, TBody>("POST", endpoint, { ...options, ...(body !== undefined ? { body } : {}) });
  }

  serverPut<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: ServerActionOptions<TBody, TResponse>,
  ) {
    return this.serverAction<TResponse, TBody>("PUT", endpoint, { ...options, ...(body !== undefined ? { body } : {}) });
  }

  serverPatch<TResponse = unknown, TBody = unknown>(
    endpoint: string,
    body?: TBody,
    options?: ServerActionOptions<TBody, TResponse>,
  ) {
    return this.serverAction<TResponse, TBody>("PATCH", endpoint, { ...options, ...(body !== undefined ? { body } : {}) });
  }

  serverDelete<TResponse = unknown>(endpoint: string, options?: ServerActionOptions<never, TResponse>) {
    return this.serverAction<TResponse, never>("DELETE", endpoint, options);
  }

  /**
   * Submit a form from a Server Action and get `useActionState`-ready state
   * (field errors from Zod / Standard Schema included).
   */
  async serverForm<TResponse = unknown>(
    method: HttpMethod,
    endpoint: string,
    form: FormData | Record<string, unknown>,
    options?: ServerActionOptions<unknown, TResponse>,
  ): Promise<FormState<TResponse>> {
    const body = form instanceof FormData ? formDataToObject(form) : form;
    const result = await this.serverAction<TResponse, unknown>(method, endpoint, { ...options, body, throwOnError: false });
    return toFormState(result);
  }

  /** Thin per-method route handlers. */
  buildRouteHandlers() {
    const route =
      (method: HttpMethod) =>
      <TBody = unknown>(req: Request, opts: string | Omit<NextRouteHandlerOptions<TBody>, "method">, auth?: AuthMode) =>
        this.handleRoute<TBody>(
          req,
          typeof opts === "string" ? { endpoint: opts, method, ...(auth !== undefined ? { auth } : {}) } : { ...opts, method },
        );
    return { GET: route("GET"), POST: route("POST"), PUT: route("PUT"), PATCH: route("PATCH"), DELETE: route("DELETE") };
  }
}

export function createNextEngine(config: ConstructorParameters<typeof GotApiEngine>[0]): NextApiEngine {
  return new NextApiEngine(config);
}
