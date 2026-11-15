// ── URL building, normalisation and path safety ──────────────────

import type { ParamValue } from "../types/http";

const ABSOLUTE = /^https?:\/\//i;

export function isAbsoluteUrl(endpoint: string): boolean {
  return ABSOLUTE.test(endpoint);
}

/** Join base and endpoint (absolute endpoints are returned unchanged). */
export function buildUrl(endpoint: string, baseUrl: string): string {
  if (isAbsoluteUrl(endpoint)) return endpoint;
  const base = baseUrl.replace(/\/+$/, "");
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}

/** Append query params (arrays → repeated keys), keeping any fragment last. */
export function appendParams(url: string, params: Record<string, ParamValue>): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null) continue;
    const values: ReadonlyArray<unknown> = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  if (parts.length === 0) return url;

  const hashIdx = url.indexOf("#");
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
  const sep = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
  return `${base}${sep}${parts.join("&")}${hash}`;
}

/** Canonical form (lower-case host, percent-encoded path, no fragment). */
export function normalizeUrl(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.href;
}

/** URL without query string / fragment. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

// Separators include encoded slashes / backslashes, which some servers decode.
const DOT_SEGMENT = /(?:^|\/|%2f|%5c|\\)(?:\.|%2e){1,2}(?:\/|%2f|%5c|\\|$|\?|#)/i;

export type PathCheck = { ok: true } | { ok: false; reason: string };

/**
 * Guard against path traversal for relative endpoints:
 * no `.`/`..` segments (raw or percent-encoded) and the resolved path must
 * stay under the base path.
 */
export function checkRelativePath(endpoint: string, baseUrl: string | URL, resolved: string | URL): PathCheck {
  const pathPart = stripQuery(endpoint);
  if (DOT_SEGMENT.test(pathPart)) return { ok: false, reason: "dot segments are not allowed in endpoints" };
  const basePath = (typeof baseUrl === "string" ? new URL(baseUrl) : baseUrl).pathname.replace(/\/+$/, "");
  const path = (typeof resolved === "string" ? new URL(resolved) : resolved).pathname;
  if (basePath && path !== basePath && !path.startsWith(`${basePath}/`)) {
    return { ok: false, reason: "endpoint escapes the base path" };
  }
  return { ok: true };
}

/** Encode one path segment, refusing traversal values. */
export function encodePathSegment(value: string | number | boolean): string {
  const s = String(value);
  if (s === "." || s === ".." || s === "") throw new TypeError(`Invalid path segment: "${s}"`);
  return encodeURIComponent(s);
}

/**
 * Tagged template that percent-encodes every interpolated value as a single
 * path segment: path`/users/${id}/posts` — `id = "../admin"` throws.
 */
export function path(strings: TemplateStringsArray, ...values: Array<string | number | boolean>): string {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += encodePathSegment(v) + (strings[i + 1] ?? "");
  });
  return out;
}

/** Fill `:param` placeholders of a path template. */
export function fillPathTemplate(template: string, params: Record<string, string | number | boolean> = {}): string {
  return template.replace(/:([A-Za-z_][\w]*)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) throw new TypeError(`Missing path parameter ":${name}"`);
    return encodePathSegment(v);
  });
}
