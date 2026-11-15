import type { HttpMethod } from "./http";

export type MaybePromise<T> = T | Promise<T>;

export interface AuthProvider {
  /**
   * Authorization header value ("Bearer …", "Basic …") or null when no
   * credentials are available. A bare token is treated as Bearer.
   */
  getAuthHeader(): MaybePromise<string | null | undefined>;
  /** Additional / alternative credential headers, e.g. `{ "X-API-Key": "…" }`. */
  getHeaders?(): MaybePromise<Record<string, string> | null | undefined>;
  /**
   * Force a fresh credential. When present (and no `refreshAuth` is
   * configured) the engine calls it after an upstream 401 and replays once.
   */
  refreshNow?(): MaybePromise<unknown>;
}

export type AuthSource = string | (() => MaybePromise<string | null | undefined>) | AuthProvider;

export interface RefreshAuthContext {
  url: string;
  method: HttpMethod;
  requestId: string;
}

/**
 * Called single-flight after an upstream 401 on a request that used the
 * engine's `auth`. Return a new token, or nothing if your `auth` source now
 * yields the fresh credential by itself. The request is then replayed once.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: hooks may return nothing (`async () => { … }`).
export type RefreshAuthHook = (ctx: RefreshAuthContext) => MaybePromise<string | null | undefined | void>;
