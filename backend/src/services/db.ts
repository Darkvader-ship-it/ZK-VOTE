/**
 * SQLite Database for ZKVote Event Storage
 *
 * Provides persistent storage for events with efficient querying.
 * Supports frontend notifications with on-chain verification.
 *
 * Partitioning Strategy (2026-07-27):
 * Events are stored in per-DAO tables (events_{daoId}) to avoid a single
 * monolithic events table becoming a bottleneck as the platform scales.
 * Cross-DAO queries use UNION ALL across all known partitions.
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  timeQuery,
  invalidateCachePrefix,
  getDbStats as getMonitorDbStats,
  profileEventQueries,
} from "./dbMonitor.js";
import { migrateUp } from "./migrate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_FILE = path.join(DATA_DIR, "zkvote.db");

// ============================================
// TYPES
// ============================================

export interface Event {
  id?: number;
  dao_id: number;
  type: string;
  data: Record<string, unknown> | null;
  ledger: number | null;
  tx_hash: string | null;
  timestamp: string;
  verified: boolean;
  created_at?: string;
}

export interface EventInput {
  daoId: number;
  type: string;
  data: Record<string, unknown> | null;
  ledger?: number | null;
  txHash?: string | null;
  timestamp?: string;
  verified?: boolean;
}

export interface EventQueryOptions {
  limit?: number;
  offset?: number;
  types?: string[] | null;
  verifiedOnly?: boolean;
}

export interface EventQueryResult {
  events: Event[];
  total: number;
  daoId: number;
}

export interface DaoCache {
  id: number;
  name: string;
  creator: string;
  membership_open: boolean;
  members_can_propose: boolean;
  metadata_cid: string | null;
  member_count: number;
  updated_at?: string;
}

export interface DaoInput {
  id: number;
  name: string;
  creator: string;
  membership_open: boolean;
  members_can_propose: boolean;
  metadata_cid?: string | null;
  member_count?: number;
}

export interface DbStatus {
  totalEvents: number;
  daoCount: number;
  lastLedger: number;
}

export interface IndexedDao {
  daoId: number;
  eventCount: number;
}

// ============================================
// SCHEMA VERSIONING
// ============================================

const CURRENT_SCHEMA_VERSION = 2;

interface ExpectedColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

interface ExpectedIndex {
  name: string;
  columns: string[];
}

interface ExpectedTable {
  columns: ExpectedColumn[];
  indexes: ExpectedIndex[];
}

const EXPECTED_SCHEMA: Record<string, ExpectedTable> = {
  events: {
    columns: [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true },
      { name: "dao_id", type: "INTEGER", notNull: true, primaryKey: false },
      { name: "type", type: "TEXT", notNull: true, primaryKey: false },
      { name: "data", type: "TEXT", notNull: false, primaryKey: false },
      { name: "ledger", type: "INTEGER", notNull: false, primaryKey: false },
      { name: "tx_hash", type: "TEXT", notNull: false, primaryKey: false },
      { name: "timestamp", type: "TEXT", notNull: true, primaryKey: false },
      { name: "verified", type: "INTEGER", notNull: false, primaryKey: false },
      { name: "created_at", type: "TEXT", notNull: false, primaryKey: false },
    ],
    indexes: [
      { name: "idx_events_dao_id", columns: ["dao_id"] },
      { name: "idx_events_type", columns: ["type"] },
      { name: "idx_events_timestamp", columns: ["timestamp"] },
      { name: "idx_events_ledger", columns: ["ledger"] },
      { name: "idx_events_dao_type", columns: ["dao_id", "type"] },
    ],
  },
  metadata: {
    columns: [
      { name: "key", type: "TEXT", notNull: true, primaryKey: true },
      { name: "value", type: "TEXT", notNull: false, primaryKey: false },
    ],
    indexes: [],
  },
  daos: {
    columns: [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true },
      { name: "name", type: "TEXT", notNull: true, primaryKey: false },
      { name: "creator", type: "TEXT", notNull: true, primaryKey: false },
      {
        name: "membership_open",
        type: "INTEGER",
        notNull: false,
        primaryKey: false,
      },
      {
        name: "members_can_propose",
        type: "INTEGER",
        notNull: false,
        primaryKey: false,
      },
      { name: "metadata_cid", type: "TEXT", notNull: false, primaryKey: false },
      {
        name: "member_count",
        type: "INTEGER",
        notNull: false,
        primaryKey: false,
      },
      { name: "updated_at", type: "TEXT", notNull: false, primaryKey: false },
    ],
    indexes: [],
  },
  comment_submissions: {
    columns: [
      { name: "commitment", type: "TEXT", notNull: true, primaryKey: true },
      { name: "dao_id", type: "INTEGER", notNull: true, primaryKey: true },
      { name: "proposal_id", type: "INTEGER", notNull: true, primaryKey: true },
      {
        name: "window_start",
        type: "INTEGER",
        notNull: true,
        primaryKey: true,
      },
      { name: "count", type: "INTEGER", notNull: false, primaryKey: false },
    ],
    indexes: [],
  },
  comment_flags: {
    columns: [
      { name: "id", type: "INTEGER", notNull: false, primaryKey: false },
      { name: "comment_id", type: "INTEGER", notNull: true, primaryKey: false },
      { name: "dao_id", type: "INTEGER", notNull: true, primaryKey: false },
      {
        name: "proposal_id",
        type: "INTEGER",
        notNull: true,
        primaryKey: false,
      },
      {
        name: "flagger_commitment",
        type: "TEXT",
        notNull: true,
        primaryKey: false,
      },
      {
        name: "flagger_nullifier",
        type: "TEXT",
        notNull: true,
        primaryKey: false,
      },
      { name: "created_at", type: "TEXT", notNull: false, primaryKey: false },
    ],
    indexes: [],
  },
  hidden_comments: {
    columns: [
      { name: "comment_id", type: "INTEGER", notNull: true, primaryKey: true },
      { name: "dao_id", type: "INTEGER", notNull: true, primaryKey: true },
      { name: "proposal_id", type: "INTEGER", notNull: true, primaryKey: true },
      {
        name: "flag_count",
        type: "INTEGER",
        notNull: false,
        primaryKey: false,
      },
      { name: "hidden_at", type: "TEXT", notNull: false, primaryKey: false },
    ],
    indexes: [],
  },
  ttl_tracking: {
    columns: [
      { name: "entry_id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "contract_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "dao_id", type: "INTEGER", notNull: false, primaryKey: false },
      { name: "method", type: "TEXT", notNull: false, primaryKey: false },
      {
        name: "last_renewed_at",
        type: "TEXT",
        notNull: false,
        primaryKey: false,
      },
      {
        name: "remaining_ledgers",
        type: "INTEGER",
        notNull: false,
        primaryKey: false,
      },
      { name: "urgency", type: "TEXT", notNull: false, primaryKey: false },
    ],
    indexes: [
      { name: "idx_ttl_tracking_urgency", columns: ["urgency"] },
      { name: "idx_ttl_tracking_contract", columns: ["contract_id"] },
    ],
  },
  ttl_cost_log: {
    columns: [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true },
      { name: "cycle_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "cycle_start", type: "TEXT", notNull: false, primaryKey: false },
      { name: "cycle_end", type: "TEXT", notNull: false, primaryKey: false },
      {
        name: "entries_renewed",
        type: "INTEGER",
        notNull: false,
        primaryKey: false,
      },
      {
        name: "entries_skipped",
        type: "INTEGER",
        notNull: false,
        primaryKey: false,
      },
      { name: "tx_count", type: "INTEGER", notNull: false, primaryKey: false },
      {
        name: "total_fee_xlm",
        type: "REAL",
        notNull: false,
        primaryKey: false,
      },
      { name: "status", type: "TEXT", notNull: false, primaryKey: false },
    ],
    indexes: [{ name: "idx_ttl_cost_cycle", columns: ["cycle_id"] }],
  },
};

function normalizeType(t: string): string {
  const u = t.toUpperCase().trim();
  if (["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT"].includes(u))
    return "INTEGER";
  if (["TEXT", "VARCHAR", "NVARCHAR", "CHAR", "CLOB"].includes(u))
    return "TEXT";
  if (["REAL", "FLOAT", "DOUBLE"].includes(u)) return "REAL";
  if (["NUMERIC", "DECIMAL"].includes(u)) return "NUMERIC";
  if (u === "BLOB") return "BLOB";
  return u;
}

// ============================================
// LOGGER
// ============================================

import { createLogger } from "./logger.js";

const dbLogger = createLogger("db");
const log = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  meta: Record<string, unknown> = {},
): void => {
  dbLogger[level](event, meta);
};

// ============================================
// DATABASE INSTANCE
// ============================================

let db: DatabaseType | null = null;

/** Cache of known partition tables (events_{daoId}) to avoid redundant DDL */
const knownPartitions: Set<number> = new Set();

