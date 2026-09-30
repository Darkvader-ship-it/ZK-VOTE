import test from "node:test";
import assert from "node:assert/strict";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "../src/services/circuit-breaker.js";

test("circuit breaker starts closed and passes calls through", async () => {
  const breaker = new CircuitBreaker("test_closed", {
    failureThreshold: 3,
    resetTimeoutMs: 1000,
  });

  const result = await breaker.execute(async () => "ok");
  assert.equal(result, "ok");
  assert.equal(breaker.getState(), "closed");
});

test("circuit breaker opens after reaching the failure threshold", async () => {
  const breaker = new CircuitBreaker("test_opens", {
    failureThreshold: 3,
    resetTimeoutMs: 10_000,
  });

  for (let i = 0; i < 3; i++) {
    await assert.rejects(() =>
      breaker.execute(async () => {
        throw new Error("boom");
      }),
    );
  }

  assert.equal(breaker.getState(), "open");

  // Further calls fail fast without invoking fn
  let called = false;
  await assert.rejects(
    () =>
      breaker.execute(async () => {
        called = true;
        return "should not run";
      }),
    CircuitBreakerOpenError,
  );
  assert.equal(called, false);
});

test("circuit breaker transitions open -> half_open -> closed on recovery", async () => {
  const breaker = new CircuitBreaker("test_recovery", {
    failureThreshold: 1,
    resetTimeoutMs: 200,
  });

  await assert.rejects(() =>
    breaker.execute(async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(breaker.getState(), "open");

  // Wait for resetTimeoutMs to elapse so the breaker allows a probe request
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(breaker.getState(), "half_open");

  const result = await breaker.execute(async () => "recovered");
  assert.equal(result, "recovered");
  assert.equal(breaker.getState(), "closed");
});

test("circuit breaker reopens on a failed half-open probe", async () => {
  const breaker = new CircuitBreaker("test_reopen", {
    failureThreshold: 1,
    resetTimeoutMs: 200,
  });

  await assert.rejects(() =>
    breaker.execute(async () => {
      throw new Error("boom");
    }),
  );
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(breaker.getState(), "half_open");

  await assert.rejects(() =>
    breaker.execute(async () => {
      throw new Error("still down");
    }),
  );
  assert.equal(breaker.getState(), "open");
});

test("circuit breaker exposes trip count and state via getMetrics", async () => {
  const breaker = new CircuitBreaker("test_metrics", {
    failureThreshold: 1,
    resetTimeoutMs: 10_000,
  });

  await assert.rejects(() =>
    breaker.execute(async () => {
      throw new Error("boom");
    }),
  );

  const metrics = breaker.getMetrics();
  assert.equal(metrics.name, "test_metrics");
  assert.equal(metrics.state, "open");
  assert.equal(metrics.tripCount, 1);
  assert.ok(metrics.lastFailureAt);
});
