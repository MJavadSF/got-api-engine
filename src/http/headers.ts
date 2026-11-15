// ── Case-insensitive header helpers ──────────────────────────────

import { validateHeaderName, validateHeaderValue } from "node:http";
import type { HeaderMap } from "../types/http";

export type { HeaderMap };

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

/** Set a header, replacing any existing one regardless of casing. */
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

/** Merge header maps; later sources win (case-insensitive). */
export function mergeHeaders(...sources: Array<Record<string, string> | undefined | null>): HeaderMap {
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

/** Flatten node response headers to a string map. */
export function flattenHeaders(headers: Record<string, string | string[] | undefined>): HeaderMap {
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/** Returns the first invalid header (name or value) or undefined. */
export function findInvalidHeader(headers: HeaderMap): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch {
      return name;
    }
  }
  return undefined;
}

/** Pick allow-listed headers (case-insensitive). */
export function pickHeaders(headers: HeaderMap, names: readonly string[]): HeaderMap {
  const out: HeaderMap = {};
  for (const name of names) {
    const v = getHeader(headers, name);
    if (v !== undefined) out[name.toLowerCase()] = v;
  }
  return out;
}