/**
 * Return the partition table name for a given DAO ID.
 */
function partitionTableName(daoId: number): string {
  return `events_${daoId}`;
}

/**
 * Ensure a partition table exists for the given DAO ID.
 * Idempotent — safe to call on every write.
 */
function ensurePartitionTable(daoId: number): void {
  if (knownPartitions.has(daoId)) return;
  const database = db as DatabaseType;
  const tableName = partitionTableName(daoId);
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN (
        'dao_create','admin_transfer','member_added','member_revoked','member_left',
        'tree_init','voter_registered','voter_removed','voter_reinstated',
        'vk_updated','proposal_created','proposal_closed','proposal_archived','vote_cast'
      )),
      data TEXT, -- JSON
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0, 1)),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(ledger, tx_hash, type)
    );
    CREATE INDEX IF NOT EXISTS idx_${tableName}_type ON ${tableName}(type);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_timestamp ON ${tableName}(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_ledger ON ${tableName}(ledger DESC);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_verified ON ${tableName}(verified);
  `);
  knownPartitions.add(daoId);
  // Record this partition in metadata for cross-DAO queries
  recordPartitionDaoId(database, daoId);
}

/**
 * Record a DAO ID in the partition registry so cross-DAO queries
 * can discover all existing partitions.
 */
function recordPartitionDaoId(database: DatabaseType, daoId: number): void {
  database
    .prepare("INSERT OR IGNORE INTO partition_registry (dao_id) VALUES (?)")
    .run(daoId);
}

/**
 * Get all registered DAO IDs from the partition registry.
 */
function getAllPartitionDaoIds(database: DatabaseType): number[] {
  const rows = database
    .prepare("SELECT dao_id FROM partition_registry ORDER BY dao_id ASC")
    .all() as Array<{ dao_id: number }>;
  return rows.map((r) => r.dao_id);
}

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize the database and migrate from the monolithic schema.
 */
export function initDb(dbPath?: string): DatabaseType {
  if (db && !dbPath) return db;

  if (!dbPath) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } else {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const dbFile = dbPath ?? DB_FILE;
  const database = new Database(dbFile);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  // Create system tables (daos, metadata, partition_registry)
  database.exec(`
    -- Partition registry tracks which DAOs have their own event tables
    CREATE TABLE IF NOT EXISTS partition_registry (
      dao_id INTEGER PRIMARY KEY,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Metadata table for tracking state (feat: events partitioning, db monitoring, migration framework, and data integrity constraints)
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS daos (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      creator TEXT NOT NULL,
      membership_open INTEGER DEFAULT 1,
      members_can_propose INTEGER DEFAULT 0,
      metadata_cid TEXT,
      member_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS comment_submissions (
      commitment TEXT NOT NULL,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (commitment, dao_id, proposal_id, window_start)
    );

    CREATE TABLE IF NOT EXISTS comment_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      flagger_commitment TEXT NOT NULL,
      flagger_nullifier TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(comment_id, dao_id, proposal_id, flagger_nullifier)
    );

    CREATE TABLE IF NOT EXISTS hidden_comments (
      comment_id INTEGER NOT NULL,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      flag_count INTEGER DEFAULT 0,
      hidden_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, dao_id, proposal_id)
    );

    CREATE TABLE IF NOT EXISTS ttl_tracking (
      entry_id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      dao_id INTEGER,
      method TEXT,
      last_renewed_at TEXT,
      remaining_ledgers INTEGER,
      urgency TEXT DEFAULT 'unknown'
    );

    CREATE INDEX IF NOT EXISTS idx_ttl_tracking_urgency ON ttl_tracking(urgency);
    CREATE INDEX IF NOT EXISTS idx_ttl_tracking_contract ON ttl_tracking(contract_id);

    CREATE TABLE IF NOT EXISTS ttl_cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id TEXT NOT NULL,
      cycle_start TEXT,
      cycle_end TEXT,
      entries_renewed INTEGER DEFAULT 0,
      entries_skipped INTEGER DEFAULT 0,
      tx_count INTEGER DEFAULT 0,
      total_fee_xlm REAL DEFAULT 0.0,
      status TEXT DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_ttl_cost_cycle ON ttl_cost_log(cycle_id);

    CREATE TABLE IF NOT EXISTS transaction_log (
      nullifier_hash TEXT PRIMARY KEY,
      tx_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Keep the old events table temporarily during migration,
    -- then drop it once migration completes.
    CREATE TABLE IF NOT EXISTS events (
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
  `);

  const versionRow = database
    .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
    .get() as MetadataRow | undefined;
  const storedVersion = versionRow
    ? (JSON.parse(versionRow.value) as number)
    : null;

  if (!storedVersion) {
    database
      .prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)",
      )
      .run(JSON.stringify(CURRENT_SCHEMA_VERSION));
  }

  const { valid, errors, warnings, migrations } = validateSchema(database);

  if (migrations.length > 0) {
    applyMigrations(database, migrations);
    log("info", "schema_migrations_applied", { count: migrations.length });
  }

  for (const warning of warnings) {
    log("warn", "schema_mismatch", { message: warning });
  }

  if (!valid) {
    log("error", "schema_validation_failed", { errors });
    throw new Error(`Database schema validation failed: ${errors.join("; ")}`);
  }

  if (storedVersion && storedVersion < CURRENT_SCHEMA_VERSION) {
    database
      .prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)",
      )
      .run(JSON.stringify(CURRENT_SCHEMA_VERSION));
    log("info", "schema_version_upgraded", {
      from: storedVersion,
      to: CURRENT_SCHEMA_VERSION,
    });
  }

  // Populate knownPartitions from the registry
  const rows = database
    .prepare("SELECT dao_id FROM partition_registry")
    .all() as Array<{ dao_id: number }>;
  for (const row of rows) {
    knownPartitions.add(row.dao_id);
  }

  // Run pending migrations using the migration framework
  // Migrations are idempotent and tracked in the _migrations table
  try {
    const migrationResults = migrateUp(database);
    if (migrationResults.length > 0) {
      log("info", "migrations_applied", {
        count: migrationResults.length,
        results: migrationResults.map((r) => ({
          id: r.id,
          direction: r.direction,
          success: r.success,
          durationMs: Math.round(r.durationMs),
        })),
      });
    }
  } catch (err) {
    // Migration lock contention is not fatal — another process may have
    // already applied the migrations. Log and continue.
    const error = err as Error;
    if (error.message.includes("Migration lock")) {
      log("warn", "migration_skipped_locked", {
        error: error.message,
      });
    } else {
      log("error", "migration_failed", {
        error: error.message,
      });
      throw err;
    }
  }

  if (!dbPath) {
    db = database;
  }

  log("info", "db_initialized", {
    path: dbFile,
    partitions: knownPartitions.size,
  });
  // feat: events partitioning, db monitoring, migration framework, and data integrity constraints
  return database;
}

/**
 * Close the database
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    knownPartitions.clear();
    log("info", "db_closed");
  }
}

// ============================================
// SCHEMA VALIDATION & MIGRATION
// ============================================

interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  migrations: string[];
}

function validateSchema(database: DatabaseType): SchemaValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const migrations: string[] = [];

  for (const [tableName, expected] of Object.entries(EXPECTED_SCHEMA)) {
    const tableExists = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(tableName);

    if (!tableExists) {
      errors.push(`Missing required table: ${tableName}`);
      continue;
    }

    const actualColumns = database.pragma(`table_info(${tableName})`) as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    for (const expectedCol of expected.columns) {
      const actualCol = actualColumns.find((c) => c.name === expectedCol.name);

      if (!actualCol) {
        migrations.push(
          `Missing column ${tableName}.${expectedCol.name} (${expectedCol.type})`,
        );
        continue;
      }

      const actualType = normalizeType(actualCol.type);
      const expectedType = normalizeType(expectedCol.type);

      if (actualType !== expectedType) {
        errors.push(
          `Column ${tableName}.${expectedCol.name} type mismatch: expected ${expectedCol.type}, got ${actualCol.type}`,
        );
      }

      if (
        expectedCol.notNull &&
        !actualCol.notnull &&
        !expectedCol.primaryKey
      ) {
        warnings.push(
          `Column ${tableName}.${expectedCol.name} missing NOT NULL constraint`,
        );
      }

      if (expectedCol.primaryKey && !actualCol.pk) {
        errors.push(
          `Column ${tableName}.${expectedCol.name} missing PRIMARY KEY`,
        );
      }
    }

    for (const actualCol of actualColumns) {
      const match = expected.columns.find((c) => c.name === actualCol.name);
      if (!match) {
        warnings.push(`Extra column ${tableName}.${actualCol.name}`);
      }
    }

    const actualIndexes = database.pragma(`index_list(${tableName})`) as Array<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;

    for (const expectedIdx of expected.indexes) {
      const actualIdx = actualIndexes.find((i) => i.name === expectedIdx.name);

      if (!actualIdx) {
        warnings.push(`Missing index ${expectedIdx.name} on ${tableName}`);
        continue;
      }

      const indexCols = database.pragma(
        `index_info(${expectedIdx.name})`,
      ) as Array<{
        seqno: number;
        cid: number;
        name: string;
      }>;
      const actualColNames = indexCols.map((c) => c.name);
      if (actualColNames.join(",") !== expectedIdx.columns.join(",")) {
        warnings.push(
          `Index ${expectedIdx.name} columns mismatch: expected [${expectedIdx.columns}], got [${actualColNames}]`,
        );
      }
    }

    for (const actualIdx of actualIndexes) {
      if (actualIdx.origin === "pk" || actualIdx.origin === "u") continue;
      const match = expected.indexes.find((i) => i.name === actualIdx.name);
      if (!match) {
        warnings.push(`Extra index ${actualIdx.name} on ${tableName}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, migrations };
}

function applyMigrations(database: DatabaseType, migrations: string[]): void {
  for (const migration of migrations) {
    const match = migration.match(/Missing column (\w+)\.(\w+) \(([^)]+)\)/);
    if (!match) continue;

    const tableName = match[1];
    const columnName = match[2];

    const table = EXPECTED_SCHEMA[tableName];
    if (!table) continue;

    const colDef = table.columns.find((c) => c.name === columnName);
    if (!colDef) continue;

    let sql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${colDef.type}`;
    if (colDef.notNull) {
      const def = normalizeType(colDef.type) === "INTEGER" ? "0" : "";
      sql += ` DEFAULT ${def} NOT NULL`;
    }
    database.exec(sql);
    log("info", "schema_migration_applied", {
      table: tableName,
      column: columnName,
    });
  }
}

// ============================================
// METADATA FUNCTIONS
// ============================================

interface MetadataRow {
  value: string;
}

/**
 * Get metadata value by key
 */
export function getMetadata<T>(key: string): T | null {
  const database = initDb();
  const row = timeQuery(
    "getMetadata",
    () =>
      database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
        | MetadataRow
        | undefined,
    { key },
  );
  return row ? (JSON.parse(row.value) as T) : null;
}

/**
 * Set metadata value
 */
export function setMetadata<T>(key: string, value: T): void {
  const database = initDb();
  timeQuery(
    "setMetadata",
    () =>
      database
        .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
        .run(key, JSON.stringify(value)),
    { key },
  );
  // Invalidate any cached queries that depend on metadata
  invalidateCachePrefix("metadata");
}

// ============================================
// EVENT FUNCTIONS (Partition-aware)
// ============================================

interface EventRow {
  id: number;
  dao_id: number;
  type: string;
  data: string | null;
  ledger: number | null;
  tx_hash: string | null;
  timestamp: string;
  verified: number;
  created_at: string;
}

interface CountRow {
  total: number;
}

/**
 * Convert a raw EventRow (with numeric verified) to an Event object.
 */
function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    dao_id: row.dao_id,
    type: row.type,
    data: row.data ? (JSON.parse(row.data) as Record<string, unknown>) : null,
    ledger: row.ledger,
    tx_hash: row.tx_hash,
    timestamp: row.timestamp,
    verified: !!row.verified,
    created_at: row.created_at,
  };
}

/**
 * Add an event to the database.
 * Writes to the partition table for the DAO.
 * Returns true if added, false if duplicate.
 */
export function addEvent(event: EventInput): boolean {
  const database = initDb();
  const tableName = partitionTableName(event.daoId);
  ensurePartitionTable(event.daoId);

  const result = timeQuery(
    "addEvent",
    () => {
      try {
        database
          .prepare(
            `
        INSERT INTO ${tableName} (type, data, ledger, tx_hash, timestamp, verified)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
          )
          .run(
            event.type,
            JSON.stringify(event.data),
            event.ledger ?? null,
            event.txHash ?? null,
            event.timestamp ?? new Date().toISOString(),
            event.verified ? 1 : 0,
          );
        return true;
      } catch (err) {
        const error = err as { code?: string };
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
          return false; // Duplicate
        }
        throw err;
      }
    },
    { daoId: event.daoId, type: event.type },
  );

  // Invalidate cached DAO event counts
  if (result) {
    invalidateCachePrefix(`indexedDaos`);
    invalidateCachePrefix(`dbStatus`);
  }

  return result;
}

