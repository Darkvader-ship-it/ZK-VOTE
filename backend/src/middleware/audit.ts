/**
 * Audit Logging Middleware
 *
 * Records an immutable audit_log entry for privileged endpoints, once the
 * response has finished (so the final status code is captured). Applied
 * after authGuard on each route, so only authenticated access is recorded.
 */

import type { Request, Response, NextFunction } from "express";
import { extractAuthToken } from "./auth.js";
import {
  recordAuditLog,
  hashAuthToken,
  hashClientIp,
} from "../services/audit.js";
import { log } from "../services/logger.js";

/**
 * Build audit-logging middleware for a named action.
 */
export function auditLog(action: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on("finish", () => {
      try {
        recordAuditLog({
          action,
          endpoint: `${req.method} ${req.path}`,
          authTokenId: hashAuthToken(extractAuthToken(req)),
          ipHash: hashClientIp(req.ip),
          requestId: req.ctx ?? null,
          params:
            req.body && typeof req.body === "object" ? req.body : undefined,
          statusCode: res.statusCode,
        });
      } catch (err) {
        log("error", "audit_log_write_failed", {
          action,
          error: (err as Error).message,
        });
      }
    });
    next();
  };
}
