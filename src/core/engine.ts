// =================================================================
// got-api-engine — Core Engine
// =================================================================

import got, { type Got } from "got";
import https from "https";

import type {
  EngineConfig,
  RequestOptions,
  ApiResult,
  HttpMethod,
  LoggerInterface,
  AuthMode,
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
} from "../utils/helpers";

import { createConsoleLogger } from "../utils/logger";

// ── Retryable HTTP methods ───────────────────────────────────────
const RETRYABLE_METHODS: HttpMethod[] = ["GET", "PUT"];
const BODY_METHODS: HttpMethod[] = ["POST", "PUT", "PATCH"];

// =================================================================
// ENGINE CLASS
// =================================================================

export class GotApiEngine {
  private readonly config: Required<
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

  private readonly httpClient: Got;
  private readonly log: LoggerInterface;

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

    this.log = config.logger ?? createConsoleLogger(this.config.serviceName, this.config.debug);

    this.httpClient = got.extend({
      agent: {
        https: new https.Agent({
          keepAlive: true,
          rejectUnauthorized: this.config.rejectUnauthorized,
        }),
      },
      headers: {
        "Cache-Control": "no-store",
        ...this.config.defaultHeaders,
      },
      responseType: "json",
      retry: {
        limit: this.config.retryLimit,
        methods: RETRYABLE_METHODS,
      },
      timeout: { request: this.config.timeoutMs },
      throwHttpErrors: false,
    });
  }

  // ── Public: make a request ────────────────────────────────────
  async request<TResponse = unknown, TBody = unknown>(
    options: RequestOptions<TBody, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    const {
      endpoint,
      method = "GET",
      body: customBody,
      schema,
      responseSchema,
      timeoutMs,
      retryLimit,
      headers: extraHeaders,
      params,
      authToken: overrideToken,
    } = options;

    const authMode: AuthMode = options.auth ?? this.config.defaultAuth;
    const requestId = generateRequestId();
    const elapsed = startTimer();

    const log = this.log.child
      ? this.log.child({ requestId })
      : this.log;

    log.debug(`→ ${method} ${endpoint}`, { authMode });

    try {
      // ── Build headers ──────────────────────────────────────────
      const headers: Record<string, string> = mergeHeaders(
        { "Cache-Control": "no-store" },
        this.config.defaultHeaders,
        extraHeaders,
      );

      // ── Auth resolution ────────────────────────────────────────
      if (!isAuthDisabled(authMode)) {
        const authHeader = await resolveAuthHeader(
          { auth: this.config.auth },
          overrideToken,
        );

        if (isAuthRequired(authMode) && !authHeader) {
          log.warn("Auth required but no token available");
          return {
            ok: false,
            error: "Authorization token is required.",
            status: 401,
          };
        }

        if (authHeader && (isAuthRequired(authMode) || isAuthOptional(authMode))) {
          headers["Authorization"] = authHeader;
        }
      }

      // ── Build URL + params ─────────────────────────────────────
      let fullUrl = buildUrl(endpoint, this.config.baseUrl);
      if (params) fullUrl = appendParams(fullUrl, params);

      // ── Build request body ─────────────────────────────────────
      const requestOpts: Record<string, unknown> = {
        headers,
        method,
        retry: {
          limit: retryLimit ?? this.config.retryLimit,
          methods: RETRYABLE_METHODS,
        },
        timeout: { request: timeoutMs ?? this.config.timeoutMs },
        throwHttpErrors: false,
      };

      if (customBody !== undefined && BODY_METHODS.includes(method)) {
        if (customBody instanceof FormData) {
          requestOpts.body = customBody as any;
        } else if (schema) {
          const parsed = schema.safeParse(customBody);
          if (!parsed.success) {
            log.warn("Request body validation failed", {
              errors: parsed.error.flatten() as Record<string, unknown>,
            });
            return {
              ok: false,
              error: "Validation error.",
              status: 400,
              details: parsed.error.flatten(),
            };
          }
          requestOpts.json = parsed.data as Record<string, unknown>;
          headers["Content-Type"] = "application/json";
        } else if (typeof customBody === "object") {
          requestOpts.json = customBody as Record<string, unknown>;
          headers["Content-Type"] = "application/json";
        } else {
          requestOpts.body = String(customBody);
        }
      }

      // ── Lifecycle: onRequest hooks ─────────────────────────────
      if (this.config.hooks?.onRequest) {
        const hooks = Array.isArray(this.config.hooks.onRequest)
          ? this.config.hooks.onRequest
          : [this.config.hooks.onRequest];
        for (const hook of hooks) {
          await hook({ url: fullUrl, method, headers, body: customBody });
        }
      }

      log.debug(`Calling: ${fullUrl}`);

      // ── Execute request ────────────────────────────────────────
      const response = await (this.httpClient as any)(fullUrl, { ...requestOpts, responseType: "json" }) as { statusCode: number; body: unknown; headers: Record<string, string> };
      const durationMs = elapsed();

      // ── Lifecycle: onResponse hooks ────────────────────────────
      if (this.config.hooks?.onResponse) {
        const hooks = Array.isArray(this.config.hooks.onResponse)
          ? this.config.hooks.onResponse
          : [this.config.hooks.onResponse];
        for (const hook of hooks) {
          await hook({
            url: fullUrl,
            method,
            status: response.statusCode,
            body: response.body,
            durationMs,
          });
        }
      }

      // ── Error status ───────────────────────────────────────────
      if (response.statusCode >= 400) {
        const errorMessage = parseApiError(response.body);
        log.error(`Request failed`, {
          url: fullUrl,
          status: response.statusCode,
          durationMs,
        });
        return {
          ok: false,
          error: errorMessage,
          status: response.statusCode,
        };
      }

      // ── Response validation (optional) ─────────────────────────
      let data = response.body as TResponse;
      if (responseSchema) {
        const parsed = responseSchema.safeParse(response.body);
        if (!parsed.success) {
          log.warn("Response validation failed", {
            errors: parsed.error.flatten() as Record<string, unknown>,
          });
          return {
            ok: false,
            error: "Response validation error.",
            status: 502,
            details: parsed.error.flatten(),
          };
        }
        data = parsed.data;
      }

      log.info(`✓ ${method} ${endpoint} → ${response.statusCode} (${durationMs}ms)`);

      return {
        ok: true,
        data,
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
      };
    } catch (error: unknown) {
      const durationMs = elapsed();

      // ── Lifecycle: onError hooks ───────────────────────────────
      if (this.config.hooks?.onError) {
        const hooks = Array.isArray(this.config.hooks.onError)
          ? this.config.hooks.onError
          : [this.config.hooks.onError];
        for (const hook of hooks) {
          await hook({ url: endpoint, method, error, durationMs });
        }
      }

      // Abort
      if (
        error instanceof Error &&
        (error.name === "AbortError" || (error as any).code === "ABORT_ERR")
      ) {
        log.warn("Request aborted by client", { durationMs });
        return { ok: false, error: "Request aborted.", status: 499 };
      }

      const message =
        error instanceof Error ? error.message : "An internal error occurred.";

      log.error(`Proxy error: ${message}`, {
        err: error instanceof Error
          ? { name: error.name, message: error.message, code: (error as any).code }
          : undefined,
        durationMs,
      });

      return { ok: false, error: message, status: 500 };
    }
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
    return new GotApiEngine({
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
    });
  }
}

// ── Factory function ─────────────────────────────────────────────
export function createEngine(config: EngineConfig): GotApiEngine {
  return new GotApiEngine(config);
}