/**
 * Add a pending (unverified) event from frontend notification.
 */
export function addPendingEvent(
  daoId: number,
  type: string,
  data: Record<string, unknown> | null,
  txHash: string,
): boolean {
  return addEvent({
    daoId,
    type,
    data,
    ledger: null,
    txHash,
    timestamp: new Date().toISOString(),
    verified: false,
  });
}

/**
 * Mark an event as verified.
 * Searches across the DAO's partition table.
 */
export function verifyEvent(txHash: string, ledger: number): void {
  const database = initDb();
  // Search in all partitions for the matching tx_hash
  const daoIds = getAllPartitionDaoIds(database);
  for (const daoId of daoIds) {
    const tableName = partitionTableName(daoId);
    const result = database
      .prepare(
        `UPDATE ${tableName} SET verified = 1, ledger = ? WHERE tx_hash = ? AND verified = 0`,
      )
      .run(ledger, txHash);
    if (result.changes > 0) return; // Done
  }
}

/**
 * Get events for a DAO (from its partition).
 */
export function getEventsForDao(
  daoId: number,
  options: EventQueryOptions = {},
): EventQueryResult {
  const database = initDb();
  const tableName = partitionTableName(daoId);
  ensurePartitionTable(daoId);

  const {
    limit = 50,
    offset = 0,
    types = null,
    verifiedOnly = false,
  } = options;

  let query = `SELECT * FROM ${tableName} WHERE 1=1`;
  const params: (number | string)[] = [];

  if (types && types.length > 0) {
    query += ` AND type IN (${types.map(() => "?").join(",")})`;
    params.push(...types);
  }

  if (verifiedOnly) {
    query += " AND verified = 1";
  }

  query += " ORDER BY timestamp DESC, ledger DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const events = database.prepare(query).all(...params) as EventRow[];

  // Add dao_id to each row (partition tables don't store it)
  const enrichedEvents = events.map((e) => ({ ...e, dao_id: daoId }));

  let countQuery = `SELECT COUNT(*) as total FROM ${tableName} WHERE 1=1`;
  const countParams: (number | string)[] = [];
  if (types && types.length > 0) {
    countQuery += ` AND type IN (${types.map(() => "?").join(",")})`;
    countParams.push(...types);
  }
  if (verifiedOnly) {
    countQuery += " AND verified = 1";
  }

  const countResult = database
    .prepare(countQuery)
    .get(...countParams) as CountRow;

  return {
    events: enrichedEvents.map(rowToEvent),
    total: countResult.total,
    daoId,
  };
}

