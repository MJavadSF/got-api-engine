// ── Bulkhead: bounded concurrency with an optional AIMD limit ────
//
// Rate limiting caps requests per second; it does not stop a slow upstream
// from accumulating thousands of open requests. The bulkhead does.

import type { ConcurrencyConfig } from "../types/resilience";
import { abortReason, WaitQueue } from "./wait-queue";

export class ConcurrencyLimitError extends Error {
  readonly code = "CONCURRENCY_LIMITED";
  constructor(message = "Concurrency limit reached.") {
    super(message);
    this.name = "ConcurrencyLimitError";
  }
}

export type Release = (outcome?: "success" | "overload" | "neutral") => void;

export class Bulkhead {
  private inFlight = 0;
  private limit: number;
  private readonly min: number;
  private readonly max: number;
  private readonly adaptive: boolean;
  private readonly maxQueue: number;
  private readonly maxWaitMs: number;
  private readonly queue = new WaitQueue();

  constructor(config: ConcurrencyConfig) {
    this.max = Math.max(1, Math.floor(config.max));
    this.adaptive = Boolean(config.adaptive);
    const min = typeof config.adaptive === "object" ? (config.adaptive.min ?? 1) : 1;
    this.min = Math.min(this.max, Math.max(1, min));
    this.limit = this.max;
    this.maxQueue = config.maxQueue ?? Number.POSITIVE_INFINITY;
    this.maxWaitMs = config.maxWaitMs ?? 10_000;
  }

  get active(): number {
    return this.inFlight;
  }

  get pending(): number {
    return this.queue.length;
  }

  get currentLimit(): number {
    return Math.floor(this.limit);
  }

  tryAcquire(): Release | null {
    if (this.inFlight >= this.currentLimit || this.queue.length > 0) return null;
    this.inFlight++;
    return this.releaser();
  }

  async acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) throw abortReason(signal);
    const fast = this.tryAcquire();
    if (fast) return fast;
    if (this.queue.length >= this.maxQueue) throw new ConcurrencyLimitError("Concurrency queue is full.");
    const timer = setTimeout(() => this.queue.expire(Date.now(), () => new ConcurrencyLimitError()), this.maxWaitMs + 1);
    timer.unref?.();
    try {
      await this.queue.enqueue(this.maxWaitMs, signal, () => undefined);
    } finally {
      clearTimeout(timer);
    }
    // The slot was reserved for us by `pump()`.
    return this.releaser();
  }

  private releaser(): Release {
    let done = false;
    return (outcome = "neutral") => {
      if (done) return;
      done = true;
      this.inFlight--;
      if (this.adaptive) this.adjust(outcome);
      this.pump();
    };
  }

  private adjust(outcome: "success" | "overload" | "neutral"): void {
    if (outcome === "overload") this.limit = Math.max(this.min, this.limit * 0.9);
    else if (outcome === "success") this.limit = Math.min(this.max, this.limit + 1 / this.limit);
  }

  /** Hand freed slots to queued waiters (the slot is reserved before resuming them). */
  private pump(): void {
    while (this.queue.length > 0 && this.inFlight < this.currentLimit) {
      const w = this.queue.shift();
      if (!w) break;
      this.inFlight++;
      w.resolve();
    }
  }

  dispose(): void {
    this.queue.drainAll(new ConcurrencyLimitError("Bulkhead disposed."));
  }
}
