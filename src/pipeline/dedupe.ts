// ── Single-flight for identical in-flight requests ───────────────
//
// The shared execution runs on its own AbortController. Each caller holds a
// reference; the shared work is aborted only when *every* caller has given
// up. So callers with their own AbortSignal (e.g. Next.js `req.signal`) can
// still be collapsed safely.

export interface FlightHandle<T> {
  promise: Promise<T>;
  leader: boolean;
}

interface Flight<T> {
  promise: Promise<T>;
  controller: AbortController;
  refs: number;
}

export class SingleFlight<T> {
  private readonly flights = new Map<string, Flight<T>>();

  get size(): number {
    return this.flights.size;
  }

  /**
   * Join or start the flight for `key`. `run` receives the shared signal.
   * Resolves with the shared result, or rejects with an AbortError when
   * `callerSignal` aborts first (the flight continues for the others).
   */
  join(key: string, callerSignal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): FlightHandle<T> {
    // An already-aborted caller must not start (or weaken) a shared flight.
    if (callerSignal?.aborted) {
      return { leader: true, promise: Promise.reject(new DOMException("Aborted", "AbortError")) };
    }
    let flight = this.flights.get(key);
    const leader = !flight;
    if (!flight) {
      const controller = new AbortController();
      const created: Flight<T> = { controller, refs: 0, promise: undefined as unknown as Promise<T> };
      created.promise = run(controller.signal).finally(() => {
        if (this.flights.get(key) === created) this.flights.delete(key);
      });
      this.flights.set(key, created);
      flight = created;
    }
    flight.refs++;
    const f = flight;
    return { leader, promise: this.follow(key, f, callerSignal) };
  }

  /** Wait for the flight on behalf of one caller; the caller's abort only releases its reference. */
  private follow(key: string, flight: Flight<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) {
      return flight.promise.finally(() => {
        flight.refs--;
      });
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = (): void =>
        settle(() => {
          this.release(key, flight);
          reject(new DOMException("Aborted", "AbortError"));
        });
      signal.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (v) =>
          settle(() => {
            flight.refs--;
            resolve(v);
          }),
        (e: unknown) =>
          settle(() => {
            flight.refs--;
            reject(e);
          }),
      );
    });
  }

  /** Drop one reference; when nobody waits any more, cancel and let later callers start afresh. */
  private release(key: string, flight: Flight<T>): void {
    flight.refs--;
    if (flight.refs > 0) return;
    if (this.flights.get(key) === flight) this.flights.delete(key);
    flight.controller.abort(new DOMException("All callers aborted", "AbortError"));
  }

  clear(): void {
    for (const f of this.flights.values()) f.controller.abort();
    this.flights.clear();
  }
}