/**
 * Get all indexed DAOs (with event counts from partitions).
 */
export function getIndexedDaos(): IndexedDao[] {
  const database = initDb();
  const daoIds = getAllPartitionDaoIds(database);
  if (daoIds.length === 0) return [];

  // Build a UNION ALL query to get per-DAO counts
  const parts: string[] = [];
  for (const daoId of daoIds) {
    const tableName = partitionTableName(daoId);
    parts.push(
      `SELECT ${daoId} AS dao_id, COUNT(*) AS event_count FROM ${tableName}`,
    );
  }

  const rows = database
    .prepare(`${parts.join(" UNION ALL ")} ORDER BY dao_id`)
    .all() as Array<{ dao_id: number; event_count: number }>;

  return rows.map((r) => ({
    daoId: r.dao_id,
    eventCount: r.event_count,
  }));
}

/**
 * Get database status (cross-DAO aggregates).
 */
export function getDbStatus(): DbStatus {
  const database = initDb();
  const daoIds = getAllPartitionDaoIds(database);

  let totalEvents = 0;
  const daoCount = daoIds.length;

  if (daoIds.length > 0) {
    // Count across all partitions
    const countParts: string[] = [];
    for (const daoId of daoIds) {
      const tableName = partitionTableName(daoId);
      countParts.push(`SELECT COUNT(*) AS cnt FROM ${tableName}`);
    }
    const countRow = database
      .prepare(`${countParts.join(" UNION ALL ")}`)
      .all() as Array<{ cnt: number }>;
    totalEvents = countRow.reduce((sum, r) => sum + r.cnt, 0);
  }

  const lastLedger = getMetadata<number>("lastLedger") ?? 0;

  return {
    totalEvents,
    daoCount,
    lastLedger,
  };
}

