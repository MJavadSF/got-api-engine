// =================================================================
// got-api-engine — Token Bucket Rate Limiter
//
// Smooth client-side rate limiting. Tokens refill continuously at
// requestsPerInterval / intervalMs. In "wait" mode callers join a FIFO queue
// (fair, no thundering herd, one timer regardless of queue length); in
// "reject" mode an empty bucket fails fast. Waiters honour AbortSignal.
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

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  deadline: number;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly queue: Waiter[] = [];
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

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** Number of callers currently waiting for a token. */
  get pending(): number {
    return this.queue.length;
  }

  /** Acquire a token. Resolves when granted; rejects on reject-mode, timeout or abort. */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    this.refill();

    // Fast path — only when nobody is queued ahead of us (FIFO fairness).
    if (this.queue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    if (this.onLimit === "reject") return Promise.reject(new RateLimitError());

    // If we could never be served before our deadline, fail immediately
    // instead of holding a queue slot.
    const tokensNeeded = this.queue.length + 1 - this.tokens;
    if (tokensNeeded / this.refillPerMs > this.maxWaitMs) {
      return Promise.reject(new RateLimitError("Rate limit wait would exceed maxWaitMs."));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        deadline: Date.now() + this.maxWaitMs,
        signal,
        onAbort: undefined,
      };
      if (signal) {
        waiter.onAbort = () => {
          this.remove(waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.schedule();
    });
  }

  private remove(waiter: Waiter): void {
    const i = this.queue.indexOf(waiter);
    if (i !== -1) this.queue.splice(i, 1);
    if (this.queue.length === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return;
    this.refill();
    const needed = Math.max(0, 1 - this.tokens);
    const waitMs = Math.max(1, Math.ceil(needed / this.refillPerMs));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, waitMs);
    // Never keep the process alive just for the limiter.
    this.timer.unref?.();
  }

  private drain(): void {
    this.refill();
    const now = Date.now();
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (now > head.deadline) {
        this.queue.shift();
        this.detach(head);
        head.reject(new RateLimitError("Rate limit wait exceeded maxWaitMs."));
        continue;
      }
      if (this.tokens < 1) break;
      this.tokens -= 1;
      this.queue.shift();
      this.detach(head);
      head.resolve();
    }
    this.schedule();
  }

  private detach(w: Waiter): void {
    if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
  }

  /** Reject all waiters and stop timers (used by engine.dispose()). */
  dispose(reason: Error = new RateLimitError("Rate limiter disposed.")): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.queue.splice(0)) {
      this.detach(w);
      w.reject(reason);
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error && r.name === "AbortError" ? r : new DOMException("Aborted", "AbortError");
}
