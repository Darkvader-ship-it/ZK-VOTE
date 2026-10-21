-- ============================================
-- Rollback Migration 001: Drop initial schema
-- Created: 2026-07-27
-- ============================================

-- Events table
DROP TABLE IF EXISTS events;

-- DAOs table
DROP TABLE IF EXISTS daos;

-- Metadata table
DROP TABLE IF EXISTS metadata;

-- Partition registry
DROP TABLE IF EXISTS partition_registry;

-- Migration tracking
DROP TABLE IF EXISTS _migrations;