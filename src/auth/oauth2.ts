// ── OAuth 2.0 client-credentials provider (RFC 6749 §4.4) ────────

import type { AuthProvider } from "../types/auth";
import { RefreshableAuthProvider } from "./providers";

export interface OAuth2ClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string | string[];
  audience?: string;
  /** Send credentials as HTTP Basic (default) or in the form body. */
  authMethod?: "basic" | "body";
  /** Refresh this many ms before expiry. @default 30000 */
  skewMs?: number;
  /** Request timeout for the token endpoint. @default 10000 */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). @default globalThis.fetch */
  fetch?: typeof fetch;
}

interface TokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
}

export class OAuth2TokenError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuth2TokenError";
  }
}

/**
 * Fetches and caches a service token; refreshes it single-flight before
 * expiry and after an upstream 401 (via `refreshNow`).
 */
export function createOAuth2ClientCredentials(options: OAuth2ClientCredentialsOptions): AuthProvider & {
  refreshNow(): Promise<string>;
  invalidate(): void;
} {
  const doFetch = options.fetch ?? globalThis.fetch;
  const requestToken = async (): Promise<{ token: string; expiresInSec?: number }> => {
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (options.scope) form.set("scope", Array.isArray(options.scope) ? options.scope.join(" ") : options.scope);
    if (options.audience) form.set("audience", options.audience);
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if ((options.authMethod ?? "basic") === "basic") {
      const id = encodeURIComponent(options.clientId);
      const secret = encodeURIComponent(options.clientSecret);
      headers["Authorization"] = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
    } else {
      form.set("client_id", options.clientId);
      form.set("client_secret", options.clientSecret);
    }

    const res = await doFetch(options.tokenUrl, {
      method: "POST",
      headers,
      body: form.toString(),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new OAuth2TokenError(`Token endpoint answered ${res.status}.`, res.status);
    const json = (await res.json()) as TokenResponse;
    if (typeof json.access_token !== "string" || !json.access_token) {
      throw new OAuth2TokenError("Token endpoint returned no access_token.");
    }
    return {
      token: json.access_token,
      ...(typeof json.expires_in === "number" ? { expiresInSec: json.expires_in } : {}),
    };
  };

  return new RefreshableAuthProvider({
    refresh: requestToken,
    ...(options.skewMs !== undefined ? { skewMs: options.skewMs } : {}),
  });
}
