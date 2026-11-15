// ── Credential resolution + single-flight refresh after 401 ──────

import { getHeader, setHeader } from "../http/headers";
import type { AuthProvider, AuthSource, RefreshAuthContext, RefreshAuthHook } from "../types/auth";
import type { HeaderMap } from "../types/http";
import { normalizeAuthorization } from "./normalize";

export class CredentialManager {
  /** Authorization override set by `refreshAuth` (other provider headers are kept). */
  private override: string | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly auth: AuthSource | undefined,
    private readonly refreshAuth: RefreshAuthHook | undefined,
    private readonly onRefresh: () => void = () => {},
  ) {}

  get configured(): boolean {
    return this.auth !== undefined || this.override !== null;
  }

  /** Can a 401 be recovered by refreshing? */
  get refreshable(): boolean {
    return Boolean(this.refreshAuth) || typeof (this.auth as AuthProvider | undefined)?.refreshNow === "function";
  }

  async resolve(): Promise<HeaderMap> {
    const headers = await this.fromSource();
    if (this.override) setHeader(headers, "Authorization", this.override);
    return headers;
  }

  private async fromSource(): Promise<HeaderMap> {
    const headers: HeaderMap = {};
    const auth = this.auth;
    if (!auth) return headers;
    if (typeof auth === "string") {
      if (auth) headers["Authorization"] = normalizeAuthorization(auth);
      return headers;
    }
    if (typeof auth === "function") {
      const token = await auth();
      if (token) headers["Authorization"] = normalizeAuthorization(token);
      return headers;
    }
    const value = await auth.getAuthHeader();
    if (value) headers["Authorization"] = normalizeAuthorization(value);
    const extra = await auth.getHeaders?.();
    if (extra) for (const [k, v] of Object.entries(extra)) if (v) setHeader(headers, k, v);
    return headers;
  }

  /**
   * Obtain fresh credentials after a 401 that used `usedAuthorization`.
   * Concurrent callers share one refresh; a caller whose token was already
   * replaced by someone else's refresh just picks up the new one.
   * Returns null when no fresh credential is available.
   */
  async refresh(ctx: RefreshAuthContext, usedAuthorization: string | undefined): Promise<HeaderMap | null> {
    if (!this.refreshable) return null;

    let current: HeaderMap | null = null;
    try {
      current = await this.resolve();
    } catch {
      current = null;
    }
    const alreadyRefreshed =
      current !== null && usedAuthorization !== undefined && getHeader(current, "authorization") !== usedAuthorization;

    if (!alreadyRefreshed) {
      this.inflight ??= this.runRefresh(ctx).finally(() => {
        this.inflight = null;
      });
      await this.inflight;
    }

    const fresh = await this.resolve();
    return Object.keys(fresh).length > 0 ? fresh : null;
  }

  private async runRefresh(ctx: RefreshAuthContext): Promise<void> {
    this.onRefresh();
    if (this.refreshAuth) {
      const res = await this.refreshAuth(ctx);
      // No return value → the auth source yields the new token itself.
      this.override = typeof res === "string" && res ? normalizeAuthorization(res) : null;
      return;
    }
    await (this.auth as AuthProvider).refreshNow?.();
    this.override = null;
  }
}
