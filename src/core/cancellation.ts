// ── Per-request cancellation without AbortSignal.any / .timeout ──
//
// `AbortSignal.any()` and `AbortSignal.timeout()` allocate dependent signals
// tracked through WeakRefs; at thousands of requests per second they were the
// single largest cost of the engine (≈40 % of its CPU time, mostly GC). One
// AbortController per request, linked with plain listeners that are removed
// when the request settles, does the same job for a fraction of the cost and
// records *why* it aborted.

export type AbortCause = "caller" | "deadline" | "dispose" | "shared" | "local";

export class Cancellation {
  private readonly controller = new AbortController();
  private cleanups: Array<() => void> = [];
  private _cause: AbortCause | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /** Why the request was aborted (first cause wins). */
  get cause(): AbortCause | undefined {
    return this._cause;
  }

  abort(cause: AbortCause): void {
    if (this._cause !== undefined) return;
    this._cause = cause;
    this.release();
    this.controller.abort(new DOMException(`Request aborted (${cause})`, "AbortError"));
  }

  /** Abort when `signal` aborts. */
  follow(signal: AbortSignal | undefined, cause: AbortCause): this {
    if (!signal || this._cause !== undefined) return this;
    if (signal.aborted) {
      this.abort(cause);
      return this;
    }
    const onAbort = (): void => this.abort(cause);
    signal.addEventListener("abort", onAbort, { once: true });
    this.cleanups.push(() => signal.removeEventListener("abort", onAbort));
    return this;
  }

  /** Abort after `ms` (no-op for 0 / negative). */
  deadline(ms: number | undefined): this {
    if (!ms || ms <= 0 || this._cause !== undefined) return this;
    const timer = setTimeout(() => this.abort("deadline"), ms);
    timer.unref?.();
    this.cleanups.push(() => clearTimeout(timer));
    return this;
  }

  /** Detach from every source (call once the request has settled). */
  release(): void {
    const list = this.cleanups;
    this.cleanups = [];
    for (const fn of list) fn();
  }
}

/** Tracks live cancellations so `dispose()` can abort them in O(n) without listeners on a shared signal. */
export class CancellationRegistry {
  private readonly active = new Set<Cancellation>();
  private closed = false;

  get size(): number {
    return this.active.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  register(c: Cancellation): Cancellation {
    if (this.closed) c.abort("dispose");
    else this.active.add(c);
    return c;
  }

  unregister(c: Cancellation): void {
    this.active.delete(c);
  }

  /** Create a cancellation that is aborted by `abortAll()`. */
  create(): Cancellation {
    return this.register(new Cancellation());
  }

  abortAll(): void {
    this.closed = true;
    for (const c of [...this.active]) c.abort("dispose");
    this.active.clear();
  }
}
