// ── Parsing of upstream control headers ──────────────────────────
// Cache-Control, Retry-After and rate-limit headers (IETF + X-RateLimit-*).

export interface ParsedCacheControl {
  noStore: boolean;
  noCache: boolean;
  private: boolean;
  mustRevalidate: boolean;
  immutable: boolean;
  maxAgeMs?: number;
  sMaxAgeMs?: number;
  staleWhileRevalidateMs?: number;
  staleIfErrorMs?: number;
}

function seconds(value: string): number | undefined {
  const n = Number(value.replace(/"/g, ""));
  return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
}

export function parseCacheControl(header: string | undefined): ParsedCacheControl {
  const out: ParsedCacheControl = {
    noStore: false,
    noCache: false,
    private: false,
    mustRevalidate: false,
    immutable: false,
  };
  if (!header) return out;
  for (const raw of header.split(",")) {
    const [name = "", value = ""] = raw.trim().toLowerCase().split("=", 2);
    switch (name) {
      case "no-store":
        out.noStore = true;
        break;
      case "no-cache":
        out.noCache = true;
        break;
      case "private":
        out.private = true;
        break;
      case "must-revalidate":
      case "proxy-revalidate":
        out.mustRevalidate = true;
        break;
      case "immutable":
        out.immutable = true;
        break;
      case "max-age": {
        const ms = seconds(value);
        if (ms !== undefined) out.maxAgeMs = ms;
        break;
      }
      case "s-maxage": {
        const ms = seconds(value);
        if (ms !== undefined) out.sMaxAgeMs = ms;
        break;
      }
      case "stale-while-revalidate": {
        const ms = seconds(value);
        if (ms !== undefined) out.staleWhileRevalidateMs = ms;
        break;
      }
      case "stale-if-error": {
        const ms = seconds(value);
        if (ms !== undefined) out.staleIfErrorMs = ms;
        break;
      }
    }
  }
  return out;
}

/** Parse `Retry-After` (delta-seconds or HTTP date) into ms. */
export function parseRetryAfter(header: string | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export interface RateLimitHint {
  remaining: number;
  /** ms until the window resets. */
  resetMs: number;
}

/**
 * Read upstream quota hints: IETF `RateLimit: "x";r=0;t=10`, the older
 * `RateLimit-Remaining`/`-Reset` pair, or `X-RateLimit-Remaining`/`-Reset`
 * (reset as delta-seconds or epoch-seconds).
 */
export function parseRateLimitHeaders(get: (name: string) => string | undefined, now = Date.now()): RateLimitHint | null {
  const structured = get("ratelimit");
  if (structured) {
    const r = /(?:^|;)\s*r=(\d+)/.exec(structured)?.[1];
    const t = /(?:^|;)\s*t=(\d+)/.exec(structured)?.[1];
    if (r !== undefined && t !== undefined) return { remaining: Number(r), resetMs: Number(t) * 1000 };
  }
  const remaining = get("ratelimit-remaining") ?? get("x-ratelimit-remaining");
  const reset = get("ratelimit-reset") ?? get("x-ratelimit-reset");
  if (remaining === undefined || reset === undefined) return null;
  const rem = Number(remaining);
  const rst = Number(reset);
  if (!Number.isFinite(rem) || !Number.isFinite(rst)) return null;
  // Values above ~1e9 are epoch seconds, otherwise delta-seconds.
  const resetMs = rst > 1e9 ? Math.max(0, rst * 1000 - now) : rst * 1000;
  return { remaining: rem, resetMs };
}

/** Parse an RFC 8288 `Link` header into `{ rel: url }`. */
export function parseLinkHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(/,(?=\s*<)/)) {
    const url = /<([^>]*)>/.exec(part)?.[1];
    const rel = /;\s*rel="?([^";]+)"?/i.exec(part)?.[1];
    if (url && rel) for (const r of rel.split(/\s+/)) out[r.toLowerCase()] = url;
  }
  return out;
}
