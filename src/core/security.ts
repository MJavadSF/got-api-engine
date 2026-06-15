// =================================================================
// got-api-engine — Security utilities
//   • SSRF guard: block private/loopback targets and cross-origin redirects
//   • Redaction: strip sensitive values from log metadata
// =================================================================

import type { SsrfConfig } from "../types";

// ── Default sensitive keys redacted from logs ────────────────────
const DEFAULT_REDACT_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "access_token",
  "refresh_token",
  "password",
  "secret",
  "token",
  "client_secret",
];

const REDACTED = "[REDACTED]";

export function buildRedactor(extraKeys: string[] = []): (meta: unknown) => unknown {
  const keys = new Set([...DEFAULT_REDACT_KEYS, ...extraKeys.map((k) => k.toLowerCase())]);

  const redact = (value: unknown, depth = 0): unknown => {
    if (depth > 6 || value === null || typeof value !== "object") return value;

    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else if (typeof v === "string" && looksLikeBearer(v)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  };

  return (meta: unknown) => redact(meta);
}

function looksLikeBearer(v: string): boolean {
  return /^Bearer\s+\S+/i.test(v);
}

// ── SSRF guard ───────────────────────────────────────────────────

export class SsrfError extends Error {
  readonly code = "SSRF_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
    Object.setPrototypeOf(this, SsrfError.prototype);
  }
}

// Private / reserved IPv4 ranges and IPv6 loopback/ULA/link-local.
const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./, // link-local
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0 – 172.31.255.255
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
];

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;

  // IPv6 loopback / unspecified / ULA (fc00::/7) / link-local (fe80::/10)
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  // IPv4-mapped IPv6
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const v4 = mapped ? mapped[1]! : host;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    return PRIVATE_IPV4.some((re) => re.test(v4));
  }
  return false;
}

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}

export function resolveSsrfConfig(input: boolean | SsrfConfig | undefined): SsrfConfig | null {
  if (!input) return null;
  if (input === true) {
    return {
      enabled: true,
      allowPrivateNetworks: false,
      sameOriginRedirectsOnly: true,
    };
  }
  if (input.enabled === false) return null;
  return {
    enabled: true,
    allowPrivateNetworks: input.allowPrivateNetworks ?? false,
    sameOriginRedirectsOnly: input.sameOriginRedirectsOnly ?? true,
    ...(input.allowHosts ? { allowHosts: input.allowHosts } : {}),
    ...(input.blockHosts ? { blockHosts: input.blockHosts } : {}),
  };
}

/** Throws SsrfError if `url` is not permitted under `cfg`. */
export function assertUrlAllowed(url: string, cfg: SsrfConfig): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SsrfError(`Blocked non-HTTP(S) protocol: ${parsed.protocol}`);
  }

  const host = parsed.hostname;

  if (cfg.blockHosts?.some((p) => hostMatches(host, p))) {
    throw new SsrfError(`Host is blocklisted: ${host}`);
  }

  if (cfg.allowHosts && cfg.allowHosts.length > 0) {
    if (!cfg.allowHosts.some((p) => hostMatches(host, p))) {
      throw new SsrfError(`Host not in allowlist: ${host}`);
    }
    return; // allowlist is authoritative
  }

  if (!cfg.allowPrivateNetworks && isPrivateHostname(host)) {
    throw new SsrfError(`Blocked request to private/loopback host: ${host}`);
  }
}

/** Build a got `beforeRedirect` hook enforcing same-origin redirects + SSRF. */
export function buildRedirectGuard(cfg: SsrfConfig, origin: string) {
  return (_options: unknown, response: { headers: Record<string, string | string[] | undefined> }) => {
    const location = response.headers["location"];
    const target = Array.isArray(location) ? location[0] : location;
    if (!target) return;

    let resolved: URL;
    try {
      resolved = new URL(target, origin);
    } catch {
      throw new SsrfError(`Invalid redirect target: ${target}`);
    }

    if (cfg.sameOriginRedirectsOnly) {
      const originUrl = new URL(origin);
      if (resolved.origin !== originUrl.origin) {
        throw new SsrfError(`Cross-origin redirect blocked: ${resolved.origin}`);
      }
    }
    assertUrlAllowed(resolved.toString(), cfg);
  };
}
