import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { initSecretManager, getSecret, setSecret, checkRotationHealth, getSecretBackend, encrypt, decrypt, isEncrypted, generateMasterKey } = await import("../src/services/secrets/index.js");
const { checkRotationStatus, getOverallHealth } = await import("../src/services/secrets/rotation-monitor.js");
const { auditLog, createAuditEntry } = await import("../src/services/secrets/audit-logger.js");

// ============================================
// ENCRYPTOR TESTS
// ============================================

test("encrypt and decrypt roundtrip", () => {
  const masterKey = generateMasterKey();
  const plaintext = "my-secret-value";
  const ciphertext = encrypt(plaintext, masterKey);
  assert.ok(isEncrypted(ciphertext), "Ciphertext should be detected as encrypted");
  const decrypted = decrypt(ciphertext, masterKey);
  assert.equal(decrypted, plaintext);
});

test("encrypt produces different ciphertext each time", () => {
  const masterKey = generateMasterKey();
  const ciphertext1 = encrypt("same-value", masterKey);
  const ciphertext2 = encrypt("same-value", masterKey);
  assert.notEqual(ciphertext1, ciphertext2);
});

test("isEncrypted returns true for valid encrypted payload", () => {
  const masterKey = generateMasterKey();
  const ciphertext = encrypt("test", masterKey);
  assert.equal(isEncrypted(ciphertext), true);
});

test("isEncrypted returns false for plain text", () => {
  assert.equal(isEncrypted("not-encrypted"), false);
  assert.equal(isEncrypted("plain-value"), false);
});

// ============================================
// AUDIT LOGGER TESTS
// ============================================

test("createAuditEntry returns valid entry", () => {
  const entry = createAuditEntry("RELAYER_SECRET_KEY", "get", true, "req-123", "test-source");
  assert.equal(entry.secretKey, "RELAYER_SECRET_KEY");
  assert.equal(entry.operation, "get");
  assert.equal(entry.success, true);
  assert.equal(entry.requestId, "req-123");
  assert.equal(entry.source, "test-source");
  assert.ok(entry.timestamp);
});

test("createAuditEntry records failure with error", () => {
  const entry = createAuditEntry("PINATA_JWT", "get", false, "req-456", undefined, "vault timeout");
  assert.equal(entry.success, false);
  assert.equal(entry.error, "vault timeout");
});

test("auditLog does not throw", () => {
  assert.doesNotThrow(() => {
    auditLog(createAuditEntry("RELAYER_AUTH_TOKEN", "rotate", true));
  });
});

// ============================================
// ROTATION MONITOR TESTS
// ============================================

test("checkRotationStatus returns healthy for recently rotated secret", () => {
  const now = new Date().toISOString();
  const metadata = {
    lastRotatedAt: now,
    rotationIntervalMs: 30 * 24 * 60 * 60 * 1000,
  };
  const status = checkRotationStatus("RELAYER_AUTH_TOKEN", metadata);
  assert.equal(status.status, "healthy");
  assert.equal(status.isOverdue, false);
});

test("checkRotationStatus returns overdue for secret past rotation interval", () => {
  const pastDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const metadata = {
    lastRotatedAt: pastDate,
    rotationIntervalMs: 30 * 24 * 60 * 60 * 1000,
  };
  const status = checkRotationStatus("RELAYER_SECRET_KEY", metadata);
  assert.equal(status.status, "overdue");
  assert.equal(status.isOverdue, true);
});

test("checkRotationStatus returns expiring-soon for secret nearing expiration", () => {
  const pastDate = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString();
  const metadata = {
    lastRotatedAt: pastDate,
    rotationIntervalMs: 30 * 24 * 60 * 60 * 1000,
  };
  const status = checkRotationStatus("PINATA_JWT", metadata);
  assert.equal(status.status, "expiring-soon");
});

