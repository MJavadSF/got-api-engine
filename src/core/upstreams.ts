// ── Upstream pool: failover / round-robin across base URLs ───────

export interface Upstream {
  /** Base URL without trailing slash. */
  readonly base: string;
  readonly origin: string;
  /** Parsed `base` (do not mutate). */
  readonly url: URL;
  unhealthyUntil: number;
}

export class UpstreamPool {
  readonly upstreams: readonly Upstream[];
  private cursor = 0;

  constructor(
    bases: readonly string[],
    private readonly strategy: "failover" | "round-robin",
    private readonly cooldownMs: number,
  ) {
    this.upstreams = bases.map((base) => {
      const url = new URL(base);
      return { base, url, origin: url.origin, unhealthyUntil: 0 };
    });
  }

  /** Primary base — used for canonical URLs (cache keys, logs). */
  get primary(): Upstream {
    return this.upstreams[0] as Upstream;
  }

  get origins(): string[] {
    return [...new Set(this.upstreams.map((u) => u.origin))];
  }

  /**
   * Pick an upstream for an attempt, avoiding `exclude` (already tried) and
   * unhealthy ones when possible.
   */
  pick(exclude: ReadonlySet<string> = new Set()): Upstream {
    const now = Date.now();
    const healthy = this.upstreams.filter((u) => u.unhealthyUntil <= now && !exclude.has(u.base));
    const untried = this.upstreams.filter((u) => !exclude.has(u.base));
    const pool = healthy.length ? healthy : untried.length ? untried : this.upstreams;
    if (this.strategy === "failover" || pool.length === 1) return pool[0] as Upstream;
    const chosen = pool[this.cursor % pool.length] as Upstream;
    this.cursor = (this.cursor + 1) % 1_000_000;
    return chosen;
  }

  markUnhealthy(base: string): void {
    if (this.upstreams.length < 2) return;
    const u = this.upstreams.find((x) => x.base === base);
    if (u) u.unhealthyUntil = Date.now() + this.cooldownMs;
  }

  markHealthy(base: string): void {
    const u = this.upstreams.find((x) => x.base === base);
    if (u) u.unhealthyUntil = 0;
  }

  /** Re-target a canonical URL (built on the primary base) at `upstream`. */
  rebase(canonicalUrl: string, upstream: Upstream): string {
    const primary = this.primary.base;
    return upstream.base === primary || !canonicalUrl.startsWith(primary)
      ? canonicalUrl
      : upstream.base + canonicalUrl.slice(primary.length);
  }

  health(): Array<{ origin: string; healthy: boolean }> {
    const now = Date.now();
    return this.upstreams.map((u) => ({ origin: u.base, healthy: u.unhealthyUntil <= now }));
  }
}
