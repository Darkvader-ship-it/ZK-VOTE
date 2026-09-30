-- ============================================
-- Migration 001: Initial schema with constraints
-- Created: 2026-07-27
-- ============================================

-- Track migration state internally
CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  checksum TEXT,
  duration_ms INTEGER
);

-- Partition registry tracks which DAOs have their own event tables
CREATE TABLE IF NOT EXISTS partition_registry (
  dao_id INTEGER PRIMARY KEY,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Metadata table for tracking state
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- DAOs table for cached DAO data with CHECK constraints
CREATE TABLE IF NOT EXISTS daos (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  creator TEXT NOT NULL,
  membership_open INTEGER NOT NULL DEFAULT 1 CHECK(membership_open IN (0, 1)),
  members_can_propose INTEGER NOT NULL DEFAULT 0 CHECK(members_can_propose IN (0, 1)),
  metadata_cid TEXT,
  member_count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Monolithic events table (legacy — will be migrated to partitions)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dao_id INTEGER NOT NULL REFERENCES daos(id),
  type TEXT NOT NULL CHECK(type IN (
    'dao_create','admin_transfer','member_added','member_revoked','member_left',
    'tree_init','voter_registered','voter_removed','voter_reinstated',
    'vk_updated','proposal_created','proposal_closed','proposal_archived','vote_cast'
  )),
  data TEXT,
  ledger INTEGER,
  tx_hash TEXT,
  timestamp TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0, 1)),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(dao_id, ledger, tx_hash, type)
);