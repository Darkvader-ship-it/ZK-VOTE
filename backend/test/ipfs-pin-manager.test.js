/**
 * IPFS Pin Manager Tests
 *
 * Validates the pin-manager and pin-monitor modules:
 *   - Local backup (JSON and file)
 *   - Pin registration and registry rehydration
 *   - CID verification logic
 *   - Stats aggregation and cost tracking
 *   - Monitor lifecycle (start / stop)
 *
 * These are unit tests that run without external services.
 * Run with: npm test -- test/ipfs-pin-manager.test.js
 */

import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  initPinManager,
  backupJSON,
  backupFile,
  registerPin,
  getPinRecord,
  getAllPinRecords,
  getStats,
  verifyCid,
} from '../src/services/ipfs-pin-manager.ts';

import {
  startMonitor,
  stopMonitor,
  getMonitorStatus,
} from '../src/services/ipfs-monitor.ts';

// Use a temp directory for each test run
const TEST_BACKUP_DIR = path.join(os.tmpdir(), `zkvote-pin-test-${Date.now()}`);

// ============================================
// SETUP
// ============================================

test('initPinManager creates backup directories', () => {
  initPinManager(TEST_BACKUP_DIR);

  assert.ok(fs.existsSync(TEST_BACKUP_DIR), 'Backup dir should exist');
  assert.ok(fs.existsSync(path.join(TEST_BACKUP_DIR, 'json')), 'json subdir should exist');
  assert.ok(fs.existsSync(path.join(TEST_BACKUP_DIR, 'files')), 'files subdir should exist');
  assert.ok(fs.existsSync(path.join(TEST_BACKUP_DIR, 'meta')), 'meta subdir should exist');
});

// ============================================
// LOCAL BACKUP
// ============================================

test('backupJSON writes JSON to disk and returns path', () => {
  initPinManager(TEST_BACKUP_DIR);

  const testData = { version: 1, body: 'Test proposal', foo: 'bar' };
  const filePath = backupJSON(testData, 'test-proposal');

  assert.ok(fs.existsSync(filePath), 'Backup file should exist');
  assert.ok(filePath.includes('test-proposal'), 'Path should include label');

  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.equal(content.version, 1);
  assert.equal(content.body, 'Test proposal');
});

test('backupFile writes binary buffer to disk and returns path', () => {
  initPinManager(TEST_BACKUP_DIR);

  const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG header
  const filePath = backupFile(buffer, 'test-image.png');

  assert.ok(fs.existsSync(filePath), 'Backup file should exist');

  const readBack = fs.readFileSync(filePath);
  assert.deepEqual(readBack, buffer);
});

test('backupFile sanitizes dangerous filenames', () => {
  initPinManager(TEST_BACKUP_DIR);

  const buffer = Buffer.from('hello');
  const filePath = backupFile(buffer, '../../../etc/passwd');

  // Should not escape the files/ directory
  assert.ok(filePath.startsWith(path.join(TEST_BACKUP_DIR, 'files')));
  assert.ok(!filePath.includes('../'));
});

// ============================================
// PIN REGISTRATION
// ============================================

test('registerPin creates a pin record', () => {
  initPinManager(TEST_BACKUP_DIR);

  const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  registerPin(cid, 'json', 'test-meta', 1024, 'application/json');

  const record = getPinRecord(cid);
  assert.ok(record, 'Record should exist');
  assert.equal(record.cid, cid);
  assert.equal(record.contentType, 'json');
  assert.equal(record.name, 'test-meta');
  assert.equal(record.sizeBytes, 1024);
  assert.ok(record.pinnedOn.includes('pinata'));
  assert.ok(record.pinnedOn.includes('local'));
});

test('registerPin persists metadata to disk', () => {
  initPinManager(TEST_BACKUP_DIR);

  const cid = 'bafkreigys4ks7ro3etlgwwyub7bdh72o5ag7rag66lazjoemayhq7gesvu';
  registerPin(cid, 'file', 'test-image.png', 2048, 'image/png');

  const metaPath = path.join(TEST_BACKUP_DIR, 'meta', `${cid}.json`);
  assert.ok(fs.existsSync(metaPath), 'Meta file should exist');

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  assert.equal(meta.cid, cid);
  assert.equal(meta.name, 'test-image.png');
});

