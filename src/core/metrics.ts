// =================================================================
// got-api-engine — Metrics Collector
//
// Lightweight, allocation-conscious runtime metrics. Latency percentiles use
// a fixed-size reservoir so memory stays bounded under sustained load.
// =================================================================

import type { CircuitState, MetricsSnapshot } from "../types";

const RESERVOIR_SIZE = 1000;

export class MetricsCollector {
  totalRequests = 0;
  successCount = 0;
  errorCount = 0;
  retryCount = 0;
  cacheHits = 0;
  cacheMisses = 0;
  dedupeHits = 0;
  rateLimitedCount = 0;
  circuitRejectedCount = 0;

  private readonly byStatus = new Map<number, number>();

  // Reservoir sampling for latency (bounded memory).
  private readonly latencies: number[] = [];
  private latencySeen = 0;
  private latencyMin = Infinity;
  private latencyMax = 0;
  private latencySum = 0;

  recordRequest(): void {
    this.totalRequests++;
  }

  recordLatency(ms: number): void {
    this.latencySeen++;
    this.latencySum += ms;
    if (ms < this.latencyMin) this.latencyMin = ms;
    if (ms > this.latencyMax) this.latencyMax = ms;

    if (this.latencies.length < RESERVOIR_SIZE) {
      this.latencies.push(ms);
    } else {
      // Standard reservoir replacement.
      const j = Math.floor(Math.random() * this.latencySeen);
      if (j < RESERVOIR_SIZE) this.latencies[j] = ms;
    }
  }

  recordStatus(status: number): void {
    this.byStatus.set(status, (this.byStatus.get(status) ?? 0) + 1);
  }

  recordSuccess(): void {
    this.successCount++;
  }
  recordError(): void {
    this.errorCount++;
  }
  recordRetry(): void {
    this.retryCount++;
  }
  recordCacheHit(): void {
    this.cacheHits++;
  }
  recordCacheMiss(): void {
    this.cacheMisses++;
  }
  recordDedupeHit(): void {
    this.dedupeHits++;
  }
  recordRateLimited(): void {
    this.rateLimitedCount++;
  }
  recordCircuitRejected(): void {
    this.circuitRejectedCount++;
  }

  private percentile(p: number): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[idx] ?? 0);
  }

  snapshot(circuitState: CircuitState): MetricsSnapshot {
    return {
      totalRequests: this.totalRequests,
      successCount: this.successCount,
      errorCount: this.errorCount,
      retryCount: this.retryCount,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      dedupeHits: this.dedupeHits,
      rateLimitedCount: this.rateLimitedCount,
      circuitRejectedCount: this.circuitRejectedCount,
      circuitState,
      latency: {
        count: this.latencySeen,
        min: this.latencySeen ? Math.round(this.latencyMin) : 0,
        max: Math.round(this.latencyMax),
        mean: this.latencySeen ? Math.round(this.latencySum / this.latencySeen) : 0,
        p50: this.percentile(50),
        p95: this.percentile(95),
        p99: this.percentile(99),
      },
      byStatus: Object.fromEntries(
        [...this.byStatus.entries()].map(([k, v]) => [String(k), v]),
      ),
    };
  }

  reset(): void {
    this.totalRequests = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.retryCount = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.dedupeHits = 0;
    this.rateLimitedCount = 0;
    this.circuitRejectedCount = 0;
    this.byStatus.clear();
    this.latencies.length = 0;
    this.latencySeen = 0;
    this.latencyMin = Infinity;
    this.latencyMax = 0;
    this.latencySum = 0;
  }
}
