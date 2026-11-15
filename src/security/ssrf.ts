// ── SSRF guard: static URL checks, connect-time DNS checks, redirects ──

import dns from "node:dns";
import net from "node:net";
import type { SsrfConfig } from "../types/security";
import { hostMatches, normalizeHost } from "./hosts";

export class SsrfError extends Error {
  readonly code = "SSRF_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
    Object.setPrototypeOf(this, SsrfError.prototype);
  }
}

/** Find an SsrfError inside got's error wrapping (`cause` chain). */
export function findSsrfError(error: unknown): SsrfError | undefined {
  let cur: unknown = error;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof SsrfError) return cur;
    if (typeof cur === "object" && (cur as { code?: unknown }).code === "SSRF_BLOCKED") {
      return new SsrfError(cur instanceof Error ? cur.message : "Blocked by SSRF protection.");
    }
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return undefined;
}

// Node's BlockList also understands IPv4-mapped IPv6 (::ffff:a.b.c.d).
const blockList = new net.BlockList();
const V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const V6: ReadonlyArray<readonly [string, number]> = [
  ["::", 96], // unspecified + deprecated IPv4-compatible (::a.b.c.d)
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64],
  ["2001::", 32], // Teredo (embeds IPv4)
  ["2001:10::", 28], // ORCHID
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 (embeds IPv4)
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];
for (const [addr, prefix] of V4) blockList.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of V6) blockList.addSubnet(addr, prefix, "ipv6");

/** True if the literal IP is private / loopback / reserved. */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 0) return false;
  return blockList.check(ip, kind === 4 ? "ipv4" : "ipv6");
}

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

function isPrivateHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return isPrivateAddress(host);
}

export function resolveSsrfConfig(input: boolean | SsrfConfig | undefined): SsrfConfig | null {
  if (!input) return null;
  if (input === true) {
    return { enabled: true, allowPrivateNetworks: false, sameOriginRedirectsOnly: true, checkResolvedAddresses: true };
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
  if (parsed.username || parsed.password) throw new SsrfError("Blocked URL containing embedded credentials.");

  const host = parsed.hostname;
  if (cfg.blockHosts?.some((p) => hostMatches(host, p))) throw new SsrfError(`Host is blocklisted: ${host}`);
  if (cfg.allowHosts && cfg.allowHosts.length > 0) {
    if (!cfg.allowHosts.some((p) => hostMatches(host, p))) throw new SsrfError(`Host not in allowlist: ${host}`);
    return; // allowlist is authoritative
  }
  if (!cfg.allowPrivateNetworks && isPrivateHostname(host)) {
    throw new SsrfError(`Blocked request to private/loopback host: ${host}`);
  }
}

/** Callback of a `dns.lookup`-compatible function. */
export type DnsLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;
/** `dns.lookup`-compatible function. */
export type DnsLookupFn = (hostname: string, options: dns.LookupOptions, cb: DnsLookupCallback) => void;

/**
 * `dns.lookup`-compatible function refusing private results. Checks the exact
 * addresses the socket connects to — defeats DNS rebinding.
 */
export function buildGuardedLookup(cfg: SsrfConfig, inner: DnsLookupFn = dns.lookup as unknown as DnsLookupFn): DnsLookupFn {
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

/** Validate a redirect hop (`from` = URL being redirected). */
export function assertRedirectAllowed(target: URL, from: URL | undefined, cfg: SsrfConfig): void {
  if (cfg.sameOriginRedirectsOnly && from && target.origin !== from.origin) {
    throw new SsrfError(`Cross-origin redirect blocked: ${target.origin}`);
  }
  assertUrlAllowed(target, cfg);
}
