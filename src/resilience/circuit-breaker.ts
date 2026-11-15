// ── Circuit breaker (closed → open → half-open) ──────────────────
//
// Trips on consecutive failures or on a failure rate over a rolling window
// that is bounded by both count and age. Protocol: every attempt that got
// `true` from `tryAcquire()` reports exactly once via recordSuccess(),
// recordFailure() or recordNeutral().

import type { CircuitBreakerConfig, CircuitState } from "../types/resilience";

export interface CircuitTransition {
  from: CircuitState;
  to: CircuitState;
  failureCount: number;
}

export type CircuitStateChangeListener = (ctx: CircuitTransition) => void;

interface Outcome {
  at: number;
  failure: boolean;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private halfOpenInFlight = 0;
  private openedAt = 0;
  private window: Outcome[] = [];

  private readonly failureThreshold: number;
  private readonly failureRateThreshold: number | undefined;
  private readonly rollingWindow: number;
  private readonly rollingWindowMs: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly halfOpenMaxConcurrent: number;
  private readonly failureStatusCodes: ReadonlySet<number>;

  constructor(
    config: CircuitBreakerConfig,
    private readonly onChange?: CircuitStateChangeListener,
  ) {
    this.failureThreshold = Math.max(1, config.failureThreshold ?? 5);
    this.failureRateThreshold = config.failureRateThreshold;
    this.rollingWindow = Math.max(1, config.rollingWindow ?? 20);
    this.rollingWindowMs = Math.max(1, config.rollingWindowMs ?? 60_000);
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
    this.successThreshold = Math.max(1, config.successThreshold ?? 2);
    this.halfOpenMaxConcurrent = Math.max(1, config.halfOpenMaxConcurrent ?? 1);
    this.failureStatusCodes = new Set(config.failureStatusCodes ?? [500, 502, 503, 504]);
  }

  isFailureStatus(status: number): boolean {
    return this.failureStatusCodes.has(status);
  }

  getState(): CircuitState {
    if (this.state === "open" && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.halfOpenInFlight = 0;
      this.halfOpenSuccesses = 0;
      this.transition("half-open");
    }
    return this.state;
  }

  tryAcquire(): boolean {
    const state = this.getState();
    if (state === "closed") return true;
    if (state === "open") return false;
    if (this.halfOpenInFlight >= this.halfOpenMaxConcurrent) return false;
    this.halfOpenInFlight++;
    return true;
  }

  retryAfterMs(): number {
    if (this.getState() !== "open") return 0;
    return Math.max(0, this.resetTimeoutMs - (Date.now() - this.openedAt));
  }

  recordSuccess(): void {
    this.push(false);
    if (this.state === "half-open") {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) this.reset();
    } else if (this.state === "closed") {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(): void {
    this.push(true);
    if (this.state === "half-open") {
      this.open();
      return;
    }
    // Late failures of requests started before opening must not extend the cooldown.
    if (this.state === "open") return;

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.open();
      return;
    }

    if (this.failureRateThreshold !== undefined && this.window.length >= this.rollingWindow) {
      const failures = this.window.reduce((n, o) => n + (o.failure ? 1 : 0), 0);
      if (failures / this.window.length >= this.failureRateThreshold) this.open();
    }
  }

  /** Release a probe slot without counting success or failure. */
  recordNeutral(): void {
    if (this.state === "half-open") this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
  }

  /** Report an HTTP status for an acquired attempt. */
  recordStatus(status: number): void {
    if (this.isFailureStatus(status)) this.recordFailure();
    else if (status < 500) this.recordSuccess();
    else this.recordNeutral();
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.halfOpenInFlight = 0;
    this.window = [];
    this.transition("closed");
  }

  private open(): void {
    this.openedAt = Date.now();
    this.halfOpenSuccesses = 0;
    this.halfOpenInFlight = 0;
    this.transition("open");
  }

  private push(failure: boolean): void {
    const now = Date.now();
    this.window.push({ at: now, failure });
    const from = now - this.rollingWindowMs;
    while (this.window.length > this.rollingWindow || (this.window[0] && this.window[0].at < from)) {
      this.window.shift();
    }
  }

  private transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.onChange?.({ from, to, failureCount: this.consecutiveFailures });
  }
}
