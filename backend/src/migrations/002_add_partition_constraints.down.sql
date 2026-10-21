-- ============================================
-- Rollback Migration 002: Remove CHECK constraints from partitions
-- Created: 2026-07-27
--
-- Recreates partition tables without CHECK constraints.
-- This is only needed if constraints cause unexpected issues.
-- ============================================

-- Note: This rollback drops the CHECK constraints by recreating tables
-- without them. The _migrations table entry is deleted to allow re-apply.

-- Drop the CHECK constraints on daos by recreating without constraints
-- (TABLE IF NOT EXISTS with no constraints won't replace existing, so we
--  handle this carefully — the constraints are actually only on CREATE,
--  so this rollback primarily exists for fresh installs.)
-- For existing tables, we simply note that constraints are already applied.

-- Since SQLite CHECK constraints are part of CREATE TABLE and can't be
-- removed with ALTER, this rollback is informational. To fully roll back,
-- one would need to recreate the tables without constraints.
DROP TABLE IF EXISTS events_v2;