/**
 * Get unverified events that need chain verification.
 * Searches across all partitions.
 */
export function getUnverifiedEvents(limit = 10): Event[] {
  const database = initDb();
  const daoIds = getAllPartitionDaoIds(database);
  if (daoIds.length === 0) return [];

  // Build a UNION ALL sub-query across partitions
  const parts: string[] = [];
  for (const daoId of daoIds) {
    const tableName = partitionTableName(daoId);
    parts.push(
      `SELECT id, ${daoId} AS dao_id, type, data, ledger, tx_hash, timestamp, verified, created_at FROM ${tableName} WHERE verified = 0 AND tx_hash IS NOT NULL`,
    );
  }

  const rows = database
    .prepare(`${parts.join(" UNION ALL ")} ORDER BY created_at ASC LIMIT ?`)
    .all(limit) as EventRow[];

  return rows.map(rowToEvent);
}

/**
 * Delete an unverified event (if verification fails).
 */
export function deleteUnverifiedEvent(txHash: string): void {
  const database = initDb();
  const daoIds = getAllPartitionDaoIds(database);
  for (const daoId of daoIds) {
    const tableName = partitionTableName(daoId);
    const result = database
      .prepare(`DELETE FROM ${tableName} WHERE tx_hash = ? AND verified = 0`)
      .run(txHash);
    if (result.changes > 0) return;
  }
}

// ============================================
// TRANSACTION LOG & REPLAY PROTECTION
// ============================================

