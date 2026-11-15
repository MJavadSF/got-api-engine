// ── Redaction of secrets from logs, hooks and URLs ───────────────

import type { LoggerInterface } from "../types/observability";

/** Matched against key names, case-insensitively, as substrings. */
const DEFAULT_PATTERNS: readonly RegExp[] = [
  /authorization/i,
  /cookie/i,
  /token/i,
  /secret/i,
  /passw(or)?d/i,
  /passwd/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /session/i,
  /signature/i,
  /credential/i,
  /^jwt$/i,
  /^otp$/i,
  /^pin$/i,
];

/** Keys that look sensitive but are safe and useful in logs. */
const SAFE_KEYS = new Set(["code", "status", "tokens", "token_type"]);

const REDACTED = "[REDACTED]";

export type Redactor = (meta: unknown) => unknown;
export type KeyMatcher = (key: string) => boolean;

export function buildKeyMatcher(extra: ReadonlyArray<string | RegExp> = []): KeyMatcher {
  const exact = new Set(extra.filter((k): k is string => typeof k === "string").map((k) => k.toLowerCase()));
  const patterns = [...DEFAULT_PATTERNS, ...extra.filter((k): k is RegExp => k instanceof RegExp)];
  return (key) => {
    const lower = key.toLowerCase();
    if (exact.has(lower)) return true;
    if (SAFE_KEYS.has(lower)) return false;
    return patterns.some((p) => p.test(key));
  };
}

const SCHEME_VALUE = /^(Bearer|Basic|Digest|ApiKey|Token)\s+\S+/i;

export function redactUrlWith(url: string, isSensitive: KeyMatcher): string {
  // Nothing to redact without a query string or userinfo (the common case).
  if (!url.includes("?") && !url.includes("@")) return url;
  try {
    const u = new URL(url);
    let changed = false;
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      changed = true;
    }
    for (const key of [...u.searchParams.keys()]) {
      if (isSensitive(key)) {
        u.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? u.toString().replaceAll("%5BREDACTED%5D", REDACTED) : url;
  } catch {
    return url;
  }
}

/** Redact credentials and sensitive query parameters from a URL. */
export function redactUrl(url: string, extraKeys: ReadonlyArray<string | RegExp> = []): string {
  return redactUrlWith(url, buildKeyMatcher(extraKeys));
}

export function buildRedactor(extraKeys: ReadonlyArray<string | RegExp> = []): Redactor {
  const isSensitive = buildKeyMatcher(extraKeys);

  const redactString = (v: string): string => {
    if (SCHEME_VALUE.test(v)) return REDACTED;
    if (/^https?:\/\//i.test(v)) return redactUrlWith(v, isSensitive);
    return v;
  };

  const redact = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof value === "string") return redactString(value);
    if (depth > 6 || value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
    if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitive(k) ? REDACTED : redact(v, depth + 1, seen);
    }
    return out;
  };

  return (meta) => redact(meta, 0, new WeakSet());
}

/** Wrap a logger so every metadata object passes through the redactor. */
export function withRedaction(base: LoggerInterface, redact: Redactor): LoggerInterface {
  const wrap = (l: LoggerInterface): LoggerInterface => {
    const enabled = l.isLevelEnabled?.bind(l);
    const call =
      (level: "debug" | "info" | "warn" | "error") =>
      (message: string, meta?: Record<string, unknown>): void => {
        if (enabled && !enabled(level)) return; // no redaction work for disabled levels
        l[level](message, meta ? (redact(meta) as Record<string, unknown>) : undefined);
      };
    const wrapped: LoggerInterface = { debug: call("debug"), info: call("info"), warn: call("warn"), error: call("error") };
    if (enabled) wrapped.isLevelEnabled = enabled;
    const child = l.child?.bind(l);
    if (child) wrapped.child = (childMeta) => wrap(child(redact(childMeta) as Record<string, unknown>));
    return wrapped;
  };
  return wrap(base);
}
