/**
 * Health Check Routes
 *
 * Provides health, readiness, and configuration endpoints.
 */

import { Router, Request, Response } from "express";
import type * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { extractAuthToken } from "../middleware/auth.js";
import { getRateLimitMetrics } from "../middleware/rateLimit.js";
import { getMembershipVerificationMetrics } from "../services/sync.js";
import { log } from "../services/logger.js";
import { getDbDiagnostics, getDbStatus } from "../services/db.js";
import { getBackupStatus } from "../services/backup.js";
import { checkRotationHealth, getSecretBackend } from "../services/secrets/index.js";

import { rpcPoolManager } from "../services/stellar.js";
import { getAllCircuitBreakerMetrics } from "../services/circuit-breaker.js";
import { getMemorySnapshot } from "../services/memory-monitor.js";
import v8 from "node:v8";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const router = Router();

// Dependencies injected during setup
let server: StellarSdk.rpc.Server | null = null;
let relayerPublicKey: string = "";

/**
 * Initialize health routes with dependencies
 */
export function initHealthRoutes(
  rpcServer:
    | StellarSdk.rpc.Server
    | { getHealth: () => Promise<{ status: string }> },
  relayerPubKey: string,
): void {
  server = rpcServer as StellarSdk.rpc.Server;
  relayerPublicKey = relayerPubKey;
}

/**
 * Check RPC health status
 */
async function rpcHealth(): Promise<{
  ok: boolean;
  info?: unknown;
  error?: string;
}> {
  if (!server) {
    return { ok: false, error: "RPC server not initialized" };
  }

  try {
    const info = await server.getHealth();
    // Soroban SDK returns 'healthy', but we check for both to be safe
    const status = info?.status as string;
    return { ok: status === "healthy" || status === "online", info };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * GET /health
 * Basic health check
 */
router.get("/health", async (req: Request, res: Response) => {
  const rpc = config.healthcheckPing ? await rpcHealth() : { ok: true };
  const memory = getMemorySnapshot();
  const base: Record<string, unknown> = {
    status: "ok",
    rpc: {
      ...rpc,
      pool: rpcPoolManager.getMetrics(),
    },
    circuitBreakers: getAllCircuitBreakerMetrics(),
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      limitMb: memory.limitMb,
      usageRatio: Math.round(memory.usageRatio * 1000) / 1000,
    },
  };

  // Only expose details if auth token provided
  if (config.healthExposeDetails) {
    const token = extractAuthToken(req);
    if (token === config.relayerAuthToken) {
      base.relayer = relayerPublicKey;
      base.votingContract = config.votingContractId;
      base.treeContract = config.treeContractId;
      base.vkVersion = config.staticVkVersion;
      base.rateLimits = getRateLimitMetrics();
      base.membershipVerification = getMembershipVerificationMetrics();
    }
  }

  // Always include basic DB status (no auth needed for aggregate stats)
  try {
    base.db = getDbStatus();
    base.backup = getBackupStatus();
  } catch (err) {
    base.db = { error: (err as Error).message };
  }

  res.json(base);
});

/**
 * GET /ready
 * Readiness check (verifies RPC connectivity)
 */
router.get("/ready", async (req: Request, res: Response) => {
  try {
    const rpcStatus = await rpcHealth();
    if (!rpcStatus.ok) {
      return res.status(503).json({ status: "degraded", rpc: rpcStatus });
    }

    const base: Record<string, unknown> = { status: "ready" };

    // Only expose details if auth token provided
    if (config.healthExposeDetails) {
      const token = extractAuthToken(req);
      if (token === config.relayerAuthToken) {
        base.relayer = relayerPublicKey;
        base.votingContract = config.votingContractId;
        base.treeContract = config.treeContractId;
        base.vkVersion = config.staticVkVersion;
      }
    }

    return res.json(base);
  } catch (err) {
    log("error", "ready_check_failed", { error: (err as Error).message });
    return res
      .status(503)
      .json({ status: "error", message: (err as Error).message });
  }
});

/**
 * GET /config
 * Returns public configuration (for frontend)
 */
router.get("/config", (_req: Request, res: Response) => {
  res.json({
    votingContract: config.votingContractId,
    treeContract: config.treeContractId,
    commentsContract: config.commentsContractId,
    daoRegistryContract: config.daoRegistryContractId,
    membershipSbtContract: config.membershipSbtContractId,
    networkPassphrase: config.networkPassphrase,
    rpcUrl: config.rpcUrl,
    ipfsEnabled: config.ipfsEnabled,
    pinataGateway: config.pinataGateway,
  });
});

/**
 * GET /db/stats
 * Database diagnostics endpoint (admin only)
 */
router.get("/db/stats", async (req: Request, res: Response) => {
  // Require auth token for detailed diagnostics
  if (config.healthExposeDetails) {
    const token = extractAuthToken(req);
    if (token !== config.relayerAuthToken) {
      // Return basic stats without diagnostics
      try {
        const dbStatus = getDbStatus();
        return res.json({ status: "unauthorized", db: dbStatus });
      } catch (err) {
        return res.status(500).json({ error: (err as Error).message });
      }
    }
  }

  try {
    const diagnostics = getDbDiagnostics();
    res.json(diagnostics);
  } catch (err) {
    log("error", "db_stats_failed", { error: (err as Error).message });
    res.status(500).json({ error: "Failed to get database statistics" });
  }
});

/**
 * GET /debug/heap
 * Writes a V8 heap snapshot and returns it for download (admin only).
 * Used to diagnose memory leaks in the long-running relayer process.
 */
router.get("/debug/heap", async (req: Request, res: Response) => {
  const token = extractAuthToken(req);
  if (!config.relayerAuthToken || token !== config.relayerAuthToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const snapshotPath = path.join(
    os.tmpdir(),
    `zkvote-heap-${Date.now()}.heapsnapshot`,
  );

  try {
    log("info", "heap_snapshot_requested", { path: snapshotPath });
    v8.writeHeapSnapshot(snapshotPath);

    res.download(snapshotPath, path.basename(snapshotPath), (err) => {
      fs.unlink(snapshotPath, () => {});
      if (err) {
        log("error", "heap_snapshot_send_failed", { error: err.message });
      }
    });
  } catch (err) {
    log("error", "heap_snapshot_failed", { error: (err as Error).message });
    fs.unlink(snapshotPath, () => {});
    res.status(500).json({ error: "Failed to generate heap snapshot" });
  }
});

export default router;
