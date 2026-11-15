// ── Token bucket rate limiter ────────────────────────────────────
//
// Tokens refill continuously. "wait" mode queues callers FIFO behind a single
// timer; "reject" mode fails fast. `pauseUntil()` lets adaptive limiting
// freeze the bucket while upstream says its quota is exhausted.

import type { RateLimitConfig, RateLimiterLike } from "../types/resilience";
import { abortReason, WaitQueue } from "./wait-queue";

export class RateLimitError extends Error {
  readonly code = "RATE_LIMITED";
  constructor(message = "Client-side rate limit exceeded.") {
    super(message);
    this.name = "RateLimitError";
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export class TokenBucket implements RateLimiterLike {
  private tokens: number;
  private lastRefill: number;
  private pausedUntil = 0;
  private readonly queue = new WaitQueue();
  private timer: NodeJS.Timeout | null = null;

  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly onLimit: "wait" | "reject";
  private readonly maxWaitMs: number;

  constructor(config: RateLimitConfig) {
    const perInterval = Math.max(1, config.requestsPerInterval ?? 10);
    const intervalMs = Math.max(1, config.intervalMs ?? 1000);
    this.capacity = Math.max(1, config.burst ?? perInterval);
    this.refillPerMs = perInterval / intervalMs;
    this.onLimit = config.onLimit ?? "wait";
    this.maxWaitMs = config.maxWaitMs ?? 10_000;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  get pending(): number {
    return this.queue.length;
  }

  private refill(now = Date.now()): void {
    const elapsed = now - Math.max(this.lastRefill, this.pausedUntil);
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  private paused(now = Date.now()): boolean {
    return now < this.pausedUntil;
  }

  /** Stop granting tokens until `epochMs`; the bucket restarts empty. */
  pauseUntil(epochMs: number): void {
    if (epochMs <= this.pausedUntil) return;
    this.pausedUntil = epochMs;
    this.tokens = 0;
    this.lastRefill = epochMs;
    this.reschedule();
  }

  tryAcquire(): boolean {
    if (this.paused() || this.queue.length > 0) return false;
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.tryAcquire()) return Promise.resolve();
    if (this.onLimit === "reject") return Promise.reject(new RateLimitError());

    const now = Date.now();
    const pauseMs = Math.max(0, this.pausedUntil - now);
    const tokensNeeded = this.queue.length + 1 - (this.paused(now) ? 0 : this.tokens);
    if (pauseMs + tokensNeeded / this.refillPerMs > this.maxWaitMs) {
      return Promise.reject(new RateLimitError("Rate limit wait would exceed maxWaitMs."));
    }
    const p = this.queue.enqueue(this.maxWaitMs, signal, () => this.reschedule());
    this.schedule();
    return p;
  }

  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return;
    const now = Date.now();
    this.refill(now);
    const pauseMs = Math.max(0, this.pausedUntil - now);
    const needed = Math.max(0, 1 - this.tokens);
    const waitMs = Math.max(1, pauseMs + Math.ceil(needed / this.refillPerMs));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, waitMs);
    this.timer.unref?.();
  }

  private drain(): void {
    const now = Date.now();
    this.queue.expire(now, () => new RateLimitError("Rate limit wait exceeded maxWaitMs."));
    if (!this.paused(now)) {
      this.refill(now);
      while (this.queue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        this.queue.shift()?.resolve();
      }
    }
    this.schedule();
  }

  dispose(reason: Error = new RateLimitError("Rate limiter disposed.")): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.drainAll(reason);
  }
}
