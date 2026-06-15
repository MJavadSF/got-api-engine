// =================================================================
// got-api-engine — Token Bucket Rate Limiter
//
// Smooth client-side rate limiting. Tokens refill continuously at
// requestsPerInterval / intervalMs. In "wait" mode, callers await a token;
// in "reject" mode, an empty bucket fails fast.
// =================================================================

import type { RateLimitConfig } from "../types";

export class RateLimitError extends Error {
  readonly code = "RATE_LIMITED";
  constructor(message = "Client-side rate limit exceeded.") {
    super(message);
    this.name = "RateLimitError";
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

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

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** Acquire a token. Resolves when granted; rejects on reject-mode or timeout. */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    if (this.onLimit === "reject") {
      throw new RateLimitError();
    }

    // Wait mode: compute the time until one token is available.
    const deadline = Date.now() + this.maxWaitMs;
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const needed = 1 - this.tokens;
      const waitMs = Math.ceil(needed / this.refillPerMs);
      if (Date.now() + waitMs > deadline) {
        throw new RateLimitError("Rate limit wait exceeded maxWaitMs.");
      }
      await new Promise((r) => setTimeout(r, Math.min(waitMs, deadline - Date.now())));
    }
  }
}
