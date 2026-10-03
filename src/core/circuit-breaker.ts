// =================================================================
// got-api-engine — Circuit Breaker
//
// Classic three-state breaker (closed → open → half-open) with both
// consecutive-failure and rolling failure-rate tripping. In half-open only a
// bounded number of probe requests are let through.
//
// Protocol: every attempt that got `true` from `tryAcquire()` MUST report its
// outcome exactly once via recordSuccess(), recordFailure() or recordNeutral().
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
  private halfOpenInFlight = 0;
  private openedAt = 0;

  // Rolling window of recent outcomes (true = failure).
  private readonly window: boolean[] = [];

  private readonly failureThreshold: number;
  private readonly failureRateThreshold: number | undefined;
  private readonly rollingWindow: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly halfOpenMaxConcurrent: number;
  private readonly failureStatusCodes: Set<number>;

  private readonly onChange: CircuitStateChangeListener | undefined;

  constructor(config: CircuitBreakerConfig, onChange?: CircuitStateChangeListener) {
    this.failureThreshold = Math.max(1, config.failureThreshold ?? 5);
    this.failureRateThreshold = config.failureRateThreshold;
    this.rollingWindow = Math.max(1, config.rollingWindow ?? 20);
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
    this.successThreshold = Math.max(1, config.successThreshold ?? 2);
    this.halfOpenMaxConcurrent = Math.max(1, config.halfOpenMaxConcurrent ?? 1);
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
      this.halfOpenInFlight = 0;
      this.halfOpenSuccesses = 0;
      this.transition("half-open");
    }
    return this.state;
  }

  /**
   * Ask permission to send a request. In half-open this reserves one of the
   * limited probe slots.
   */
  tryAcquire(): boolean {
    const state = this.getState();
    if (state === "closed") return true;
    if (state === "open") return false;
    if (this.halfOpenInFlight >= this.halfOpenMaxConcurrent) return false;
    this.halfOpenInFlight++;
    return true;
  }

  /** Milliseconds until the breaker will next allow a probe (0 if allowed now). */
  retryAfterMs(): number {
    if (this.getState() !== "open") return 0;
    return Math.max(0, this.resetTimeoutMs - (Date.now() - this.openedAt));
  }

  recordSuccess(): void {
    this.pushWindow(false);

    if (this.state === "half-open") {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) this.reset();
    } else if (this.state === "closed") {
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
    // Late failures from requests that started before the breaker opened must
    // not extend the cooldown.
    if (this.state === "open") return;

    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.open();
      return;
    }

    if (this.failureRateThreshold !== undefined && this.window.length >= this.rollingWindow) {
      const failures = this.window.reduce((n, f) => n + (f ? 1 : 0), 0);
      if (failures / this.window.length >= this.failureRateThreshold) this.open();
    }
  }

  /** Release a probe slot without counting success or failure (e.g. aborted request). */
  recordNeutral(): void {
    if (this.state === "half-open") this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.halfOpenInFlight = 0;
    this.window.length = 0;
    this.transition("closed");
  }

  private open(): void {
    this.openedAt = Date.now();
    this.halfOpenSuccesses = 0;
    this.halfOpenInFlight = 0;
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
