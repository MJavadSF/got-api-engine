// ── Host matching + credential scoping ───────────────────────────

export function normalizeHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

/** Exact host, or `*.suffix` (matches the suffix itself and any subdomain). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}

/** Fast matcher for the hot path: origins are normalised once. */
export function createCredentialMatcher(
  trusted: readonly string[],
  credentialHosts: readonly string[] = [],
): (url: URL) => boolean {
  const origins = new Set(trusted.map((o) => new URL(o).origin));
  return (url) => origins.has(url.origin) || credentialHosts.some((p) => hostMatches(url.hostname, p));
}

/**
 * May the engine's configured credentials be sent to `url`? Only upstream
 * origins and explicit `credentialHosts` qualify, so a caller-controlled
 * absolute URL can never harvest the engine's token.
 */
export function isCredentialTarget(
  url: string | URL,
  trusted: string | readonly string[],
  credentialHosts: readonly string[] = [],
): boolean {
  try {
    const target = typeof url === "string" ? new URL(url) : url;
    const origins = (typeof trusted === "string" ? [trusted] : trusted).map((o) => new URL(o).origin);
    if (origins.includes(target.origin)) return true;
    return credentialHosts.some((p) => hostMatches(target.hostname, p));
  } catch {
    return false;
  }
}
