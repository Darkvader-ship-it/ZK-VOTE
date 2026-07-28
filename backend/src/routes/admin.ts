/**
 * Admin Routes
 *
 * Read-only review of the audit log (append-only, hash-chained trail of
 * privileged actions recorded by middleware/audit.ts).
 */

import { Router, type Request, type Response } from "express";

import { authGuard, queryLimiter } from "../middleware/index.js";
import {
  getAuditLogs,
  verifyAuditChain,
  formatAsCef,
} from "../services/audit.js";
import { log } from "../services/logger.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

/**
 * GET /admin/audit-log - Paginated audit log review (admin only).
 *
 * Query params:
 *   limit    - max rows (default 50, max 500)
 *   offset   - pagination offset (default 0)
 *   action   - filter by action name
 *   format   - "json" (default) or "cef"
 *   verify   - "true" to include a hash-chain integrity check
 */
router.get("/admin/audit-log", authGuard, queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const action =
      typeof req.query.action === "string" ? req.query.action : undefined;
    const format = req.query.format === "cef" ? "cef" : "json";
    const includeVerification = req.query.verify === "true";

    const { logs, total } = getAuditLogs({ limit, offset, action });

    if (format === "cef") {
      res.type("text/plain").send(formatAsCef(logs));
      return;
    }

    const body: Record<string, unknown> = { logs, total, limit, offset };
    if (includeVerification) {
      body.chainVerification = verifyAuditChain();
    }
    res.json(body);
  } catch (err) {
    log("error", "admin_audit_log_failed", { error: (err as Error).message });
    res.status(500).json({ error: "Failed to fetch audit log" });
  }
}) as AsyncHandler);

export default router;
