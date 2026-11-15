// ── Runtime metrics (bounded memory) + Prometheus export ─────────

import type { LatencyStats, MetricsSnapshot, RouteMetrics } from "../types/observability";
import type { CircuitState } from "../types/resilience";

const RESERVOIR = 1000;
const ROUTE_RESERVOIR = 100;
const MAX_ROUTES = 200;

/** Fixed-size reservoir sample with exact min / max / mean. */
class LatencyReservoir {
  private readonly samples: number[] = [];
  private seen = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = 0;
  private sum = 0;

  constructor(private readonly size: number) {}

  add(ms: number): void {
    this.seen++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
    if (this.samples.length < this.size) this.samples.push(ms);
    else {
      const j = Math.floor(Math.random() * this.seen);
      if (j < this.size) this.samples[j] = ms;
    }
  }

  stats(): LatencyStats {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pct = (p: number): number =>
      sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0) : 0;
    return {
      count: this.seen,
      min: this.seen ? Math.round(this.min) : 0,
      max: Math.round(this.max),
      mean: this.seen ? Math.round(this.sum / this.seen) : 0,
      p50: pct(50),
      p95: pct(95),
      p99: pct(99),
    };
  }

  /** p95 without allocating a full snapshot (used by hedging). */
  p95(): number | undefined {
    if (this.samples.length < 20) return undefined;
    return this.stats().p95;
  }
}

export type MetricsCounter =
  | "totalRequests"
  | "successCount"
  | "errorCount"
  | "upstreamRequests"
  | "upstreamErrors"
  | "retryCount"
  | "hedgeCount"
  | "cacheHits"
  | "cacheMisses"
  | "staleServed"
  | "dedupeHits"
  | "rateLimitedCount"
  | "concurrencyLimitedCount"
  | "circuitRejectedCount"
  | "authRefreshes"
  | "fallbackServed";

const COUNTERS: readonly MetricsCounter[] = [
  "totalRequests",
  "successCount",
  "errorCount",
  "upstreamRequests",
  "upstreamErrors",
  "retryCount",
  "hedgeCount",
  "cacheHits",
  "cacheMisses",
  "staleServed",
  "dedupeHits",
  "rateLimitedCount",
  "concurrencyLimitedCount",
  "circuitRejectedCount",
  "authRefreshes",
  "fallbackServed",
];

interface RouteState {
  requests: number;
  errors: number;
  latency: LatencyReservoir;
}

export class MetricsCollector {
  private counters = Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<MetricsCounter, number>;
  private latency = new LatencyReservoir(RESERVOIR);
  private readonly byStatus = new Map<number, number>();
  private readonly byErrorCode = new Map<string, number>();
  private readonly routes = new Map<string, RouteState>();

  inc(counter: MetricsCounter, by = 1): void {
    this.counters[counter] += by;
  }

  /** Outcome of a `request()` call (after cache / dedupe / fallback). */
  recordResult(ok: boolean, code?: string): void {
    this.inc(ok ? "successCount" : "errorCount");
    if (!ok && code) this.byErrorCode.set(code, (this.byErrorCode.get(code) ?? 0) + 1);
  }

  /** One finished upstream attempt. */
  recordAttempt(route: string, status: number | undefined, latencyMs: number | undefined): void {
    this.inc("upstreamRequests");
    const failed = status === undefined || status >= 500;
    if (failed) this.inc("upstreamErrors");
    if (status !== undefined) this.byStatus.set(status, (this.byStatus.get(status) ?? 0) + 1);
    if (latencyMs !== undefined) this.latency.add(latencyMs);

    let r = this.routes.get(route);
    if (!r) {
      if (this.routes.size >= MAX_ROUTES) route = "other";
      r = this.routes.get(route) ?? { requests: 0, errors: 0, latency: new LatencyReservoir(ROUTE_RESERVOIR) };
      this.routes.set(route, r);
    }
    r.requests++;
    if (failed) r.errors++;
    if (latencyMs !== undefined) r.latency.add(latencyMs);
  }

  p95(): number | undefined {
    return this.latency.p95();
  }

