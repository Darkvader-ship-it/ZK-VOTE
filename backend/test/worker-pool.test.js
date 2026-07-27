import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-worker-test-"));

test.after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

test("DbWorkerPool initialization, read/write execution, round-robin, and metrics", async () => {
  const { DbWorkerPool } = await import("../src/services/dbWorkerPool.ts");
  const dbPath = path.join(TEST_DIR, "worker_test.db");

  const pool = new DbWorkerPool(dbPath);
  await pool.init({ numReaders: 3 });

  // 1. DDL write execution
  await pool.execWrite(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      val INTEGER NOT NULL
    );
  `);

  // 2. Write operations
  const insert1 = await pool.executeWrite("INSERT INTO items (name, val) VALUES (?, ?)", ["Item 1", 100]);
  assert.ok(insert1.changes === 1);

  const insert2 = await pool.executeWrite("INSERT INTO items (name, val) VALUES (?, ?)", ["Item 2", 200]);
  assert.ok(insert2.changes === 1);

  // 3. Read queries (round-robin across 3 reader workers)
  const rows = await pool.queryRead("SELECT * FROM items ORDER BY id ASC");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Item 1");

  const singleRow = await pool.queryReadOne("SELECT * FROM items WHERE name = ?", ["Item 2"]);
  assert.ok(singleRow);
  assert.equal(singleRow.val, 200);

  // 4. Verify metrics
  const metrics = pool.getMetrics();
  assert.equal(metrics.writerActive, true);
  assert.equal(metrics.activeReadersCount, 3);
  assert.ok(metrics.totalQueriesHandled >= 4);
  assert.equal(metrics.crashesCount, 0);

  await pool.close();
});

test("DbWorkerPool concurrent load and performance benchmark", async () => {
  const { DbWorkerPool } = await import("../src/services/dbWorkerPool.ts");
  const dbPath = path.join(TEST_DIR, "benchmark_test.db");

  const pool = new DbWorkerPool(dbPath);
  await pool.init({ numReaders: 4 });

  await pool.execWrite(`
    CREATE TABLE IF NOT EXISTS benchmark_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT,
      created_at TEXT
    );
  `);

  // Concurrently dispatch 20 read queries and 5 write queries
  const startTime = Date.now();
  const writePromises = Array.from({ length: 5 }, (_, i) =>
    pool.executeWrite("INSERT INTO benchmark_data (data, created_at) VALUES (?, ?)", [
      `Data payload ${i}`,
      new Date().toISOString(),
    ])
  );

  const readPromises = Array.from({ length: 20 }, (_, i) =>
    pool.queryRead("SELECT COUNT(*) as count FROM benchmark_data")
  );

  await Promise.all([...writePromises, ...readPromises]);
  const totalMs = Date.now() - startTime;

  const metrics = pool.getMetrics();
  assert.ok(metrics.totalQueriesHandled >= 25);
  assert.ok(totalMs < 5000);

  await pool.close();
});
