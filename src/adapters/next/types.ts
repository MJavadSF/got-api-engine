import type { AuthMode, HttpMethod, ParamValue, ResponseType } from "../../types/http";
import type { RequestOptions } from "../../types/request";
import type { ErrorResult } from "../../types/result";
import type { Schema } from "../../types/schema";

export interface CookieAuthOptions {
  /** Cookie holding the access token. */
  name: string;
  /** @default "Bearer" */
  scheme?: string;
}

export interface CsrfOptions {
  /** Extra origins allowed to call unsafe methods (the app's own origin always is). */
  allowedOrigins?: string[];
}

export interface NextRouteHandlerOptions<TBody = unknown> {
  endpoint: string;
  method?: HttpMethod;
  auth?: AuthMode;
  schema?: Schema<TBody>;
  timeoutMs?: number;
  retryLimit?: number;
  headers?: Record<string, string>;
  params?: Record<string, ParamValue>;
  /** Custom body (ignores the incoming body). */
  body?: TBody;
  /** Forward the incoming query string. @default true */
  forwardQuery?: boolean;
  /** `"stream"` pipes the upstream body through (SSE, downloads, LLM streams). */
  responseType?: ResponseType;
  /**
   * Forward `X-Forwarded-For`. Only enable behind a proxy you trust: the
   * header is client-controlled otherwise. @default false
   */
  forwardClientIp?: boolean;
  /** Incoming request headers to forward (case-insensitive), e.g. `["accept-language"]`. */
  forwardRequestHeaders?: string[];
  /**
   * Upstream response headers copied to the client. `false` forwards none.
   * `Set-Cookie` is only forwarded when listed.
   * @default content-disposition, content-language, etag, last-modified, retry-after, cache-control
   */
  forwardResponseHeaders?: string[] | false;
  /**
   * Include `details` in error responses.
   * @default true for upstream 4xx and request validation; false otherwise
   */
  exposeUpstreamDetails?: boolean;
  /** Fully custom error mapping. */
  mapError?: (error: ErrorResult) => Response | { status: number; body: unknown };
  /**
   * Authenticate with the engine's own `auth` when the caller sent no
   * credentials. Lets unauthenticated clients act as the service. @default false
   */
  useEngineAuth?: boolean;
  /** Read the access token from an httpOnly cookie when no `Authorization` header is present. */
  cookieAuth?: CookieAuthOptions;
  /** Origin check for unsafe methods (POST/PUT/PATCH/DELETE). */
  csrf?: boolean | CsrfOptions;
  /** Max incoming body size in bytes. @default 10 MiB */
  maxBodyBytes?: number;
  /** Extra engine request options (cache, invalidateTags, fallback, …). */
  requestOptions?: Omit<RequestOptions<TBody, unknown>, "endpoint" | "method" | "body" | "signal">;
}
