// ── FIFO queue of abortable waiters with deadlines ───────────────
// Shared by the token bucket and the bulkhead.

export interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  deadline: number;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

export function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error && r.name === "AbortError" ? r : new DOMException("Aborted", "AbortError");
}

export class WaitQueue {
  private readonly items: Waiter[] = [];

  get length(): number {
    return this.items.length;
  }

  peek(): Waiter | undefined {
    return this.items[0];
  }

  /** Enqueue; resolves when `release()`d, rejects on abort. */
  enqueue(maxWaitMs: number, signal: AbortSignal | undefined, onRemoved: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, deadline: Date.now() + maxWaitMs, signal, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          this.remove(waiter);
          onRemoved();
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.items.push(waiter);
    });
  }

  /** Remove and return the head (detaching its abort listener). */
  shift(): Waiter | undefined {
    const w = this.items.shift();
    if (w) this.detach(w);
    return w;
  }

  /** Reject every waiter whose deadline passed. */
  expire(now: number, error: () => Error): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const w = this.items[i];
      if (w && now > w.deadline) {
        this.items.splice(i, 1);
        this.detach(w);
        w.reject(error());
      }
    }
  }

  drainAll(reason: Error): void {
    for (const w of this.items.splice(0)) {
      this.detach(w);
      w.reject(reason);
    }
  }

  private remove(w: Waiter): void {
    const i = this.items.indexOf(w);
    if (i !== -1) this.items.splice(i, 1);
  }

  private detach(w: Waiter): void {
    if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
  }
}