  snapshot(circuitState: CircuitState): MetricsSnapshot {
    const byRoute: Record<string, RouteMetrics> = {};
    for (const [k, r] of this.routes) byRoute[k] = { requests: r.requests, errors: r.errors, latency: r.latency.stats() };
    return {
      ...this.counters,
      circuitState,
      latency: this.latency.stats(),
      byStatus: Object.fromEntries([...this.byStatus].map(([k, v]) => [String(k), v])),
      byErrorCode: Object.fromEntries(this.byErrorCode),
      byRoute,
    };
  }

  reset(): void {
    this.counters = Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<MetricsCounter, number>;
    this.latency = new LatencyReservoir(RESERVOIR);
    this.byStatus.clear();
    this.byErrorCode.clear();
    this.routes.clear();
  }
}

// ── Prometheus text exposition ───────────────────────────────────
const esc = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function toPrometheus(snapshot: MetricsSnapshot, prefix = "got_api_engine", labels: Record<string, string> = {}): string {
  const base = Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`);
  const lbl = (extra: Record<string, string> = {}): string => {
    const all = [...base, ...Object.entries(extra).map(([k, v]) => `${k}="${esc(v)}"`)];
    return all.length ? `{${all.join(",")}}` : "";
  };
  const lines: string[] = [];
  const counter = (name: string, help: string, value: number, extra?: Record<string, string>): void => {
    lines.push(`# HELP ${prefix}_${name} ${help}`, `# TYPE ${prefix}_${name} counter`, `${prefix}_${name}${lbl(extra)} ${value}`);
  };

  counter("requests_total", "request() calls", snapshot.totalRequests);
  counter("results_success_total", "Successful results returned", snapshot.successCount);
  counter("results_error_total", "Error results returned", snapshot.errorCount);
  counter("upstream_requests_total", "Upstream attempts", snapshot.upstreamRequests);
  counter("upstream_errors_total", "Failed upstream attempts (network or 5xx)", snapshot.upstreamErrors);
  counter("retries_total", "Retries", snapshot.retryCount);
  counter("hedges_total", "Hedged attempts", snapshot.hedgeCount);
  counter("cache_hits_total", "Cache hits", snapshot.cacheHits);
  counter("cache_misses_total", "Cache misses", snapshot.cacheMisses);
  counter("stale_served_total", "Stale responses served", snapshot.staleServed);
  counter("dedupe_hits_total", "Deduplicated requests", snapshot.dedupeHits);
  counter("rate_limited_total", "Requests rejected by the local rate limiter", snapshot.rateLimitedCount);
  counter("circuit_rejected_total", "Requests rejected by an open circuit", snapshot.circuitRejectedCount);

  lines.push(`# HELP ${prefix}_responses_total Upstream responses by status`, `# TYPE ${prefix}_responses_total counter`);
  for (const [status, n] of Object.entries(snapshot.byStatus)) lines.push(`${prefix}_responses_total${lbl({ status })} ${n}`);

  lines.push(`# HELP ${prefix}_errors_total Error results by code`, `# TYPE ${prefix}_errors_total counter`);
  for (const [code, n] of Object.entries(snapshot.byErrorCode)) lines.push(`${prefix}_errors_total${lbl({ code })} ${n}`);

  lines.push(`# HELP ${prefix}_latency_ms Upstream latency summary`, `# TYPE ${prefix}_latency_ms summary`);
  for (const [route, r] of Object.entries(snapshot.byRoute)) {
    for (const q of ["0.5", "0.95", "0.99"] as const) {
      const v = q === "0.5" ? r.latency.p50 : q === "0.95" ? r.latency.p95 : r.latency.p99;
      lines.push(`${prefix}_latency_ms${lbl({ route, quantile: q })} ${v}`);
    }
    lines.push(`${prefix}_latency_ms_count${lbl({ route })} ${r.latency.count}`);
  }

  const states: CircuitState[] = ["closed", "half-open", "open"];
  lines.push(`# HELP ${prefix}_circuit_state Worst circuit state (1 = active)`, `# TYPE ${prefix}_circuit_state gauge`);
  for (const s of states) lines.push(`${prefix}_circuit_state${lbl({ state: s })} ${snapshot.circuitState === s ? 1 : 0}`);
  return `${lines.join("\n")}\n`;
}
