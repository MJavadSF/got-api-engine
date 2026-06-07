// =================================================================
// got-api-engine — Auth Providers
// =================================================================

import type { AuthProvider } from "../types";

// ── Static token ─────────────────────────────────────────────────
export class StaticAuthProvider implements AuthProvider {
  private readonly token: string;

  constructor(token: string) {
    this.token = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  }

  getAuthHeader(): string {
    return this.token;
  }
}

// ── Dynamic token via callback ────────────────────────────────────
export class DynamicAuthProvider implements AuthProvider {
  private readonly tokenFn: () => string | null | undefined | Promise<string | null | undefined>;

  constructor(tokenFn: () => string | null | undefined | Promise<string | null | undefined>) {
    this.tokenFn = tokenFn;
  }

  async getAuthHeader(): Promise<string | null> {
    const token = await this.tokenFn();
    if (!token) return null;
    return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  }
}

// ── next-auth session provider ────────────────────────────────────
export interface NextAuthSession {
  access_token?: string;
  [key: string]: unknown;
}

export class NextAuthProvider implements AuthProvider {
  private readonly getSession: () => NextAuthSession | null | Promise<NextAuthSession | null>;

  constructor(getSession: () => NextAuthSession | null | Promise<NextAuthSession | null>) {
    this.getSession = getSession;
  }

  async getAuthHeader(): Promise<string | null> {
    const session = await this.getSession();
    const token = session?.access_token;
    if (!token) return null;
    return `Bearer ${token}`;
  }
}

// ── localStorage/sessionStorage provider (browser) ───────────────
export class BrowserStorageAuthProvider implements AuthProvider {
  private readonly storageKey: string;
  private readonly storage: "localStorage" | "sessionStorage";

  constructor(
    storageKey = "auth_token",
    storage: "localStorage" | "sessionStorage" = "localStorage",
  ) {
    this.storageKey = storageKey;
    this.storage = storage;
  }

  getAuthHeader(): string | null {
    if (typeof window === "undefined") return null;
    const token = window[this.storage].getItem(this.storageKey);
    if (!token) return null;
    return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  }
}

// ── API Key provider (X-API-Key header, not Authorization) ────────
export class ApiKeyAuthProvider implements AuthProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Note: API key auth sets a custom header.
   * Use this with defaultHeaders instead for full control:
   *   defaultHeaders: { 'X-API-Key': apiKey }
   */
  getAuthHeader(): string {
    return `ApiKey ${this.apiKey}`;
  }
}

// ── Factory helpers ───────────────────────────────────────────────
export const createStaticAuth = (token: string): AuthProvider => new StaticAuthProvider(token);
export const createDynamicAuth = (fn: () => string | null | undefined | Promise<string | null | undefined>): AuthProvider =>
  new DynamicAuthProvider(fn);
export const createNextAuthProvider = (getSession: () => NextAuthSession | null | Promise<NextAuthSession | null>): AuthProvider =>
  new NextAuthProvider(getSession);
export const createBrowserStorageAuth = (key?: string, storage?: "localStorage" | "sessionStorage"): AuthProvider =>
  new BrowserStorageAuthProvider(key, storage);