export interface TransactionLogRow {
  nullifier_hash: string;
  tx_hash: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Get transaction log by nullifier hash.
 */
export function getTransactionLog(nullifierHash: string): TransactionLogRow | null {
  const database = initDb();
  const row = database
    .prepare("SELECT * FROM transaction_log WHERE nullifier_hash = ?")
    .get(nullifierHash) as TransactionLogRow | undefined;
  return row ?? null;
}

/**
 * Record new transaction submission in transaction log.
 */
export function recordTransactionLog(
  nullifierHash: string,
  txHash: string,
  status: string = "PENDING",
): void {
  const database = initDb();
  database
    .prepare(
      `INSERT INTO transaction_log (nullifier_hash, tx_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(nullifier_hash) DO UPDATE SET
         tx_hash = excluded.tx_hash,
         status = excluded.status,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(nullifierHash, txHash, status);
}

/**
 * Update transaction status in transaction log.
 */
export function updateTransactionLogStatus(
  nullifierHash: string,
  status: string,
  txHash?: string,
): void {
  const database = initDb();
  if (txHash) {
    database
      .prepare(
        `UPDATE transaction_log SET status = ?, tx_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE nullifier_hash = ?`,
      )
      .run(status, txHash, nullifierHash);
  } else {
    database
      .prepare(
        `UPDATE transaction_log SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE nullifier_hash = ?`,
      )
      .run(status, nullifierHash);
  }
}

/**
 * Cleanup old transaction log entries.
 */
export function cleanupTransactionLog(maxAgeMs = 86400000): number {
  const database = initDb();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = database
    .prepare("DELETE FROM transaction_log WHERE updated_at < ?")
    .run(cutoff);
  return result.changes;
}

/**
 * Count pending (unverified) events for a specific DAO.
 */
export function getPendingEventsCountForDao(daoId: number): number {
  const database = initDb();
  const tableName = partitionTableName(daoId);
  ensurePartitionTable(daoId);
  const row = database
    .prepare(`SELECT COUNT(*) as count FROM ${tableName} WHERE verified = 0`)
    .get() as { count: number };
  return row.count;
}

/**
 * Cleanup expired unverified pending events across partitions older than ttlMs.
 */
export function cleanupExpiredPendingEvents(ttlMs = 15 * 60 * 1000): number {
  const database = initDb();
  const daoIds = getAllPartitionDaoIds(database);
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  let deletedCount = 0;
  for (const daoId of daoIds) {
    const tableName = partitionTableName(daoId);
    const result = database
      .prepare(`DELETE FROM ${tableName} WHERE verified = 0 AND timestamp < ?`)
      .run(cutoff);
    deletedCount += result.changes;
  }
  return deletedCount;
}

// ============================================
// PARTITION MANAGEMENT
// ============================================

/**
 * Ensure a partition table exists for the given DAO ID.
 * Public version — call this when a new DAO is created.
 */
export function ensurePartition(daoId: number): void {
  initDb();
  ensurePartitionTable(daoId);
  log("info", "partition_created", { daoId });
}

/**
 * Drop a partition table (for DAO deletion/archival).
 * Removes the DAO from the registry as well.
 */
export function dropPartition(daoId: number): void {
  const database = initDb();
  const tableName = partitionTableName(daoId);

  database.exec(`DROP TABLE IF EXISTS ${tableName}`);
  database
    .prepare("DELETE FROM partition_registry WHERE dao_id = ?")
    .run(daoId);
  knownPartitions.delete(daoId);

  log("info", "partition_dropped", { daoId });
}

// ============================================
// MIGRATION: Monolithic -> Partitioned
// ============================================

/**
 * Migrate events from the old monolithic `events` table to per-DAO
 * partition tables.  This is idempotent — safe to re-run.
 *
 * Returns the number of events migrated.
 */
export function migrateToPartitions(): number {
  const database = initDb();

  // Check if there are any rows in the old events table
  const oldCount = database
    .prepare("SELECT COUNT(*) AS total FROM events")
    .get() as CountRow;

  if (oldCount.total === 0) {
    log("info", "partition_migration_skipped", { reason: "no_old_events" });
    return 0;
  }

  // Read all old events, grouped by dao_id
  const oldRows = database
    .prepare(
      "SELECT id, dao_id, type, data, ledger, tx_hash, timestamp, verified, created_at FROM events ORDER BY dao_id, id",
    )
    .all() as EventRow[];

  let migrated = 0;

  database.transaction(() => {
    for (const row of oldRows) {
      const tableName = partitionTableName(row.dao_id);
      // Ensure partition exists (creates the table + indexes)
      database.exec(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          data TEXT,
          ledger INTEGER,
          tx_hash TEXT,
          timestamp TEXT NOT NULL,
          verified INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(ledger, tx_hash, type)
        );
      `);
      knownPartitions.add(row.dao_id);
      recordPartitionDaoId(database, row.dao_id);

      // Insert into partition (ignore duplicates)
      const result = database
        .prepare(
          `
        INSERT OR IGNORE INTO ${tableName} (type, data, ledger, tx_hash, timestamp, verified, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          row.type,
          row.data,
          row.ledger,
          row.tx_hash,
          row.timestamp,
          row.verified,
          row.created_at,
        );
      if (result.changes > 0) migrated++;
    }

    // Drop the old monolithic events table
    database.exec("DROP TABLE IF EXISTS events");
  })();

  // Ensure indexes exist on new partitions
  database.transaction(() => {
    for (const daoId of knownPartitions) {
      const tableName = partitionTableName(daoId);
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_${tableName}_type ON ${tableName}(type);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_timestamp ON ${tableName}(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_ledger ON ${tableName}(ledger DESC);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_verified ON ${tableName}(verified);
      `);
    }
  })();

  log("info", "partition_migration_complete", {
    migrated,
    totalOld: oldCount.total,
  });
  return migrated;
}

/**
 * Migrate events from JSON file to SQLite (legacy migration).
 * Now routes into partition tables.
 */