test('getAllPinRecords returns all registered pins', () => {
  initPinManager(TEST_BACKUP_DIR);

  registerPin('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', 'json', 'a', 100);
  registerPin('bafkreigys4ks7ro3etlgwwyub7bdh72o5ag7rag66lazjoemayhq7gesvu', 'file', 'b', 200);

  const all = getAllPinRecords();
  assert.ok(all.length >= 2, 'Should have at least 2 records');
});

// ============================================
// REGISTRY REHYDRATION
// ============================================

test('initPinManager rehydrates registry from disk', () => {
  // First init — register a pin
  const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55aaaaaa';
  const freshDir = path.join(os.tmpdir(), `zkvote-rehydrate-${Date.now()}`);
  initPinManager(freshDir);
  registerPin(cid, 'json', 'rehydrate-test', 512, 'application/json');

  // Re-init (simulates server restart)
  initPinManager(freshDir);

  const record = getPinRecord(cid);
  assert.ok(record, 'Record should be rehydrated from disk');
  assert.equal(record.name, 'rehydrate-test');

  // Cleanup
  fs.rmSync(freshDir, { recursive: true, force: true });
});

// ============================================
// STATS & COST TRACKING
// ============================================

test('getStats returns correct aggregates', () => {
  const freshDir = path.join(os.tmpdir(), `zkvote-stats-${Date.now()}`);
  initPinManager(freshDir);

  // Register two pins with unique CIDs for this test
  const cidA = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55stats1';
  const cidB = 'bafkreigys4ks7ro3etlgwwyub7bdh72o5ag7rag66lazjoemayhq7stats2';
  registerPin(cidA, 'json', 'a', 1000);
  registerPin(cidB, 'file', 'b', 2000);

  const stats = getStats();
  // Registry is shared across tests, so use >= instead of exact equality
  assert.ok(stats.totalPins >= 2, `Expected >= 2 pins, got ${stats.totalPins}`);
  assert.ok(stats.totalSizeBytes >= 3000, `Expected >= 3000 bytes, got ${stats.totalSizeBytes}`);
  assert.ok(stats.healthyPins >= 2, `Expected >= 2 healthy, got ${stats.healthyPins}`);
  assert.equal(stats.degradedPins, 0);
  assert.equal(stats.failedPins, 0);
  assert.ok(stats.estimatedMonthlyCostUsd >= 0, 'Cost should be non-negative');

  // Cleanup
  fs.rmSync(freshDir, { recursive: true, force: true });
});

// ============================================
// CID VERIFICATION
// ============================================

test('verifyCid returns unreachable for fake CID', async () => {
  const result = await verifyCid('bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(result.reachable, false);
  assert.equal(result.gateway, 'none');
});

// ============================================
// MONITOR LIFECYCLE
// ============================================

test('startMonitor / stopMonitor lifecycle', () => {
  const freshDir = path.join(os.tmpdir(), `zkvote-monitor-${Date.now()}`);
  initPinManager(freshDir);

  // Stop any previously running monitor (from prior tests)
  stopMonitor();

  startMonitor({
    scanIntervalMs: 60_000, // 1 minute (won't actually fire in test)
    alertThreshold: 3,
    autoRepin: false,
  });

  const status = getMonitorStatus();
  assert.equal(status.running, true);
  assert.equal(status.scanIntervalMs, 60_000);

  stopMonitor();

  const statusAfter = getMonitorStatus();
  assert.equal(statusAfter.running, false);

  // Cleanup
  fs.rmSync(freshDir, { recursive: true, force: true });
});

// ============================================
// CLEANUP
// ============================================

test('cleanup test directories', () => {
  if (fs.existsSync(TEST_BACKUP_DIR)) {
    fs.rmSync(TEST_BACKUP_DIR, { recursive: true, force: true });
  }
});
