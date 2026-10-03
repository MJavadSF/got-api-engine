// =================================================================
// got-api-engine — Utility Helpers
// =================================================================

import { createHash, randomUUID } from "node:crypto";
import type { AuthMode, AuthProvider, EngineConfig, ParamValue, ResponseType } from "../types";

// ── Unique ids (crypto.randomUUID — no `uuid` dependency needed) ─
export function generateRequestId(): string {
  return randomUUID();
}

export function generateIdempotencyKey(): string {
  return randomUUID();
}

// ── Circular-reference-safe JSON stringifier ─────────────────────
export function safeStringify(value: unknown, maxDepth = 3, space: number | undefined = 2): string {
  const ancestors: object[] = [];

  const out = JSON.stringify(
    value,
    function (this: unknown, _key: string, v: unknown): unknown {
      if (typeof v === "bigint") return v.toString();
      if (typeof v !== "object" || v === null) return v;
      // `this` is the object that holds `v`; unwind the ancestor stack to it.
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(v)) return "[Circular]";
      if (ancestors.length >= maxDepth) return "[Object]";
      ancestors.push(v);
      return v;
    },
    space,
  );
  return out ?? "undefined";
}

// ── Extract user ID from JWT bearer token ────────────────────────
// NOTE: This only *decodes* the (unverified) JWT payload to read a user id
// for logging/correlation. It performs NO signature verification and must
// never be used for authorization decisions.
type JwtPayloadLike = { sub?: unknown; userId?: unknown; id?: unknown };

export function getUserIdFromBearerToken(authHeader?: string | null): string | undefined {
  if (!authHeader || !/^Bearer\s/i.test(authHeader)) return undefined;
  try {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) return undefined;
    // base64url → UTF-8 (Buffer understands base64url natively)
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtPayloadLike | null;
    const id = payload?.sub ?? payload?.userId ?? payload?.id;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  } catch {
    return undefined;
  }
}

// ── Error message extraction from various API response shapes ─────
const DEFAULT_ERROR_MESSAGE = "An unexpected error occurred.";
const MAX_ERROR_LENGTH = 500;
const MESSAGE_KEYS = ["message", "msg", "title", "detail", "error_description", "error", "reason"] as const;

function extractText(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t ? t : null;
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => extractText(v, depth + 1)).filter((v): v is string => v !== null);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of MESSAGE_KEYS) {
      const found = extractText(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function parseApiError(rawBody: unknown): string {
  if (rawBody === undefined || rawBody === null || rawBody === "") return DEFAULT_ERROR_MESSAGE;
  if (Buffer.isBuffer(rawBody)) return DEFAULT_ERROR_MESSAGE;

  let body: unknown = rawBody;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        body = JSON.parse(trimmed);
      } catch {
        return trimmed.slice(0, MAX_ERROR_LENGTH);
      }
    } else {
      // Don't surface whole HTML error pages as messages.
      if (trimmed.startsWith("<") || !trimmed) return DEFAULT_ERROR_MESSAGE;
      return trimmed.slice(0, MAX_ERROR_LENGTH);
    }
  }

  if (typeof body !== "object" || body === null) return DEFAULT_ERROR_MESSAGE;

  const obj = body as Record<string, unknown>;
  const candidates = ["message", "error", "errors", "detail", "title", "msg", "error_description", "reason"];
  for (const key of candidates) {
    const found = extractText(obj[key]);
    if (found) return found.slice(0, MAX_ERROR_LENGTH);
  }
  return extractText(obj)?.slice(0, MAX_ERROR_LENGTH) ?? DEFAULT_ERROR_MESSAGE;
}

// ── Build full URL from endpoint + base ──────────────────────────
export function buildUrl(endpoint: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint; // already absolute
  const base = baseUrl.replace(/\/+$/, "");
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}

// ── Append query params to a URL ─────────────────────────────────
const enc = encodeURIComponent;

export function appendParams(url: string, params: Record<string, ParamValue>): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null) continue;
    const values: ReadonlyArray<unknown> = Array.isArray(raw) ? (raw as ReadonlyArray<unknown>) : [raw];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      parts.push(`${enc(key)}=${enc(String(v))}`);
    }
  }
  if (!parts.length) return url;

  const hashIdx = url.indexOf("#");
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
  const sep = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
  return `${base}${sep}${parts.join("&")}${hash}`;
}

