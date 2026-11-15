// ── Cache / dedupe key format ────────────────────────────────────
//
//   `METHOD <origin+pathname>[?q=<hmac(query)>]|<authFp>|<variantFp>`
//
// The resource part stays readable so entries can be invalidated per
// resource; query strings and credentials only ever appear as HMACs, so a
// shared store (Redis) never holds secrets in its keys.

import type { Fingerprinter } from "../security/fingerprint";

export interface KeyParts {
  method: string;
  /** Normalised absolute URL. */
  url: string;
  authFp: string;
  variantFp: string;
}

/** origin + pathname of a normalised URL. */
export function resourceOf(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

export function buildCacheKey(parts: KeyParts, fp: Fingerprinter): string {
  const u = new URL(parts.url);
  const query = u.search ? `?q=${fp.hash(u.search.slice(1), 16)}` : "";
  return `${parts.method.toUpperCase()} ${u.origin}${u.pathname}${query}|${parts.authFp}|${parts.variantFp}`;
}

/** Resource (origin + path) of a key, or undefined if not ours. */
export function resourceOfKey(key: string): string | undefined {
  const sp = key.indexOf(" ");
  const i2 = key.lastIndexOf("|");
  const i1 = key.lastIndexOf("|", i2 - 1);
  if (sp === -1 || i1 <= sp) return undefined;
  const head = key.slice(sp + 1, i1);
  const q = head.indexOf("?q=");
  return q === -1 ? head : head.slice(0, q);
}