export function migrateFromJson(jsonPath: string): number {
  const database = initDb();

  if (!fs.existsSync(jsonPath)) {
    log("info", "no_json_to_migrate");
    return 0;
  }

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as {
      events?: Record<
        string,
        Array<{
          type: string;
          data: Record<string, unknown> | null;
          ledger?: number | null;
          txHash?: string | null;
          timestamp?: string;
        }>
      >;
      lastLedger?: number;
    };
    const events = data.events ?? {};
    let migrated = 0;

    database.transaction(() => {
      for (const [daoIdStr, daoEvents] of Object.entries(events)) {
        const daoId = Number(daoIdStr);
        const tableName = partitionTableName(daoId);
        ensurePartitionTable(daoId);

        const insertStmt = database.prepare(`
          INSERT OR IGNORE INTO ${tableName} (type, data, ledger, tx_hash, timestamp, verified)
          VALUES (?, ?, ?, ?, ?, 1)
        `);

        for (const event of daoEvents) {
          try {
            insertStmt.run(
              event.type,
              JSON.stringify(event.data),
              event.ledger ?? null,
              event.txHash ?? null,
              event.timestamp ?? new Date().toISOString(),
            );
            migrated++;
          } catch {
            // Skip duplicates
          }
        }
      }

      // Save last ledger
      if (data.lastLedger) {
        setMetadata("lastLedger", data.lastLedger);
      }
    })();

    log("info", "json_migration_complete", { migrated });

    // Rename old file
    fs.renameSync(jsonPath, jsonPath + ".migrated");

    return migrated;
  } catch (err) {
    const error = err as Error;
    log("error", "json_migration_failed", { error: error.message });
    return 0;
  }
}

// ============================================
// DIAGNOSTICS & PERFORMANCE
// ============================================

/**
 * Get comprehensive database diagnostics for the /db/stats endpoint.
 * Includes query metrics, table statistics, cache stats, and index analysis.
 */
export function getDbDiagnostics(): Record<string, unknown> {
  const database = initDb();
  const stats = getMonitorDbStats(database);

  // Profile event queries for large DAOs (10K+ events)
  const largeDaos = stats.tables
    .filter((t) => t.name.startsWith("events_") && t.rowCount >= 10_000)
    .map((t) => Number(t.name.replace("events_", "")));

  for (const daoId of largeDaos) {
    profileEventQueries(database, daoId);
  }

  return {
    queries: stats.queries,
    tables: stats.tables,
    cache: stats.cache,
    config: stats.config,
    partitions: knownPartitions.size,
    largeDaos: largeDaos.length,
  };
}

/**
 * Profile queries for a specific DAO partition (for diagnostics).
 */
export function profileDaoQueries(daoId: number): void {
  const database = initDb();
  const tableName = partitionTableName(daoId);
  const tableExists = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  if (tableExists) {
    profileEventQueries(database, daoId);
  }
}

// ============================================
// DAO CACHE FUNCTIONS
// ============================================

interface DaoRow {
  id: number;
  name: string;
  creator: string;
  membership_open: number;
  members_can_propose: number;
  metadata_cid: string | null;
  member_count: number;
  updated_at: string;
}

/**
 * Upsert a DAO into the cache
 */
export function upsertDao(dao: DaoInput): void {
  const database = initDb();
  database
    .prepare(
      `
    INSERT INTO daos (id, name, creator, membership_open, members_can_propose, metadata_cid, member_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      creator = excluded.creator,
      membership_open = excluded.membership_open,
      members_can_propose = excluded.members_can_propose,
      metadata_cid = excluded.metadata_cid,
      member_count = excluded.member_count,
      updated_at = CURRENT_TIMESTAMP
  `,
    )
    .run(
      dao.id,
      dao.name,
      dao.creator,
      dao.membership_open ? 1 : 0,
      dao.members_can_propose ? 1 : 0,
      dao.metadata_cid ?? null,
      dao.member_count ?? 0,
    );
}

/**
 * Upsert multiple DAOs in a transaction
 */
export function upsertDaos(daos: DaoInput[]): void {
  const database = initDb();
  const stmt = database.prepare(`
    INSERT INTO daos (id, name, creator, membership_open, members_can_propose, metadata_cid, member_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      creator = excluded.creator,
      membership_open = excluded.membership_open,
      members_can_propose = excluded.members_can_propose,
      metadata_cid = excluded.metadata_cid,
      member_count = excluded.member_count,
      updated_at = CURRENT_TIMESTAMP
  `);

  database.transaction(() => {
    for (const dao of daos) {
      stmt.run(
        dao.id,
        dao.name,
        dao.creator,
        dao.membership_open ? 1 : 0,
        dao.members_can_propose ? 1 : 0,
        dao.metadata_cid ?? null,
        dao.member_count ?? 0,
      );
    }
  })();

  log("info", "daos_upserted", { count: daos.length });
}

/**
 * Get all cached DAOs
 */
export function getAllCachedDaos(): DaoCache[] {
  const database = initDb();
  const rows = database
    .prepare("SELECT * FROM daos ORDER BY id ASC")
    .all() as DaoRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    creator: row.creator,
    membership_open: !!row.membership_open,
    members_can_propose: !!row.members_can_propose,
    metadata_cid: row.metadata_cid,
    member_count: row.member_count,
    updated_at: row.updated_at,
  }));
}

/**
 * Get a specific cached DAO by ID
 */
export function getCachedDao(daoId: number): DaoCache | null {
  const database = initDb();
  const row = database.prepare("SELECT * FROM daos WHERE id = ?").get(daoId) as
    | DaoRow
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    creator: row.creator,
    membership_open: !!row.membership_open,
    members_can_propose: !!row.members_can_propose,
    metadata_cid: row.metadata_cid,
    member_count: row.member_count,
    updated_at: row.updated_at,
  };
}

/**
 * Get DAOs for a specific user (by membership)
 * This requires the daos table to be populated with user membership data
 * For now, returns all DAOs - user filtering will be done by the frontend
 */
export function getDaosForUser(_userAddress: string): DaoCache[] {
  return getAllCachedDaos();
}

/**
 * Get the last sync timestamp for DAOs
 */
export function getDaosSyncTime(): string | null {
  return getMetadata<string>("daosSyncTime");
}

/**
 * Set the last sync timestamp for DAOs
 */
