import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-backup-test-"));

test.after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

test("createBackup, verifyBackup, and restoreFromBackup flow", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const {
    createBackup,
    verifyBackup,
    restoreFromBackup,
    getBackupStatus,
    pruneOldBackups,
  } = await import("../src/services/backup.ts");

  const dbPath = path.join(TEST_DIR, "source.db");
  const backupDir = path.join(TEST_DIR, "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  // 1. Initialize source DB and write test data
  const db = initDb(dbPath);
  db.prepare("INSERT INTO daos (id, name, creator) VALUES (?, ?, ?)").run(1, "Test DAO Backup", "G12345");
  
  // 2. Perform backup
  const backupRes = await createBackup({
    destinationDir: backupDir,
    backupName: "test-backup-1.db",
  });

  assert.equal(backupRes.success, true);
  assert.ok(backupRes.filePath);
  assert.ok(fs.existsSync(backupRes.filePath));
  assert.ok((backupRes.sizeBytes || 0) > 0);

  // 3. Verify backup integrity
  const verifyRes = await verifyBackup(backupRes.filePath);
  assert.equal(verifyRes.valid, true);
  assert.equal(verifyRes.integrityResult, "ok");

  // 4. Test status
  const status = getBackupStatus();
  assert.equal(status.lastBackupStatus, "success");
  assert.ok(status.lastBackupAt);
  assert.ok(status.backupCount > 0);

  // 5. Test PITR restore to a new database path
  const restoredDbPath = path.join(TEST_DIR, "restored.db");
  const restoreRes = await restoreFromBackup(backupRes.filePath, restoredDbPath);

  assert.equal(restoreRes.success, true);
  assert.ok(fs.existsSync(restoredDbPath));

  // Verify restored DB content
  const { getDb } = await import("../src/services/db.ts");
  const activeDb = getDb();
  const daoRow = activeDb.prepare("SELECT * FROM daos WHERE id = 1").get();
  assert.ok(daoRow);
  assert.equal(daoRow.name, "Test DAO Backup");

  // Clean up DB
  activeDb.close();
});

test("pruneOldBackups removes old backups beyond retention count", async () => {
  const { pruneOldBackups } = await import("../src/services/backup.ts");
  const pruneDir = path.join(TEST_DIR, "prune_test");
  fs.mkdirSync(pruneDir, { recursive: true });

  // Create 5 dummy backup files
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(pruneDir, `zkvote-backup-file${i}.db`), `data ${i}`);
  }

  // Prune down to 2
  pruneOldBackups(pruneDir, 2);

  const remaining = fs.readdirSync(pruneDir).filter((f) => f.startsWith("zkvote-backup-"));
  assert.equal(remaining.length, 2);
});
