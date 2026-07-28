/**
 * Remediation Debugging & History Endpoint
 */

import { Router, type Request, type Response } from "express";
import { getRemediationHistory, getMTTRStats } from "../services/remediation.js";

const router = Router();

/**
 * GET /remediation/history
 * Returns remediation execution history and MTTR stats.
 */
router.get("/remediation/history", (req: Request, res: Response) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const history = getRemediationHistory(limit);
  const stats = getMTTRStats();

  res.json({
    status: "ok",
    historyCount: history.length,
    history,
    stats,
  });
});

export default router;