export function setDaosSyncTime(timestamp: string): void {
  setMetadata("daosSyncTime", timestamp);
}

/**
 * Get cached DAO count
 */
export function getCachedDaoCount(): number {
  const database = initDb();
  const result = database
    .prepare("SELECT COUNT(*) as count FROM daos")
    .get() as { count: number };
  return result.count;
}

// ============================================
// TTL TRACKING FUNCTIONS
// ============================================

export interface TTLTrackingEntry {
  entryId: string;
  contractId: string;
  daoId: number | null;
  method: string | null;
  lastRenewedAt: string | null;
  remainingLedgers: number | null;
  urgency: string;
}

export interface TTLCostLogEntry {
  id: number;
  cycleId: string;
  cycleStart: string | null;
  cycleEnd: string | null;
  entriesRenewed: number;
  entriesSkipped: number;
  txCount: number;
  totalFeeXlm: number;
  status: string;
}

export function upsertTTLTracking(entry: TTLTrackingEntry): void {
  const database = initDb();
  database
    .prepare(
      `
    INSERT INTO ttl_tracking (entry_id, contract_id, dao_id, method, last_renewed_at, remaining_ledgers, urgency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      contract_id = excluded.contract_id,
      dao_id = excluded.dao_id,
      method = excluded.method,
      last_renewed_at = excluded.last_renewed_at,
      remaining_ledgers = excluded.remaining_ledgers,
      urgency = excluded.urgency
  `,
    )
    .run(
      entry.entryId,
      entry.contractId,
      entry.daoId ?? null,
      entry.method ?? null,
      entry.lastRenewedAt ?? null,
      entry.remainingLedgers ?? null,
      entry.urgency,
    );
}

export function getTTLTracking(entryId: string): TTLTrackingEntry | null {
  const database = initDb();
  const row = database
    .prepare("SELECT * FROM ttl_tracking WHERE entry_id = ?")
    .get(entryId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    entryId: row.entry_id as string,
    contractId: row.contract_id as string,
    daoId: row.dao_id as number | null,
    method: row.method as string | null,
    lastRenewedAt: row.last_renewed_at as string | null,
    remainingLedgers: row.remaining_ledgers as number | null,
    urgency: row.urgency as string,
  };
}

export function getAllTTLTracking(): TTLTrackingEntry[] {
  const database = initDb();
  const rows = database
    .prepare("SELECT * FROM ttl_tracking ORDER BY remaining_ledgers ASC")
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    entryId: row.entry_id as string,
    contractId: row.contract_id as string,
    daoId: row.dao_id as number | null,
    method: row.method as string | null,
    lastRenewedAt: row.last_renewed_at as string | null,
    remainingLedgers: row.remaining_ledgers as number | null,
    urgency: row.urgency as string,
  }));
}

export function getGracePeriodEntries(): TTLTrackingEntry[] {
  const database = initDb();
  const rows = database
    .prepare(
      "SELECT * FROM ttl_tracking WHERE urgency = 'grace' ORDER BY remaining_ledgers ASC",
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    entryId: row.entry_id as string,
    contractId: row.contract_id as string,
    daoId: row.dao_id as number | null,
    method: row.method as string | null,
    lastRenewedAt: row.last_renewed_at as string | null,
    remainingLedgers: row.remaining_ledgers as number | null,
    urgency: row.urgency as string,
  }));
}

export function createTTLCostLog(cycleId: string, cycleStart: string): number {
  const database = initDb();
  const result = database
    .prepare(
      `
    INSERT INTO ttl_cost_log (cycle_id, cycle_start, status)
    VALUES (?, ?, 'in_progress')
  `,
    )
    .run(cycleId, cycleStart);
  return result.lastInsertRowid as number;
}

export function updateTTLCostLog(
  id: number,
  fields: Partial<{
    cycleEnd: string;
    entriesRenewed: number;
    entriesSkipped: number;
    txCount: number;
    totalFeeXlm: number;
    status: string;
  }>,
): void {
  const database = initDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (fields.cycleEnd !== undefined) {
    sets.push("cycle_end = ?");
    values.push(fields.cycleEnd);
  }
  if (fields.entriesRenewed !== undefined) {
    sets.push("entries_renewed = ?");
    values.push(fields.entriesRenewed);
  }
  if (fields.entriesSkipped !== undefined) {
    sets.push("entries_skipped = ?");
    values.push(fields.entriesSkipped);
  }
  if (fields.txCount !== undefined) {
    sets.push("tx_count = ?");
    values.push(fields.txCount);
  }
  if (fields.totalFeeXlm !== undefined) {
    sets.push("total_fee_xlm = ?");
    values.push(fields.totalFeeXlm);
  }
  if (fields.status !== undefined) {
    sets.push("status = ?");
    values.push(fields.status);
  }

  if (sets.length === 0) return;
  values.push(id);
  database
    .prepare(`UPDATE ttl_cost_log SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
}

export function getTTLCostLogs(limit = 10): TTLCostLogEntry[] {
  const database = initDb();
  const rows = database
    .prepare("SELECT * FROM ttl_cost_log ORDER BY id DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as number,
    cycleId: row.cycle_id as string,
    cycleStart: row.cycle_start as string | null,
    cycleEnd: row.cycle_end as string | null,
    entriesRenewed: row.entries_renewed as number,
    entriesSkipped: row.entries_skipped as number,
    txCount: row.tx_count as number,
    totalFeeXlm: row.total_fee_xlm as number,
    status: row.status as string,
  }));
}

export function getTotalTTLCostXLM(): number {
  const database = initDb();
  const row = database
    .prepare(
      "SELECT COALESCE(SUM(total_fee_xlm), 0) as total FROM ttl_cost_log WHERE status = 'completed'",
    )
    .get() as { total: number };
  return row.total;
}
