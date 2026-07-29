/**
 * Request Logging Middleware
 *
 * Provides request context and structured logging for all requests.
 * Supports PII redaction via the enhanced logger.
 */

import type { Request, Response, NextFunction } from "express";

// Extend Express Request to include ctx
declare global {
  namespace Express {
    interface Request {
      ctx?: string;
    }
  }
}
import crypto from "crypto";
// import { config } from "../config.js"; // Unused - kept for reference
import { log, hashIp, getRedactionPolicy } from "../services/logger.js";

/**
 * Request logging middleware
 * Adds context ID and logs request start/end
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ctx = crypto.randomBytes(6).toString("hex");
  req.ctx = ctx;

  // Build IP meta based on configuration
  const policy = getRedactionPolicy();
  let ipMeta: Record<string, string> = {};
  
  if (policy.showClientIp === "plain") {
    ipMeta = { ip: req.ip || "" };
  } else if (policy.showClientIp === "hash") {
    ipMeta = { ipHash: hashIp(req.ip) };
  }
  // If "none", ipMeta stays empty

  // Build body meta (only log body keys, not values)
  const bodyMeta = policy.showBodyKeysOnly
    ? { bodyKeys: Object.keys(req.body || {}) }
    : {};

  log("info", "request_start", {
    ctx,
    path: req.path,
    method: req.method,
    ...ipMeta,
    ...bodyMeta,
  });

  // Log request end on finish
  res.on("finish", () => {
    log("info", "request_end", {
      ctx,
      path: req.path,
      status: res.statusCode,
    });
  });

  next();
}

/**
 * Error logging middleware with redaction
 * Logs errors without exposing sensitive data
 */
export function errorLogger(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ctx = req.ctx || "unknown";
  const isProduction = process.env.NODE_ENV === "production";
  
  // Log the error with redaction
  log("error", "request_error", {
    ctx,
    path: req.path,
    method: req.method,
    error: err.message,
    // In production, don't log stack traces
    ...(isProduction ? {} : { stack: err.stack }),
  });
  
  next(err);
}
