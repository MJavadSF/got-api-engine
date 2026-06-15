// =================================================================
// got-api-engine — Circuit Breaker
//
// Classic three-state breaker (closed → open → half-open) with both
// consecutive-failure and rolling failure-rate tripping. Prevents a failing
// upstream from consuming resources and gives it time to recover.
// =================================================================

import type {
  CircuitBreakerConfig,
  CircuitState,
  CircuitStateContext,
} from "../types";

export type CircuitStateChangeListener = (ctx: Omit<CircuitStateContext, "serviceName">) => void;

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private openedAt = 0;

  // Rolling window of recent outcomes (true = failure).
  private readonly window: boolean[] = [];

  private readonly failureThreshold: number;
  private readonly failureRateThreshold: number | undefined;
  private readonly rollingWindow: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly failureStatusCodes: Set<number>;

  private onChange: CircuitStateChangeListener | undefined;

  constructor(config: CircuitBreakerConfig, onChange?: CircuitStateChangeListener) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.failureRateThreshold = config.failureRateThreshold;
    this.rollingWindow = Math.max(1, config.rollingWindow ?? 20);
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
    this.successThreshold = config.successThreshold ?? 2;
    this.failureStatusCodes = new Set(config.failureStatusCodes ?? [500, 502, 503, 504]);
    this.onChange = onChange;
  }

  /** Should this status code be counted as a circuit failure? */
  isFailureStatus(status: number): boolean {
    return this.failureStatusCodes.has(status);
  }

  getState(): CircuitState {
    // Lazily transition open → half-open once the cooldown has elapsed.
    if (this.state === "open" && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.transition("half-open");
    }
    return this.state;
  }

  /** Returns true if the request should be allowed through. */
  canRequest(): boolean {
    const state = this.getState();
    return state !== "open";
  }

  /** Milliseconds until the breaker will next allow a probe (0 if allowed now). */
  retryAfterMs(): number {
    if (this.state !== "open") return 0;
    return Math.max(0, this.resetTimeoutMs - (Date.now() - this.openedAt));
  }

  recordSuccess(): void {
    this.pushWindow(false);

    if (this.state === "half-open") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) {
        this.reset();
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(): void {
    this.pushWindow(true);

    if (this.state === "half-open") {
      // Any failure during probing immediately re-opens.
      this.open();
      return;
    }

    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.open();
      return;
    }

    if (this.failureRateThreshold !== undefined && this.window.length >= this.rollingWindow) {
      const failures = this.window.reduce((n, f) => n + (f ? 1 : 0), 0);
      const rate = failures / this.window.length;
      if (rate >= this.failureRateThreshold) this.open();
    }
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.window.length = 0;
    this.transition("closed");
  }

  private open(): void {
    this.openedAt = Date.now();
    this.halfOpenSuccesses = 0;
    this.transition("open");
  }

  private pushWindow(failure: boolean): void {
    this.window.push(failure);
    if (this.window.length > this.rollingWindow) this.window.shift();
  }

  private transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.onChange?.({ from, to, failureCount: this.consecutiveFailures });
  }
}
