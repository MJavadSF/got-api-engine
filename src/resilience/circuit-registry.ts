// ── One breaker per key (host by default) ────────────────────────
//
// A single engine-wide breaker lets one failing endpoint — or bogus absolute
// URLs supplied by users — take down every other upstream.

import type { CircuitBreakerConfig, CircuitState } from "../types/resilience";
import { CircuitBreaker, type CircuitTransition } from "./circuit-breaker";

const SEVERITY: Record<CircuitState, number> = { closed: 0, "half-open": 1, open: 2 };
const MAX_BREAKERS = 1000;

export class CircuitRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly keyOf: (url: URL) => string;

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly onChange: (key: string, t: CircuitTransition) => void,
  ) {
    const scope = config.scope ?? "host";
    this.keyOf = scope === "engine" ? () => "engine" : scope === "host" ? (u) => u.host : scope;
  }

  keyFor(url: string | URL): string {
    try {
      return this.keyOf(typeof url === "string" ? new URL(url) : url);
    } catch {
      return "invalid";
    }
  }

  get(url: string | URL): CircuitBreaker {
    const key = this.keyFor(url);
    let breaker = this.breakers.get(key);
    if (!breaker) {
      if (this.breakers.size >= MAX_BREAKERS) this.evictClosed();
      breaker = new CircuitBreaker(this.config, (t) => this.onChange(key, t));
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  /** Worst state across breakers (or the state of one key). */
  state(key?: string): CircuitState {
    if (key !== undefined) return this.breakers.get(key)?.getState() ?? "closed";
    let worst: CircuitState = "closed";
    for (const b of this.breakers.values()) {
      const s = b.getState();
      if (SEVERITY[s] > SEVERITY[worst]) worst = s;
    }
    return worst;
  }

  states(): Record<string, CircuitState> {
    return Object.fromEntries([...this.breakers].map(([k, b]) => [k, b.getState()]));
  }

  reset(key?: string): void {
    if (key !== undefined) this.breakers.get(key)?.reset();
    else for (const b of this.breakers.values()) b.reset();
  }

  private evictClosed(): void {
    for (const [k, b] of this.breakers) {
      if (b.getState() === "closed") this.breakers.delete(k);
      if (this.breakers.size < MAX_BREAKERS) return;
    }
  }
}
