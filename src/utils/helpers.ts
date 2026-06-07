// =================================================================
// got-api-engine — Utility Helpers
// =================================================================

import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import type { AuthMode, AuthProvider, EngineConfig } from "../types";

// ── Unique request ID ────────────────────────────────────────────
export function generateRequestId(): string {
  return uuidv4();
}

// ── Safe circular-reference-safe JSON stringifier ────────────────
export function safeStringify(value: unknown, maxDepth = 3): string {
  const seen = new WeakSet();
  const depthMap = new WeakMap<object, number>();

  return JSON.stringify(
    value,
    function (_k, v) {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        const parentDepth =
          this !== null && typeof this === "object" && depthMap.has(this as object)
            ? (depthMap.get(this as object) ?? 0)
            : 0;
        if (parentDepth >= maxDepth) return "[Object]";
        seen.add(v);
        depthMap.set(v, parentDepth + 1);
      }
      return v;
    },
    2,
  );
}

// ── Extract user ID from JWT bearer token ────────────────────────
type JwtPayloadLike = { sub?: string; userId?: string; id?: string };

export function getUserIdFromBearerToken(authHeader?: string | null): string | undefined {
  if (!authHeader?.startsWith("Bearer ")) return undefined;
  try {
    const payload = jwt.decode(authHeader.slice(7)) as JwtPayloadLike | null;
    return payload?.sub ?? payload?.userId ?? payload?.id;
  } catch {
    return undefined;
  }
}

// ── Error message extraction from various API response shapes ─────
const DEFAULT_ERROR_MESSAGE = "An unexpected error occurred.";

export function parseApiError(rawBody: unknown): string {
  if (!rawBody) return DEFAULT_ERROR_MESSAGE;

  const body: unknown =
    typeof rawBody === "string"
      ? (() => {
          try {
            return JSON.parse(rawBody);
          } catch {
            return rawBody;
          }
        })()
      : rawBody;

  if (typeof body === "string") return body;
  if (typeof body !== "object" || body === null) return DEFAULT_ERROR_MESSAGE;

  const obj = body as Record<string, unknown>;

  // Support arrays of {title} in message/error fields
  const fromArray = (field: unknown): string | null => {
    if (!Array.isArray(field)) return null;
    const titles = field.map((m) => (typeof m === "object" && m !== null ? (m as any).title : null)).filter(Boolean);
    return titles.length ? titles.join(", ") : null;
  };

  return (
    fromArray(obj["message"]) ??
    fromArray(obj["error"]) ??
    (typeof obj["error"] === "string" ? obj["error"] : null) ??
    (typeof obj["message"] === "string" ? obj["message"] : null) ??
    (typeof obj["detail"] === "string" ? obj["detail"] : null) ??
    (typeof obj["msg"] === "string" ? obj["msg"] : null) ??
    DEFAULT_ERROR_MESSAGE
  );
}

// ── Build full URL from endpoint + base ──────────────────────────
export function buildUrl(endpoint: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint; // already absolute
  const base = baseUrl.replace(/\/$/, "");
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}

// ── Append query params to a URL ─────────────────────────────────
export function appendParams(
  url: string,
  params: Record<string, string | number | boolean>,
): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return url;
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
}

// ── Resolve auth header value from config ────────────────────────
export async function resolveAuthHeader(
  config: Pick<EngineConfig, "auth">,
  overrideToken?: string,
): Promise<string | null> {
  if (overrideToken) {
    return overrideToken.startsWith("Bearer ") ? overrideToken : `Bearer ${overrideToken}`;
  }

  const { auth } = config;
  if (!auth) return null;

  if (typeof auth === "string") {
    return auth.startsWith("Bearer ") ? auth : `Bearer ${auth}`;
  }

  if (typeof auth === "function") {
    const result = await auth();
    if (!result) return null;
    return result.startsWith("Bearer ") ? result : `Bearer ${result}`;
  }

  // AuthProvider object
  if (typeof auth === "object" && "getAuthHeader" in auth) {
    const result = await (auth as AuthProvider).getAuthHeader();
    if (!result) return null;
    return result.startsWith("Bearer ") ? result : `Bearer ${result}`;
  }

  return null;
}

// ── Normalise AuthMode ───────────────────────────────────────────
export function isAuthRequired(mode: AuthMode): boolean {
  return mode === true || mode === "bearer";
}

export function isAuthOptional(mode: AuthMode): boolean {
  return mode === "optional";
}

export function isAuthDisabled(mode: AuthMode): boolean {
  return mode === false || mode === "none";
}

// ── Merge header maps ────────────────────────────────────────────
export function mergeHeaders(
  ...sources: Array<Record<string, string> | undefined | null>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const src of sources) {
    if (src) Object.assign(result, src);
  }
  return result;
}

// ── Validate X-Forwarded-For to avoid header injection ───────────
const XFF_SAFE = /^[\d.,: a-fA-F]+$/;
export function sanitizeForwardedFor(xff: string | null): string | null {
  if (!xff) return null;
  return XFF_SAFE.test(xff) ? xff : null;
}

// ── Duration measurement ─────────────────────────────────────────
export function startTimer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}