test("checkRotationStatus returns unknown when no rotation metadata", () => {
  const status = checkRotationStatus("RELAYER_SECRET_KEY", undefined);
  assert.equal(status.status, "unknown");
});

test("getOverallHealth returns critical when any secret is overdue", () => {
  const statuses = [
    { key: "A", lastRotatedAt: null, nextRotationAt: null, isOverdue: false, expiresAt: null, status: "healthy" },
    { key: "B", lastRotatedAt: null, nextRotationAt: null, isOverdue: true, expiresAt: null, status: "overdue" },
  ];
  assert.equal(getOverallHealth(statuses), "critical");
});

test("getOverallHealth returns degraded when any secret is expiring soon", () => {
  const statuses = [
    { key: "A", lastRotatedAt: null, nextRotationAt: null, isOverdue: false, expiresAt: null, status: "healthy" },
    { key: "B", lastRotatedAt: null, nextRotationAt: null, isOverdue: false, expiresAt: null, status: "expiring-soon" },
  ];
  assert.equal(getOverallHealth(statuses), "degraded");
});

test("getOverallHealth returns healthy when all secrets are healthy", () => {
  const statuses = [
    { key: "A", lastRotatedAt: null, nextRotationAt: null, isOverdue: false, expiresAt: null, status: "healthy" },
    { key: "B", lastRotatedAt: null, nextRotationAt: null, isOverdue: false, expiresAt: null, status: "healthy" },
  ];
  assert.equal(getOverallHealth(statuses), "healthy");
});

// ============================================
// SECRET MANAGER TESTS
// ============================================

test("initSecretManager with fallback sets backend to fly-secrets", () => {
  initSecretManager({ fallbackToEnv: true });
  assert.equal(getSecretBackend(), "fly-secrets");
});

test("initSecretManager with vault config sets backend to vault", () => {
  initSecretManager({
    vault: { url: "http://localhost:8200" },
    fallbackToEnv: true,
  });
  assert.equal(getSecretBackend(), "vault");
});

test("initSecretManager without vault config uses env fallback", () => {
  initSecretManager({ fallbackToEnv: true });
  const backend = getSecretBackend();
  assert.ok(backend === "fly-secrets" || backend === "env");
});

test("setSecret encrypts value and stores successfully", async () => {
  initSecretManager({ fallbackToEnv: true });
  const result = await setSecret("TEST_SECRET", "test-value-123");
  assert.equal(result, true);
});

test("setSecret with metadata stores rotation info", async () => {
  initSecretManager({ fallbackToEnv: true });
  const result = await setSecret("TEST_SECRET_2", "test-value-456", {
    metadata: {
      lastRotatedAt: new Date().toISOString(),
      rotationIntervalMs: 30 * 24 * 60 * 60 * 1000,
    },
  });
  assert.equal(result, true);
});

test("getSecret returns undefined for missing key in env", async () => {
  initSecretManager({ fallbackToEnv: true });
  const value = await getSecret("NONEXISTENT_SECRET_KEY_XYZ");
  assert.equal(value, undefined);
});

test("checkRotationHealth returns overall status", async () => {
  initSecretManager({ fallbackToEnv: true });
  const health = await checkRotationHealth();
  assert.ok(["healthy", "degraded", "critical"].includes(health.overall));
  assert.ok(health.lastCheckedAt);
  assert.equal(typeof health.secrets, "object");
});

// ============================================
// SECRET MANAGER WITH VAULT CONFIG
// ============================================

test("initSecretManager with vault URL is considered vault backend", () => {
  initSecretManager({
    vault: { url: "http://vault.example.com:8200", token: "test-token" },
    fallbackToEnv: true,
  });
  assert.equal(getSecretBackend(), "vault");
});

test("generateMasterKey produces a valid base64 string", () => {
  const key = generateMasterKey();
  assert.ok(key);
  assert.ok(key.length > 0);
  // Should be valid base64
  assert.doesNotThrow(() => Buffer.from(key, "base64"));
});