// ── Header helpers (HTTP header names are case-insensitive) ──────
export type HeaderMap = Record<string, string>;

export function findHeaderKey(headers: HeaderMap, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

export function getHeader(headers: HeaderMap, name: string): string | undefined {
  const key = findHeaderKey(headers, name);
  return key === undefined ? undefined : headers[key];
}

export function hasHeader(headers: HeaderMap, name: string): boolean {
  return findHeaderKey(headers, name) !== undefined;
}

/** Set a header, replacing any existing one regardless of its casing. */
export function setHeader(headers: HeaderMap, name: string, value: string): void {
  const existing = findHeaderKey(headers, name);
  if (existing !== undefined && existing !== name) delete headers[existing];
  headers[name] = value;
}

export function setHeaderIfAbsent(headers: HeaderMap, name: string, value: string): void {
  if (!hasHeader(headers, name)) headers[name] = value;
}

export function deleteHeader(headers: HeaderMap, name: string): void {
  const key = findHeaderKey(headers, name);
  if (key !== undefined) delete headers[key];
}

/** Merge header maps; later sources win, compared case-insensitively. */
export function mergeHeaders(
  ...sources: Array<Record<string, string> | undefined | null>
): HeaderMap {
  const result: HeaderMap = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || v === null) continue;
      setHeader(result, k, String(v));
    }
  }
  return result;
}

// ── Auth ─────────────────────────────────────────────────────────
/** Keep an existing scheme ("Bearer x", "Basic x", "ApiKey x"); prefix bare tokens with Bearer. */
export function normalizeAuthorization(value: string): string {
  const v = value.trim();
  return /^[A-Za-z][\w.~+-]*\s+\S/.test(v) ? v : `Bearer ${v}`;
}

/**
 * Resolve the credential headers for a request from the per-request override
 * token or the engine's configured `auth` (string, function or provider).
 */
export async function resolveAuthHeaders(
  config: Pick<EngineConfig, "auth">,
  overrideToken?: string,
): Promise<HeaderMap> {
  const headers: HeaderMap = {};

  if (overrideToken) {
    headers["Authorization"] = normalizeAuthorization(overrideToken);
    return headers;
  }

  const { auth } = config;
  if (!auth) return headers;

  if (typeof auth === "string") {
    if (auth) headers["Authorization"] = normalizeAuthorization(auth);
    return headers;
  }

  if (typeof auth === "function") {
    const result = await auth();
    if (result) headers["Authorization"] = normalizeAuthorization(result);
    return headers;
  }

  const provider = auth as AuthProvider;
  if (typeof provider.getAuthHeader === "function") {
    const result = await provider.getAuthHeader();
    if (result) headers["Authorization"] = normalizeAuthorization(result);
  }
  if (typeof provider.getHeaders === "function") {
    const extra = await provider.getHeaders();
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v) setHeader(headers, k, v);
      }
    }
  }
  return headers;
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

// ── Validate X-Forwarded-For to avoid header injection ───────────
const XFF_SAFE = /^[\d.,: a-fA-F]+$/;
export function sanitizeForwardedFor(xff: string | null): string | null {
  if (!xff) return null;
  return XFF_SAFE.test(xff) ? xff : null;
}

/** Accept an externally supplied correlation id only if it is header-safe. */
export function sanitizeRequestId(id: string | null | undefined): string | undefined {
  return id && /^[\w.:-]{1,128}$/.test(id) ? id : undefined;
}

// ── Duration measurement ─────────────────────────────────────────
export function startTimer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}

// ── Cache keys ───────────────────────────────────────────────────
function sha256(input: string, length = 22): string {
  // 22 base64url chars = 132 bits — collisions are not a practical concern.
  return createHash("sha256").update(input).digest("base64url").slice(0, length);
}

/** Fingerprint of the credentials, so principals never share cache entries. */
export function authFingerprint(headers: HeaderMap): string {
  const entries = Object.entries(headers)
    .map(([k, v]) => `${k.toLowerCase()}:${v}`)
    .sort();
  return entries.length ? sha256(entries.join("\n")) : "";
}

/** Fingerprint of the request-varying inputs (custom headers, response type). */
export function variantFingerprint(
  headers: HeaderMap | undefined,
  responseType: ResponseType,
  defaultResponseType: ResponseType,
): string {
  const entries = Object.entries(headers ?? {})
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0 && responseType === defaultResponseType) return "";
  return sha256(JSON.stringify([entries, responseType]), 16);
}

