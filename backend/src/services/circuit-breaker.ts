/**
 * Circuit Breaker
 *
 * Generic circuit breaker for external service dependencies (Soroban RPC,
 * Pinata, public IPFS gateways). Prevents cascading failures by failing
 * fast once a dependency is known to be degraded, instead of letting every
 * caller run its own retry/timeout logic against a service that is down.
 *
 * States:
 *  - closed:    requests pass through; failures are counted in a rolling window
 *  - open:      requests fail immediately without calling the service
 *  - half_open: a limited number of test requests are allowed through to
 *               probe recovery; success closes the circuit, failure reopens it
 */

import { log } from "./logger.js";
import { circuitBreakerState, circuitBreakerTripsTotal } from "./metrics.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive/rolling-window failures before the circuit opens */
  failureThreshold: number;
  /** How long the circuit stays open before allowing a probe request */
  resetTimeoutMs: number;
  /** Rolling window over which failures are counted (ms) */
  failureWindowMs?: number;
}

export interface CircuitBreakerMetrics {
  name: string;
  state: CircuitState;
  failureCount: number;
  tripCount: number;
  lastFailureAt: string | null;
  lastStateChangeAt: string;
  openedTotalMs: number;
}

const STATE_VALUE: Record<CircuitState, number> = {
  closed: 0,
  open: 1,
  half_open: 2,
};

export class CircuitBreakerOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker open for "${name}" — failing fast`);
    this.name = "CircuitBreakerOpenError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureTimestamps: number[] = [];
  private tripCount = 0;
  private lastFailureAt: number | null = null;
  private lastStateChangeAt = Date.now();
  private openedAt: number | null = null;
  private openedTotalMs = 0;
  private halfOpenInFlight = false;

  constructor(
    private readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    circuitBreakerState.set({ breaker: this.name }, STATE_VALUE[this.state]);
  }

  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  getMetrics(): CircuitBreakerMetrics {
    this.maybeTransitionToHalfOpen();
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureTimestamps.length,
      tripCount: this.tripCount,
      lastFailureAt: this.lastFailureAt
        ? new Date(this.lastFailureAt).toISOString()
        : null,
      lastStateChangeAt: new Date(this.lastStateChangeAt).toISOString(),
      openedTotalMs:
        this.openedTotalMs + (this.openedAt ? Date.now() - this.openedAt : 0),
    };
  }

  /**
   * Run fn through the breaker. Throws CircuitBreakerOpenError immediately
   * without calling fn if the circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionToHalfOpen();

    if (this.state === "open") {
      throw new CircuitBreakerOpenError(this.name);
    }

    if (this.state === "half_open") {
      // Only allow one probe request at a time while half-open
      if (this.halfOpenInFlight) {
        throw new CircuitBreakerOpenError(this.name);
      }
      this.halfOpenInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      this.halfOpenInFlight = false;
    }
  }

  private onSuccess(): void {
    this.failureTimestamps = [];
    if (this.state !== "closed") {
      this.transitionTo("closed");
    }
  }

  private onFailure(): void {
    const now = Date.now();
    this.lastFailureAt = now;

    if (this.state === "half_open") {
      this.transitionTo("open");
      return;
    }

    const windowMs = this.options.failureWindowMs ?? 30_000;
    this.failureTimestamps.push(now);
    this.failureTimestamps = this.failureTimestamps.filter(
      (t) => now - t <= windowMs,
    );

    if (this.failureTimestamps.length >= this.options.failureThreshold) {
      this.transitionTo("open");
    }
  }

  private maybeTransitionToHalfOpen(): void {
    if (
      this.state === "open" &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.options.resetTimeoutMs
    ) {
      this.transitionTo("half_open");
    }
  }

  private transitionTo(next: CircuitState): void {
    const previous = this.state;
    if (previous === next) return;

    if (previous === "open" && this.openedAt !== null) {
      this.openedTotalMs += Date.now() - this.openedAt;
      this.openedAt = null;
    }
    if (next === "open") {
      this.openedAt = Date.now();
      this.tripCount++;
      circuitBreakerTripsTotal.inc({ breaker: this.name });
    }

    this.state = next;
    this.lastStateChangeAt = Date.now();
    this.failureTimestamps = [];
    circuitBreakerState.set({ breaker: this.name }, STATE_VALUE[next]);

    log("warn", "circuit_breaker_state_change", {
      breaker: this.name,
      from: previous,
      to: next,
    });
  }
}

// ============================================
// REGISTRY (for /health exposure)
// ============================================

const registry = new Map<string, CircuitBreaker>();

export function registerCircuitBreaker(
  name: string,
  options: CircuitBreakerOptions,
): CircuitBreaker {
  const existing = registry.get(name);
  if (existing) return existing;
  const breaker = new CircuitBreaker(name, options);
  registry.set(name, breaker);
  return breaker;
}

export function getAllCircuitBreakerMetrics(): CircuitBreakerMetrics[] {
  return Array.from(registry.values()).map((b) => b.getMetrics());
}
