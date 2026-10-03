// =================================================================
// got-api-engine — Security utilities
//   • SSRF guard: URL checks, connect-time DNS-result checks, redirect guard
//   • Credential scoping: never send engine credentials to foreign origins
//   • Redaction: strip sensitive values from log metadata and URLs
// =================================================================

import dns from "node:dns";
import net from "node:net";
import type { LoggerInterface, SsrfConfig } from "../types";

// ── Default sensitive keys redacted from logs ────────────────────
const DEFAULT_REDACT_KEYS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "api_key",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "password",
  "passwd",
  "secret",
  "client_secret",
  "signature",
];

const REDACTED = "[REDACTED]";

export type Redactor = (meta: unknown) => unknown;

export function buildRedactor(extraKeys: string[] = []): Redactor {
  const keys = new Set([...DEFAULT_REDACT_KEYS, ...extraKeys.map((k) => k.toLowerCase())]);

  const redactString = (v: string): string => {
    if (/^(Bearer|Basic|Digest|ApiKey|Token)\s+\S+/i.test(v)) return REDACTED;
    if (/^https?:\/\//i.test(v)) return redactUrlWith(v, keys);
    return v;
  };

  const redact = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof value === "string") return redactString(value);
    if (depth > 6 || value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
    if (value instanceof Error) {
      return { name: value.name, message: redactString(value.message) };
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keys.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1, seen);
    }
    return out;
  };

  return (meta: unknown) => redact(meta, 0, new WeakSet());
}

function redactUrlWith(url: string, keys: Set<string>): string {
  try {
    const u = new URL(url);
    let changed = false;
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      changed = true;
    }
    for (const key of [...u.searchParams.keys()]) {
      if (keys.has(key.toLowerCase())) {
        u.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? u.toString().replaceAll("%5BREDACTED%5D", REDACTED) : url;
  } catch {
    return url;
  }
}

/** Redact credentials and sensitive query parameters from a URL for logging. */
export function redactUrl(url: string, extraKeys: string[] = []): string {
  return redactUrlWith(url, new Set([...DEFAULT_REDACT_KEYS, ...extraKeys.map((k) => k.toLowerCase())]));
}

/**
 * Wrap a logger so every metadata object passes through the redactor. This
 * makes redaction apply to *all* log output, including custom loggers.
 */
export function withRedaction(base: LoggerInterface, redact: Redactor): LoggerInterface {
  const wrap = (l: LoggerInterface): LoggerInterface => {
    const call =
      (level: "debug" | "info" | "warn" | "error") =>
      (message: string, meta?: Record<string, unknown>): void => {
        l[level](message, meta ? (redact(meta) as Record<string, unknown>) : undefined);
      };
    const wrapped: LoggerInterface = {
      debug: call("debug"),
      info: call("info"),
      warn: call("warn"),
      error: call("error"),
    };
    if (l.child) {
      wrapped.child = (childMeta) => wrap(l.child!(redact(childMeta) as Record<string, unknown>));
    }
    return wrapped;
  };
  return wrap(base);
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

/** Find an SsrfError inside got's error wrapping (`error.cause` chain). */
export function findSsrfError(error: unknown): SsrfError | undefined {
  let cur: unknown = error;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof SsrfError) return cur;
    if (typeof cur === "object" && (cur as { code?: unknown }).code === "SSRF_BLOCKED") {
      return new SsrfError(cur instanceof Error ? cur.message : "Blocked by SSRF protection.");
    }
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return undefined;
}

// Private / reserved ranges. Uses Node's BlockList, which also understands
// IPv4-mapped IPv6 (::ffff:a.b.c.d and its normalized hex form ::ffff:xxxx:xxxx).
const blockList = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata 169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blockList.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64 (can embed private IPv4)
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (can embed private IPv4)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blockList.addSubnet(addr, prefix, "ipv6");
}

/** True if the literal IP address is in a private / loopback / reserved range. */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 0) return false;
  return blockList.check(ip, kind === 4 ? "ipv4" : "ipv6");
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isPrivateHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  return isPrivateAddress(host);
}

function hostMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
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
      checkResolvedAddresses: true,
    };
  }
  if (input.enabled === false) return null;
  return {
    enabled: true,
    allowPrivateNetworks: input.allowPrivateNetworks ?? false,
    sameOriginRedirectsOnly: input.sameOriginRedirectsOnly ?? true,
    checkResolvedAddresses: input.checkResolvedAddresses ?? true,
    ...(input.allowHosts ? { allowHosts: input.allowHosts } : {}),
    ...(input.blockHosts ? { blockHosts: input.blockHosts } : {}),
  };
}

/** Throws SsrfError if `url` is not permitted under `cfg`. */
export function assertUrlAllowed(url: string | URL, cfg: SsrfConfig): void {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    throw new SsrfError(`Invalid URL: ${String(url)}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SsrfError(`Blocked non-HTTP(S) protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfError("Blocked URL containing embedded credentials.");
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

/**
 * Build a redirect guard for got's `beforeRedirect` hook. It inspects the
 * *resolved* redirect URL (`updatedOptions.url`) and compares origins against
 * the origin of the request being redirected — not the engine's baseUrl.
 */
export function buildRedirectGuard(cfg: SsrfConfig) {
  return (
    updatedOptions: { url?: URL | string | undefined },
    response: { requestUrl?: URL | undefined },
  ): void => {
    const target = updatedOptions.url;
    if (!target) return;
    const resolved = typeof target === "string" ? new URL(target) : target;

    if (cfg.sameOriginRedirectsOnly && response.requestUrl) {
      if (resolved.origin !== response.requestUrl.origin) {
        throw new SsrfError(`Cross-origin redirect blocked: ${resolved.origin}`);
      }
    }
    assertUrlAllowed(resolved, cfg);
  };
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;
type LookupFn = (hostname: string, options: dns.LookupOptions, cb: LookupCallback) => void;

/**
 * A `dns.lookup`-compatible function that refuses to resolve to private
 * addresses. Passed to got as `dnsLookup`, so the check happens on the exact
 * addresses the socket will connect to — this defeats DNS rebinding and
 * public names that point at internal IPs.
 */
export function buildGuardedLookup(cfg: SsrfConfig, inner: LookupFn = dns.lookup as unknown as LookupFn): LookupFn {
  return (hostname, options, cb) => {
    const host = normalizeHost(hostname);
    const allowedByList = cfg.allowHosts?.some((p) => hostMatches(host, p)) ?? false;

    inner(hostname, options, (err, address, family) => {
      if (err) return cb(err, address, family);
      if (cfg.allowPrivateNetworks || allowedByList) return cb(null, address, family);

      const list = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad) {
        return cb(
          new SsrfError(`Blocked: ${hostname} resolves to private address ${bad.address}`) as NodeJS.ErrnoException,
          address,
          family,
        );
      }
      cb(null, address, family);
    });
  };
}

// ── Credential scoping ───────────────────────────────────────────

/**
 * May the engine's configured credentials be sent to `url`? Only the baseUrl
 * origin and explicit `credentialHosts` qualify, so a caller-controlled
 * absolute URL can never harvest the engine's token.
 */
export function isCredentialTarget(url: string, baseUrl: string, credentialHosts: string[] = []): boolean {
  try {
    const target = new URL(url);
    if (target.origin === new URL(baseUrl).origin) return true;
    return credentialHosts.some((p) => hostMatches(target.hostname, p));
  } catch {
    return false;
  }
}
