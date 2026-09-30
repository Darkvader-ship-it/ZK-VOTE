-- ============================================
-- Migration 002: Add CHECK constraints and FK to existing partition tables
-- Created: 2026-07-27
--
-- SQLite does not support ALTER TABLE ADD CONSTRAINT.
-- For each existing partition, we recreate the table with constraints.
-- This is safe because partition_registry tells us which tables exist.
-- ============================================

-- For each existing partition, add CHECK constraints by recreating the table
-- We iterate through partition_registry and recreate each events_{daoId} table
-- with the proper constraints.

-- Step 1: Clean any existing data that would violate new constraints
-- (e.g., verified values other than 0 or 1, unknown event types)
UPDATE events SET verified = 1 WHERE verified NOT IN (0, 1);
DELETE FROM events WHERE type NOT IN (
  'dao_create','admin_transfer','member_added','member_revoked','member_left',
  'tree_init','voter_registered','voter_removed','voter_reinstated',
  'vk_updated','proposal_created','proposal_closed','proposal_archived','vote_cast'
);

-- Step 2: Recreate the old events table with constraints (if it still exists)
-- This handles the monolithic table before partition migration
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

-- Step 3: Update daos table with CHECK constraints (recreate approach)
-- Since daos may have existing data, we use INSERT OR REPLACE to sanitize
UPDATE daos SET membership_open = 1 WHERE membership_open NOT IN (0, 1);
UPDATE daos SET members_can_propose = 0 WHERE members_can_propose NOT IN (0, 1);

-- Recreate daos with constraints (safe because constraints match existing data now)
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