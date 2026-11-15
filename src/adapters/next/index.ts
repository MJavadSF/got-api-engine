/**
 * Next.js App Router integration: Route Handler proxy, catch-all BFF, Server Actions.
 *
 * @packageDocumentation
 * @module got-api-engine/next
 */
// ── got-api-engine/next ──────────────────────────────────────────

export type { ApiResult, AuthMode, EngineConfig, RequestOptions } from "../../types/index";
export type { ServerActionOptions } from "./engine";
export { createNextEngine, NextApiEngine } from "./engine";
export type { FormState } from "./form";
export { formDataToObject, toFormState } from "./form";
export { passesCsrf, readCookie } from "./incoming";
export type { ProxyHandler, ProxyOptions, ProxyRule } from "./proxy";
export { createProxy, globToRegExp } from "./proxy";
export type { CookieAuthOptions, CsrfOptions, NextRouteHandlerOptions } from "./types";
