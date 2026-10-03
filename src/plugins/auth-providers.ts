// =================================================================
// got-api-engine — Auth Providers
// =================================================================

import type { AuthProvider } from "../types";
import { normalizeAuthorization } from "../utils/helpers";

type TokenFn = () => string | null | undefined | Promise<string | null | undefined>;

// ── Static token ─────────────────────────────────────────────────
export class StaticAuthProvider implements AuthProvider {
  private readonly header: string;

  constructor(token: string) {
    this.header = normalizeAuthorization(token);
  }

  getAuthHeader(): string {
    return this.header;
  }
}

// ── Dynamic token via callback ────────────────────────────────────
export class DynamicAuthProvider implements AuthProvider {
  constructor(private readonly tokenFn: TokenFn) {}

  async getAuthHeader(): Promise<string | null> {
    const token = await this.tokenFn();
    return token ? normalizeAuthorization(token) : null;
  }
}

// ── next-auth / Auth.js session provider ──────────────────────────
export interface NextAuthSession {
  access_token?: string;
  /** Auth.js v5 convention. */
  accessToken?: string;
  [key: string]: unknown;
}

export class NextAuthProvider implements AuthProvider {
  constructor(private readonly getSession: () => NextAuthSession | null | Promise<NextAuthSession | null>) {}

  async getAuthHeader(): Promise<string | null> {
    const session = await this.getSession();
    const token = session?.access_token ?? session?.accessToken;
    return token ? normalizeAuthorization(token) : null;
  }
}

// ── localStorage/sessionStorage provider (browser) ───────────────
type StorageLike = { getItem(key: string): string | null };

export class BrowserStorageAuthProvider implements AuthProvider {
  constructor(
    private readonly storageKey = "auth_token",
    private readonly storage: "localStorage" | "sessionStorage" = "localStorage",
  ) {}

  getAuthHeader(): string | null {
    try {
      const store = (globalThis as unknown as Record<string, StorageLike | undefined>)[this.storage];
      const token = store?.getItem(this.storageKey);
      return token ? normalizeAuthorization(token) : null;
    } catch {
      // Storage can throw (privacy mode, sandboxed iframes).
      return null;
    }
  }
}

// ── API key provider (custom header, not Authorization) ──────────
export class ApiKeyAuthProvider implements AuthProvider {
  constructor(
    private readonly apiKey: string,
    private readonly headerName = "X-API-Key",
  ) {}

  /** API keys travel in a dedicated header, not in `Authorization`. */
  getAuthHeader(): null {
    return null;
  }

  getHeaders(): Record<string, string> {
    return { [this.headerName]: this.apiKey };
  }
}

// ── HTTP Basic ────────────────────────────────────────────────────
export class BasicAuthProvider implements AuthProvider {
  private readonly header: string;

  constructor(username: string, password: string) {
    this.header = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  }

  getAuthHeader(): string {
    return this.header;
  }
}

// ── Token with expiry + single-flight refresh ─────────────────────
export interface RefreshedToken {
  token: string;
  /** Absolute expiry (epoch ms) … */
  expiresAt?: number;
  /** … or lifetime in seconds from now. */
  expiresInSec?: number;
}

export interface RefreshableAuthOptions {
  /** Fetch a fresh token (called single-flight, never concurrently). */
  refresh: () => Promise<RefreshedToken | string>;
  /** Refresh this many ms before expiry. @default 30000 */
  skewMs?: number;
  /** Lifetime to assume when the token carries no expiry info. @default 300000 */
  defaultTtlMs?: number;
}

function jwtExpiryMs(token: string): number | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Caches a token until shortly before it expires (reads the JWT `exp` claim
 * when no explicit expiry is given) and refreshes it single-flight, so a burst
 * of concurrent requests triggers exactly one refresh call.
 */
export class RefreshableAuthProvider implements AuthProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;
  private readonly skewMs: number;
  private readonly defaultTtlMs: number;

  constructor(private readonly opts: RefreshableAuthOptions) {
    this.skewMs = opts.skewMs ?? 30_000;
    this.defaultTtlMs = opts.defaultTtlMs ?? 300_000;
  }

  async getAuthHeader(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - this.skewMs) return normalizeAuthorization(this.token);
    return normalizeAuthorization(await this.refreshNow());
  }

  /** Force a refresh (e.g. after the API answered 401). Single-flight. */
  refreshNow(): Promise<string> {
    this.inflight ??= (async () => {
      try {
        const res = await this.opts.refresh();
        const t: RefreshedToken = typeof res === "string" ? { token: res } : res;
        this.token = t.token;
        this.expiresAt =
          t.expiresAt ??
          (t.expiresInSec !== undefined ? Date.now() + t.expiresInSec * 1000 : undefined) ??
          jwtExpiryMs(t.token) ??
          Date.now() + this.defaultTtlMs;
        return t.token;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Drop the cached token so the next call refreshes. */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }
}

// ── Factory helpers ───────────────────────────────────────────────
export const createStaticAuth = (token: string): AuthProvider => new StaticAuthProvider(token);
export const createDynamicAuth = (fn: TokenFn): AuthProvider => new DynamicAuthProvider(fn);
export const createNextAuthProvider = (
  getSession: () => NextAuthSession | null | Promise<NextAuthSession | null>,
): AuthProvider => new NextAuthProvider(getSession);
export const createBrowserStorageAuth = (
  key?: string,
  storage?: "localStorage" | "sessionStorage",
): AuthProvider => new BrowserStorageAuthProvider(key, storage);
export const createApiKeyAuth = (apiKey: string, headerName?: string): AuthProvider =>
  new ApiKeyAuthProvider(apiKey, headerName);
export const createBasicAuth = (username: string, password: string): AuthProvider =>
  new BasicAuthProvider(username, password);
export const createRefreshableAuth = (opts: RefreshableAuthOptions): RefreshableAuthProvider =>
  new RefreshableAuthProvider(opts);
