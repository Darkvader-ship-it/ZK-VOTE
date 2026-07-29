import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-db-test-"));

test.after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeTestDb(name) {
  return path.join(TEST_DIR, name);
}

function execPragma(db, sql) {
  return db.pragma(sql);
}

test("fresh database validates successfully", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const dbPath = makeTestDb("fresh.db");

  const database = initDb(dbPath);
  assert.ok(database);

  const row = database
    .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
    .get();
  assert.ok(row);
  assert.equal(JSON.parse(row.value), 2);

  database.close();
});

test("existing valid database passes validation", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const dbPath = makeTestDb("valid.db");

  let database = initDb(dbPath);
  database.close();

  database = initDb(dbPath);
  assert.ok(database);

  const row = database
    .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
    .get();
  assert.ok(row);
  assert.equal(JSON.parse(row.value), 2);

  database.close();
});

test("missing column is auto-added", async () => {
  const dbPath = makeTestDb("missing_column.db");
  try {
    fs.unlinkSync(dbPath);
  } catch {}

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dao_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE daos (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      creator TEXT NOT NULL
    );
  `);
  db.close();

  const { initDb } = await import("../src/services/db.ts");
  const database = initDb(dbPath);

  const columns = execPragma(database, "table_info(events)");
  const colNames = columns.map((c) => c.name);

  assert.ok(colNames.includes("data"), "data column should have been auto-added");
  assert.ok(colNames.includes("verified"), "verified column should have been auto-added");
  assert.ok(colNames.includes("created_at"), "created_at column should have been auto-added");

  database.close();
});

test("migrated database still works for queries", async () => {
  const dbPath = makeTestDb("migrated_works.db");
  try {
    fs.unlinkSync(dbPath);
  } catch {}

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dao_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE daos (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      creator TEXT NOT NULL
    );
  `);

  db.prepare(
    "INSERT INTO events (dao_id, type, timestamp) VALUES (?, ?, ?)",
  ).run(1, "dao_create", "2024-01-01T00:00:00.000Z");
  db.close();

  const { initDb } = await import("../src/services/db.ts");
  const database = initDb(dbPath);

  const row = database
    .prepare("SELECT * FROM events WHERE dao_id = ?")
    .get(1);
  assert.ok(row);
  assert.equal(row.type, "dao_create");

  const countRow = database
    .prepare("SELECT COUNT(*) as total FROM events WHERE dao_id = ?")
    .get(1);
  assert.equal(countRow.total, 1);

  database.close();
});

test("column type change causes startup abort", async () => {
  const dbPath = makeTestDb("type_change.db");
  try {
    fs.unlinkSync(dbPath);
  } catch {}

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dao_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT,
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL,
      verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(dao_id, ledger, tx_hash, type)
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE daos (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      creator TEXT NOT NULL,
      membership_open INTEGER DEFAULT 1,
      members_can_propose INTEGER DEFAULT 0,
      metadata_cid TEXT,
      member_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.close();

  const { initDb } = await import("../src/services/db.ts");

  assert.throws(() => {
    initDb(dbPath);
  }, /type mismatch/);
});

test("missing indexes produce warnings (not errors)", async () => {
  const dbPath = makeTestDb("missing_index.db");
  try {
    fs.unlinkSync(dbPath);
  } catch {}

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dao_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT,
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL,
      verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(dao_id, ledger, tx_hash, type)
    );
    CREATE INDEX IF NOT EXISTS idx_events_dao_id ON events(dao_id);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE daos (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      creator TEXT NOT NULL,
      membership_open INTEGER DEFAULT 1,
      members_can_propose INTEGER DEFAULT 0,
      metadata_cid TEXT,
      member_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.close();

  const { initDb } = await import("../src/services/db.ts");

  const database = initDb(dbPath);
  assert.ok(database);
  database.close();
});

test("schema version is stored on init", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const dbPath = makeTestDb("version_stored.db");

  const database = initDb(dbPath);
  const row = database
    .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
    .get();
  assert.ok(row);
  assert.equal(JSON.parse(row.value), 2);
  database.close();
});

test("daos table missing columns are auto-added", async () => {
  const dbPath = makeTestDb("daos_missing_cols.db");
  try {
    fs.unlinkSync(dbPath);
  } catch {}

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dao_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT,
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL,
      verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(dao_id, ledger, tx_hash, type)
    );
    CREATE INDEX IF NOT EXISTS idx_events_dao_id ON events(dao_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_ledger ON events(ledger DESC);
    CREATE INDEX IF NOT EXISTS idx_events_dao_type ON events(dao_id, type);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE daos (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      creator TEXT NOT NULL
    );
  `);
  db.close();

  const { initDb } = await import("../src/services/db.ts");
  const database = initDb(dbPath);

  const columns = execPragma(database, "table_info(daos)");
  const names = columns.map((c) => c.name);

  assert.ok(names.includes("membership_open"), "membership_open should be added");
  assert.ok(names.includes("members_can_propose"), "members_can_propose should be added");
  assert.ok(names.includes("metadata_cid"), "metadata_cid should be added");
  assert.ok(names.includes("member_count"), "member_count should be added");
  assert.ok(names.includes("updated_at"), "updated_at should be added");

  database.close();
});

test("extra column produces warning (not error)", async () => {
  const dbPath = makeTestDb("extra_column.db");
  try {
    fs.unlinkSync(dbPath);
  } catch {}

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dao_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT,
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL,
      verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      extra_col TEXT,
      UNIQUE(dao_id, ledger, tx_hash, type)
    );
    CREATE INDEX IF NOT EXISTS idx_events_dao_id ON events(dao_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_ledger ON events(ledger DESC);
    CREATE INDEX IF NOT EXISTS idx_events_dao_type ON events(dao_id, type);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE daos (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      creator TEXT NOT NULL,
      membership_open INTEGER DEFAULT 1,
      members_can_propose INTEGER DEFAULT 0,
      metadata_cid TEXT,
      member_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.close();

  const { initDb } = await import("../src/services/db.ts");

  const database = initDb(dbPath);
  assert.ok(database);

  const columns = execPragma(database, "table_info(events)");
  const extraCol = columns.find((c) => c.name === "extra_col");
  assert.ok(extraCol, "extra column should still exist");

  database.close();
});

test("fresh database has all columns matching expected schema", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const dbPath = makeTestDb("full_schema.db");

  const database = initDb(dbPath);

  const expectedColumns = {
    events: ["id", "dao_id", "type", "data", "ledger", "tx_hash", "timestamp", "verified", "created_at"],
    metadata: ["key", "value"],
    daos: ["id", "name", "creator", "membership_open", "members_can_propose", "metadata_cid", "member_count", "updated_at"],
  };

  for (const [table, cols] of Object.entries(expectedColumns)) {
    const actualColumns = execPragma(database, `table_info(${table})`).map((c) => c.name);
    for (const col of cols) {
      assert.ok(actualColumns.includes(col), `Column ${table}.${col} should exist`);
    }
  }

  database.close();
});