/**
 * `METHOD url|authFp|variantFp` — the URL stays readable so entries can be
 * invalidated by resource; credentials are only ever present as a hash.
 */
export function buildCacheKey(method: string, url: string, authFp = "", variantFp = ""): string {
  return `${method.toUpperCase()} ${url}|${authFp}|${variantFp}`;
}

/** URL without its query string / fragment (for resource-level invalidation). */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

// ── Normalise got response headers to a flat string map ──────────
export function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

// ── Response body decoding ───────────────────────────────────────
export type ContentClass = "json" | "text" | "binary" | "unknown";

export function classifyContentType(contentType: string | undefined): ContentClass {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  if (!mime) return "unknown";
  if (mime === "application/json" || mime === "text/json" || mime.endsWith("+json")) return "json";
  if (
    mime.startsWith("text/") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-www-form-urlencoded" ||
    mime === "application/x-ndjson" ||
    mime === "application/graphql"
  ) {
    return "text";
  }
  if (
    /^(image|audio|video|font)\//.test(mime) ||
    /^application\/(octet-stream|pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|vnd\.rar|msword|wasm)$/.test(mime) ||
    mime.startsWith("application/vnd.openxmlformats") ||
    mime.startsWith("application/vnd.ms-")
  ) {
    return "binary";
  }
  return "unknown";
}

function decodeText(buf: Buffer, contentType: string | undefined): string {
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? "")?.[1];
  if (!charset || /^utf-?8$/i.test(charset)) return buf.toString("utf8");
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

export type DecodedBody = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Decode a raw response body according to `mode` and the Content-Type.
 * With `lenient`, JSON parse failures fall back to the raw text (used for
 * error responses so a malformed error body never masks the HTTP status).
 */
export function decodeBody(
  raw: Buffer,
  contentType: string | undefined,
  mode: ResponseType,
  lenient = false,
): DecodedBody {
  if (mode === "buffer") return { ok: true, value: raw };
  if (raw.length === 0) return { ok: true, value: "" };

  const text = decodeText(raw, contentType);
  const parseJson = (): DecodedBody => {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch (err) {
      return lenient
        ? { ok: true, value: text }
        : { ok: false, error: err instanceof Error ? err.message : "Invalid JSON" };
    }
  };

  if (mode === "text") return { ok: true, value: text };
  if (mode === "json") return parseJson();

  // auto
  switch (classifyContentType(contentType)) {
    case "json":
      return parseJson();
    case "text":
      return { ok: true, value: text };
    case "binary":
      return lenient ? { ok: true, value: text.slice(0, MAX_ERROR_LENGTH) } : { ok: true, value: raw };
    default: {
      // Unknown / missing content type: sniff for JSON, otherwise treat as text.
      const head = text.trimStart()[0];
      if (head === "{" || head === "[") {
        const parsed = parseJson();
        return parsed.ok ? parsed : { ok: true, value: text };
      }
      return { ok: true, value: text };
    }
  }
}

// ── Cloning (protect cached / deduplicated data from caller mutation) ──
export function cloneBody<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as unknown as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as unknown as T;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** got 16 returns Uint8Array bodies; normalise to Buffer without copying. */
export function toBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.alloc(0);
}

/** Extract a serialisable error payload from a schema library's failure object. */
export function schemaErrorDetails(error: { flatten?: () => unknown; issues?: unknown } | undefined): unknown {
  if (!error) return undefined;
  if (typeof error.flatten === "function") {
    try {
      return error.flatten();
    } catch {
      /* fall through */
    }
  }
  return error.issues ?? error;
}

// ── Cache-Control parsing ────────────────────────────────────────
export interface ParsedCacheControl {
  noStore: boolean;
  noCache: boolean;
  maxAgeMs?: number;
}

export function parseCacheControl(header: string | undefined): ParsedCacheControl {
  const out: ParsedCacheControl = { noStore: false, noCache: false };
  if (!header) return out;
  for (const rawPart of header.split(",")) {
    const part = rawPart.trim().toLowerCase();
    if (part === "no-store") out.noStore = true;
    else if (part === "no-cache") out.noCache = true;
    else if (part.startsWith("max-age=")) {
      const n = Number(part.slice(8).replace(/"/g, ""));
      if (Number.isFinite(n) && n >= 0) out.maxAgeMs = n * 1000;
    }
  }
  return out;
}
