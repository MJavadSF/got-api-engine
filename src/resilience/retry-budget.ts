// ── Retry budget: retries capped relative to recent traffic ──────
//
// During an outage every request fails and every failure retries; without a
// budget, retries multiply the load on an already struggling upstream.

import type { RetryBudgetConfig } from "../types/resilience";

export class RetryBudget {
  private readonly ratio: number;
  private readonly minPerSec: number;
  private readonly windowMs: number;
  private requests: number[] = [];
  private retries: number[] = [];

  constructor(config: RetryBudgetConfig = {}) {
    this.ratio = Math.max(0, config.ratio ?? 0.2);
    this.minPerSec = Math.max(0, config.minPerSec ?? 5);
    this.windowMs = Math.max(1000, config.windowMs ?? 10_000);
  }

  private prune(now: number): void {
    const from = now - this.windowMs;
    if (this.requests.length && (this.requests[0] ?? 0) < from) this.requests = this.requests.filter((t) => t >= from);
    if (this.retries.length && (this.retries[0] ?? 0) < from) this.retries = this.retries.filter((t) => t >= from);
  }

  recordRequest(now = Date.now()): void {
    this.requests.push(now);
    this.prune(now);
  }

  /** Consume one retry if the budget allows it. */
  tryRetry(now = Date.now()): boolean {
    this.prune(now);
    const allowed = Math.max(this.minPerSec * (this.windowMs / 1000), this.ratio * this.requests.length);
    if (this.retries.length >= allowed) return false;
    this.retries.push(now);
    return true;
  }
}
