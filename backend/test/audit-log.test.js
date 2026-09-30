import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const dataDir = path.resolve("data");
const DEFAULT_DB = path.join(dataDir, "zkvote.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

async function resetDb() {
  try {
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
  } catch {}
  try {
    fs.unlinkSync(DEFAULT_DB);
  } catch {}
}

await resetDb();

test("audit log: hash chain links entries and redacts sensitive params", async () => {
  const { recordAuditLog, getAuditLogs, verifyAuditChain } = await import(
    "../src/services/audit.ts"
  );

  const row1 = recordAuditLog({
    action: "test_action_a",
    endpoint: "POST /x",
    authTokenId: "tok1",
    ipHash: "ip1",
    requestId: "req1",
    params: { proof: "should-be-redacted", daoId: 1 },
    statusCode: 200,
  });
  const row2 = recordAuditLog({
    action: "test_action_b",
    endpoint: "POST /y",
    authTokenId: "tok1",
    ipHash: "ip1",
    requestId: "req2",
    statusCode: 201,
  });

  assert.equal(row2.prev_hash, row1.hash);
  assert.notEqual(row1.hash, row2.hash);

  const { logs, total } = getAuditLogs({ limit: 10 });
  assert.ok(total >= 2);
  const stored = logs.find((l) => l.id === row1.id);
  assert.equal(JSON.parse(stored.params).proof, "[REDACTED]");
  assert.equal(JSON.parse(stored.params).daoId, 1);

  const verification = verifyAuditChain();
  assert.equal(verification.valid, true);
});

test("audit log: append-only triggers reject UPDATE/DELETE of core fields, but archived rows can be deleted", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const { recordAuditLog } = await import("../src/services/audit.ts");
  const { markAuditLogsArchived } = await import("../src/services/db.ts");

  const database = initDb();
  const row = recordAuditLog({
    action: "test_append_only",
    endpoint: "POST /z",
    authTokenId: null,
    ipHash: null,
    requestId: null,
    statusCode: 200,
  });

  assert.throws(() =>
    database
      .prepare("UPDATE audit_log SET action = ? WHERE id = ?")
      .run("tampered", row.id),
  );
  assert.throws(() =>
    database.prepare("DELETE FROM audit_log WHERE id = ?").run(row.id),
  );

  markAuditLogsArchived([row.id], new Date().toISOString());
  assert.doesNotThrow(() =>
    database.prepare("DELETE FROM audit_log WHERE id = ?").run(row.id),
  );
});

test("audit log: verifyAuditChain flags a forged entry", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const { recordAuditLog, verifyAuditChain } = await import(
    "../src/services/audit.ts"
  );

  const database = initDb();
  const last = recordAuditLog({
    action: "test_before_forgery",
    endpoint: "POST /w",
    authTokenId: null,
    ipHash: null,
    requestId: null,
    statusCode: 200,
  });

  // Simulate a forged entry: a raw INSERT with a hash that doesn't match its
  // own fields. The append-only triggers only guard UPDATE/DELETE, so this is
  // the one way "tampering" could slip in — and it's exactly what
  // verifyAuditChain() exists to catch.
  database
    .prepare(
      `INSERT INTO audit_log
        (timestamp, action, endpoint, auth_token_id, ip_hash, request_id, params, status_code, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      "forged",
      "POST /forged",
      null,
      null,
      null,
      null,
      200,
      last.hash,
      "not-a-real-hash",
    );

  const verification = verifyAuditChain();
  assert.equal(verification.valid, false);
  assert.ok(verification.brokenAtId);
});

test("audit log: archiveOldAuditLogs exports and removes rows past the retention window", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const { archiveOldAuditLogs } = await import("../src/services/audit.ts");

  const database = initDb();
  const oldTimestamp = new Date(
    Date.now() - 200 * 24 * 60 * 60 * 1000,
  ).toISOString();

  database
    .prepare(
      `INSERT INTO audit_log
        (timestamp, action, endpoint, auth_token_id, ip_hash, request_id, params, status_code, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(oldTimestamp, "old_action", "POST /old", null, null, null, null, 200, "genesis", "irrelevant-for-this-test");

  const archiveDir = fs.mkdtempSync(
    path.join(tmpdir(), "zkvote-audit-archive-"),
  );

  const result = archiveOldAuditLogs(90, archiveDir);
  assert.ok(result.archivedCount >= 1);
  assert.ok(result.filePath && fs.existsSync(result.filePath));

  const remaining = database
    .prepare("SELECT COUNT(*) as c FROM audit_log WHERE timestamp = ?")
    .get(oldTimestamp);
  assert.equal(remaining.c, 0);

  fs.rmSync(archiveDir, { recursive: true, force: true });
});
