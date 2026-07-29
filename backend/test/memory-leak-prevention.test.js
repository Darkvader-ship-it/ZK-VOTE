import test from "node:test";
import assert from "node:assert/strict";

test("dbMonitor query cache stays bounded regardless of key cardinality", async () => {
  const { getCachedOrCompute, getCacheStats } = await import(
    "../src/services/dbMonitor.ts"
  );
  const { config } = await import("../src/config.ts");
  const maxEntries = config.dbQueryCacheMaxEntries;

  for (let i = 0; i < maxEntries + 50; i++) {
    getCachedOrCompute(`leak_test_key_${i}`, () => i, 60_000);
  }

  const stats = getCacheStats();
  assert.ok(
    stats.entries <= maxEntries,
    `expected cache size <= ${maxEntries}, got ${stats.entries}`,
  );
});

test("dbMonitor query cache evicts least-recently-used entry, not most-recently-touched", async () => {
  const { getCachedOrCompute, getCacheStats } = await import(
    "../src/services/dbMonitor.ts"
  );
  const { config } = await import("../src/config.ts");
  const maxEntries = config.dbQueryCacheMaxEntries;

  // Cache is now saturated with leak_test_key_* from the previous test
  // (module state persists across tests in this file). Grab the oldest
  // surviving key.
  const before = getCacheStats();
  assert.equal(before.entries, maxEntries);

  const oldestKey = "leak_test_key_50"; // first key not evicted by the prior test
  let recomputed = false;
  getCachedOrCompute(oldestKey, () => {
    recomputed = true;
    return "touched";
  }, 60_000);
  assert.equal(recomputed, false, "oldest key should still be a live hit before eviction");

  // Reading it moved it to the most-recently-used position; inserting one
  // new key should evict the *next* oldest entry instead of this one.
  getCachedOrCompute("leak_test_key_new", () => "new", 60_000);

  let recomputedAfterEviction = false;
  getCachedOrCompute(oldestKey, () => {
    recomputedAfterEviction = true;
    return "recomputed";
  }, 60_000);
  assert.equal(
    recomputedAfterEviction,
    false,
    "recently-touched entry should survive the next eviction",
  );
});

test("sync.evictOldestOverflow bounds a Map to the configured max size", async () => {
  const { evictOldestOverflow } = await import("../src/services/sync.ts");

  const map = new Map();
  for (let i = 0; i < 100; i++) {
    map.set(i, `dao-${i}`);
  }

  const bounded = evictOldestOverflow(map, 10);
  assert.equal(bounded.size, 10);
  // FIFO: the last 10 inserted keys (90..99) should survive
  for (let i = 90; i < 100; i++) {
    assert.ok(bounded.has(i), `expected key ${i} to survive eviction`);
  }
  for (let i = 0; i < 90; i++) {
    assert.ok(!bounded.has(i), `expected key ${i} to have been evicted`);
  }
});

test("sync.evictOldestOverflow is a no-op when under the limit", async () => {
  const { evictOldestOverflow } = await import("../src/services/sync.ts");

  const map = new Map([
    [1, "a"],
    [2, "b"],
  ]);
  const result = evictOldestOverflow(map, 10);
  assert.equal(result, map, "should return the same map instance when no eviction is needed");
});
