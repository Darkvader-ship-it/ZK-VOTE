/**
 * Prometheus Metrics Endpoint
 *
 * Exposes /metrics in Prometheus text exposition format.
 */

import { Router, Request, Response } from "express";
import { register } from "../services/metrics.js";
import { rpcPoolManager } from "../services/stellar.js";
import { getDbStatus } from "../services/db.js";

const router = Router();

/**
 * GET /metrics
 * Prometheus-compatible metrics endpoint
 */
router.get("/metrics", async (_req: Request, res: Response) => {
  try {
    // Update RPC pool gauges before collecting
    const poolMetrics = rpcPoolManager.getMetrics();

    // Use collect functions on existing metrics rather than registerMetric
    const healthyEp = register.getSingleMetric("zkvote_rpc_pool_healthy_endpoints");
    const totalEp = register.getSingleMetric("zkvote_rpc_pool_total_endpoints");

    if (healthyEp && "set" in healthyEp) {
      (healthyEp as any).set(poolMetrics.healthyEndpoints);
    }
    if (totalEp && "set" in totalEp) {
      (totalEp as any).set(poolMetrics.totalEndpoints);
    }

    // Update DB WAL size
    try {
      const dbStatus = getDbStatus() as unknown as Record<string, unknown>;
      if (dbStatus && typeof dbStatus === "object") {
        const walSize = dbStatus.walSizeBytes;
        if (typeof walSize === "number") {
          const walMetric = register.getSingleMetric("zkvote_db_wal_size_bytes");
          if (walMetric && "set" in walMetric) {
            (walMetric as any).set(walSize);
          }
        }
      }
    } catch {
      // DB not initialized yet — skip
    }

    const metrics = await register.metrics();
    res.set("Content-Type", register.contentType);
    res.end(metrics);
  } catch (err) {
    res.status(500).end(`Error collecting metrics: ${(err as Error).message}`);
  }
});

export default router;
