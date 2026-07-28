/**
 * CSRF Protection Middleware
 *
 * Validates Origin header for write requests when CORS is configured.
 * This adds defense-in-depth beyond the auth token.
 */

import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { log } from "../services/logger.js";

/**
 * CSRF guard middleware
 * Validates Origin header against allowed origins for write operations
 */
export function csrfGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Response {
  // Skip for safe methods
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  // N12 hardening: with wildcard CORS, any third-party origin could POST
  // to write endpoints — fail-closed instead of waving the request through.
  // Production deploys must set CORS_ORIGIN to the frontend origin.
  if (config.corsOrigins === "*" || !config.corsOrigins) {
    log("warn", "csrf_blocked_wildcard_cors", { path: req.path });
    return res
      .status(403)
      .json({ error: "CORS_ORIGIN must be configured for write endpoints" });
  }

  // Get origin from headers. A malformed Referer must fail closed rather
  // than throwing and being converted into an internal server error.
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  let requestOrigin = typeof origin === "string" ? origin : null;

  if (!requestOrigin && typeof referer === "string") {
    try {
      requestOrigin = new URL(referer).origin;
    } catch {
      log("warn", "csrf_invalid_referer", {
        path: req.path,
        referer,
      });
      return res.status(403).json({ error: "Origin not allowed" });
    }
  }

  // If no origin header (e.g., curl, server-to-server), require auth token only
  if (!requestOrigin) {
    return next();
  }

  // Validate origin against allowed origins
  const allowedOrigins = Array.isArray(config.corsOrigins)
    ? config.corsOrigins
    : [config.corsOrigins];
  if (!allowedOrigins.includes(requestOrigin)) {
    log("warn", "csrf_origin_mismatch", {
      path: req.path,
      origin: requestOrigin,
      allowed: allowedOrigins,
    });
    return res.status(403).json({ error: "Origin not allowed" });
  }

  next();
}
