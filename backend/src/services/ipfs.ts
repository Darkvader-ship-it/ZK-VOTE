/**
 * IPFS/Pinata Integration Module (SDK v2.5.1)
 *
 * Handles pinning and fetching content from IPFS via Pinata.
 * Also propagates content to public IPFS gateways for redundancy.
 * Integrates with the Pin Manager for backup, redundancy, and verification.
 */

import fs from "node:fs";
import { PinataSDK } from "pinata";
import * as pinManager from "./ipfs-pin-manager.js";
import { getMonitorStatus, type MonitorStatus } from "./ipfs-monitor.js";
import {
  ipfsPinsTotal,
  ipfsFetchDuration,
  ipfsCacheHits,
  ipfsCacheMisses,
} from "./metrics.js";
import { registerCircuitBreaker } from "./circuit-breaker.js";
import { config } from "../config.js";

// Circuit breakers for external IPFS dependencies. Trips fast when Pinata
// or the public gateways are degraded, instead of letting every caller run
// its own retry logic against a service that is known to be down.
const pinataBreaker = registerCircuitBreaker("pinata", {
  failureThreshold: config.circuitBreakerPinataFailureThreshold,
  resetTimeoutMs: config.circuitBreakerPinataResetMs,
});
const ipfsGatewayBreaker = registerCircuitBreaker("ipfs_gateway", {
  failureThreshold: config.circuitBreakerGatewayFailureThreshold,
  resetTimeoutMs: config.circuitBreakerGatewayResetMs,
});

// ============================================
// TYPES
// ============================================

export interface PinResult {
  cid: string;
  size: number;
  publicUrl: string;
}

export interface FetchResult {
  data: unknown;
  contentType: string;
}

export interface RawFetchResult {
  buffer: Buffer;
  contentType: string;
}

export interface PublicUrls {
  primary: string;
  fallbacks: string[];
}

interface MetadataSchema {
  requiredFields: string[];
  maxBodyLength: number;
  allowedVersions: number[];
}

export interface MetadataValidationResult {
  valid: boolean;
  error?: string;
}

// ============================================
// LOGGER
// ============================================

import { createLogger } from "./logger.js";

const ipfsLogger = createLogger("ipfs");
const log = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  meta: Record<string, unknown> = {},
): void => {
  ipfsLogger[level](event, meta);
};

// ============================================
// MODULE STATE
// ============================================

let pinata: PinataSDK | null = null;
let gatewayUrl: string | null = null;
let isDedicatedGateway = false;

// Public IPFS gateways for propagation and fallback access
const PUBLIC_GATEWAYS = [
  "https://ipfs.io/ipfs",
  "https://dweb.link/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
  "https://w3s.link/ipfs",
];

// Content size limits (DoS protection)
export const MAX_JSON_SIZE = 1024 * 1024; // 1MB for JSON metadata
export const MAX_RAW_SIZE = 10 * 1024 * 1024; // 10MB for raw content (images)

// Metadata schema validation
export const PROPOSAL_METADATA_SCHEMA: MetadataSchema = {
  requiredFields: ["version", "body"],
  maxBodyLength: 100000, // 100KB of text
  allowedVersions: [1],
};

export const COMMENT_METADATA_SCHEMA: MetadataSchema = {
  requiredFields: ["version", "body", "createdAt"],
  maxBodyLength: 10000, // 10KB for comments
  allowedVersions: [1],
};

// ============================================
// SANITIZATION FUNCTIONS
// ============================================

/**
 * Sanitize string content to prevent XSS
 * Removes script tags and event handlers
 */
export function sanitizeString(str: string): string {
  if (typeof str !== "string") return str;

  // Remove script tags and their content
  let sanitized = str.replace(
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    "",
  );

  // Remove event handlers (onclick, onerror, etc.)
  sanitized = sanitized.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "");
  sanitized = sanitized.replace(/\bon\w+\s*=\s*[^\s>]*/gi, "");

  // Remove javascript: URLs
  sanitized = sanitized.replace(/javascript:/gi, "");

  // Remove data: URLs that could contain scripts
  sanitized = sanitized.replace(/data:\s*text\/html/gi, "data:blocked");

  return sanitized;
}

/**
 * Validate metadata against a schema
 */
export function validateMetadataSchema(
  data: unknown,
  schema: MetadataSchema,
): MetadataValidationResult {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Metadata must be an object" };
  }

  const obj = data as Record<string, unknown>;

  // Check required fields
  for (const field of schema.requiredFields) {
    if (!(field in obj)) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Validate version
  if (
    "version" in obj &&
    !schema.allowedVersions.includes(obj.version as number)
  ) {
    return { valid: false, error: `Invalid version: ${obj.version}` };
  }

  // Validate body length
  if ("body" in obj) {
    if (typeof obj.body !== "string") {
      return { valid: false, error: "Body must be a string" };
    }
    if (obj.body.length > schema.maxBodyLength) {
      return {
        valid: false,
        error: `Body exceeds maximum length of ${schema.maxBodyLength}`,
      };
    }
  }

  // Validate createdAt format if present
  if ("createdAt" in obj && typeof obj.createdAt === "string") {
    const date = new Date(obj.createdAt);
    if (isNaN(date.getTime())) {
      return { valid: false, error: "Invalid createdAt date format" };
    }
  }

  return { valid: true };
}

/**
 * Sanitize metadata object recursively
 */
export function sanitizeMetadata<T>(data: T): T {
  if (typeof data === "string") {
    return sanitizeString(data) as unknown as T;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeMetadata) as unknown as T;
  }

  if (data && typeof data === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype" || key.startsWith("__")) {
        continue;
      }
      // Sanitize both keys and values
      const sanitizedKey = sanitizeString(key);
      if (sanitizedKey === "__proto__" || sanitizedKey === "constructor" || sanitizedKey === "prototype" || sanitizedKey.startsWith("__")) {
        continue;
      }
      sanitized[sanitizedKey] = sanitizeMetadata(value);
    }
    return sanitized as T;
  }

  return data;
}

// ============================================
// PINATA CLIENT FUNCTIONS
// ============================================

/**
 * Initialize the Pinata client (SDK v2.x)
 */
export function initPinata(jwt: string, gateway?: string): void {
  if (!jwt) {
    throw new Error("PINATA_JWT is required");
  }

  gatewayUrl = gateway || "https://gateway.pinata.cloud";
  // Dedicated gateways use .mypinata.cloud domain and require signed URLs
  isDedicatedGateway = gatewayUrl.includes(".mypinata.cloud");

  pinata = new PinataSDK({
    pinataJwt: jwt,
    pinataGateway: gatewayUrl,
  });

  log("info", "pinata_initialized", { dedicatedGateway: isDedicatedGateway });
}

/**
 * Propagate content to public IPFS gateways (fire and forget)
 * This triggers public gateways to fetch and cache the content,
 * ensuring it's accessible even if our Pinata gateway goes down.
 */
async function propagateToPublicGateways(cid: string): Promise<void> {
  let cleanCid: string;
  try {
    cleanCid = sanitizeCid(cid);
  } catch {
    return;
  }

  // Fire off requests to public gateways in parallel (don't wait)
  const propagationPromises = PUBLIC_GATEWAYS.map(async (gateway) => {
    try {
      const url = `${gateway}/${cleanCid}`;
      if (!isAllowedGatewayUrl(url)) return;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(url, {
        method: "HEAD", // Just request headers to trigger caching
        signal: controller.signal,
        redirect: "error",
      });

      clearTimeout(timeout);

      if (response.ok) {
        log("debug", "ipfs_propagated", { gateway, cid: cleanCid });
      }
    } catch {
      // Ignore errors - this is best-effort propagation
      // Gateway might be slow or temporarily unavailable
    }
  });

  // Don't wait for all - just fire and forget
  Promise.allSettled(propagationPromises).then((results) => {
    const successful = results.filter((r) => r.status === "fulfilled").length;
    log("info", "ipfs_propagation_complete", {
      cid: cleanCid,
      successful,
      total: PUBLIC_GATEWAYS.length,
    });
  });
}

/**
 * Pin JSON data to public IPFS (SDK v2.x)
 */
export async function pinJSON(
  data: Record<string, unknown>,
  name = "zkvote-metadata",
): Promise<PinResult> {
  if (!pinata) {
    throw new Error("Pinata client not initialized");
  }

  // 1. Backup to local disk before uploading (recovery safety net)
  let backupPath: string | undefined;
  try {
    backupPath = pinManager.backupJSON(data, name);
  } catch (err) {
    log("warn", "local_backup_failed", { name, error: (err as Error).message });
    // Non-fatal — continue with the pin
  }

  // 2. Upload to Pinata (primary)
  // SDK v2.x: pinata.upload.public.json() with chainable methods
  const result = await pinataBreaker.execute(async () =>
    pinata!.upload.public.json(data).name(name).keyvalues({
      app: "zkvote",
      type: "proposal-metadata",
    }),
  );

  const sizeBytes = result.size || JSON.stringify(data).length;

  // 3. Register in pin tracker
  try {
    pinManager.registerPin(
      result.cid,
      "json",
      name,
      sizeBytes,
      "application/json",
      backupPath,
    );
  } catch (err) {
    log("warn", "pin_register_failed", {
      cid: result.cid,
      error: (err as Error).message,
    });
  }

  ipfsPinsTotal.inc({ type: "json", status: "success" });

  // 4. Secondary pin to Web3.Storage (best-effort, non-blocking)
  if (backupPath) {
    pinManager.pinToSecondary(result.cid, backupPath, "json").catch(() => {});
  }

  // 5. Propagate to public gateways in background
  propagateToPublicGateways(result.cid);

  return {
    cid: result.cid,
    size: sizeBytes,
    publicUrl: `https://ipfs.io/ipfs/${result.cid}`,
  };
}

/**
 * Pin a file (image) to public IPFS (SDK v2.x)
 */
export async function pinFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<PinResult> {
  if (!pinata) {
    throw new Error("Pinata client not initialized");
  }

  // 1. Backup to local disk before uploading (recovery safety net)
  let backupPath: string | undefined;
  try {
    backupPath = pinManager.backupFile(buffer, filename);
  } catch (err) {
    log("warn", "local_backup_failed", {
      filename,
      error: (err as Error).message,
    });
  }

  // 2. Upload to Pinata (primary)
  // Create a File object from the buffer
  // Cast buffer to BlobPart to satisfy strict TypeScript checks
  const file = new File([buffer as unknown as BlobPart], filename, {
    type: mimeType,
  });

  // SDK v2.x: pinata.upload.public.file() with chainable methods
  const result = await pinataBreaker.execute(async () =>
    pinata!.upload.public
      .file(file)
      .name(filename)
      .keyvalues({
        app: "zkvote",
        type: "proposal-image",
      }),
  );

  const sizeBytes = result.size || buffer.length;

  // 3. Register in pin tracker
  try {
    pinManager.registerPin(
      result.cid,
      "file",
      filename,
      sizeBytes,
      mimeType,
      backupPath,
    );
  } catch (err) {
    log("warn", "pin_register_failed", {
      cid: result.cid,
      error: (err as Error).message,
    });
  }

  ipfsPinsTotal.inc({ type: "file", status: "success" });

  // 4. Secondary pin to Web3.Storage (best-effort, non-blocking)
  if (backupPath) {
    pinManager.pinToSecondary(result.cid, backupPath, "file").catch(() => {});
  }

  // 5. Propagate to public gateways in background
  propagateToPublicGateways(result.cid);

  return {
    cid: result.cid,
    size: sizeBytes,
    publicUrl: `https://ipfs.io/ipfs/${result.cid}`,
  };
}

/**
 * CID format regexes
 * CIDv0: Base58 string starting with Qm, 46 characters long
 * CIDv1: Base32 string starting with baf, 50-120 characters long
 */
const CIDV0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CIDV1_REGEX = /^baf[a-z2-7]{46,120}$/i;

/**
 * Validate CID format (CIDv0 or CIDv1) strictly
 */
export function isValidCid(cid: string): boolean {
  if (!cid || typeof cid !== "string") {
    return false;
  }

  const trimmed = cid.trim();

  // Reject path separators, query params, hash fragments, control characters, whitespace
  if (/[\/\?\\#\s\0\r\n\t]/.test(trimmed)) {
    return false;
  }

  return CIDV0_REGEX.test(trimmed) || CIDV1_REGEX.test(trimmed);
}

/**
 * Sanitize CID before URL construction (reject path separators, query strings, etc.)
 */
export function sanitizeCid(cid: string): string {
  if (typeof cid !== "string") {
    throw new Error("Invalid CID parameter type");
  }

  const trimmed = cid.trim();

  if (/[\/\?\\#\s\0\r\n\t]/.test(trimmed)) {
    throw new Error("CID contains forbidden characters, query parameters, or path separators");
  }

  if (!isValidCid(trimmed)) {
    throw new Error("Invalid CID format");
  }

  return trimmed;
}

/**
 * Check if a host or IP is in a private/internal network range
 */
export function isPrivateIP(host: string): boolean {
  if (!host) return true;
  const h = host.toLowerCase().trim();

  // Localhost & local domain identifiers
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return true;
  }

  // Strip IPv6 brackets if present
  let ip = h.replace(/^\[|\]$/g, "");
  if (ip.startsWith("::ffff:")) {
    ip = ip.substring(7);
  }

  // Check IPv4 ranges
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return true;

    const [o1, o2, o3] = octets;

    // 0.0.0.0/8
    if (o1 === 0) return true;
    // 10.0.0.0/8 (Private network)
    if (o1 === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (o1 === 127) return true;
    // 169.254.0.0/16 (Link-local / Cloud Metadata)
    if (o1 === 169 && o2 === 254) return true;
    // 172.16.0.0/12 (Private network: 172.16.0.0 – 172.31.255.255)
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    // 192.168.0.0/16 (Private network)
    if (o1 === 192 && o2 === 168) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (o1 === 192 && o2 === 0 && o3 === 0) return true;
    // 192.0.2.0/24 (TEST-NET-1)
    if (o1 === 192 && o2 === 0 && o3 === 2) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (o1 === 198 && o2 === 51 && o3 === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (o1 === 203 && o2 === 0 && o3 === 113) return true;
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (o1 >= 224) return true;

    return false;
  }

  // Check IPv6 loopback, link-local, unique local
  if (
    ip === "::1" ||
    ip === "::" ||
    ip.startsWith("fe80:") ||
    ip.startsWith("fc") ||
    ip.startsWith("fd")
  ) {
    return true;
  }

  return false;
}

/**
 * Validate that a URL belongs to an allowed IPFS gateway and does not target private IPs
 */
export function isAllowedGatewayUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }

    if (parsed.username || parsed.password) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    if (isPrivateIP(hostname)) {
      return false;
    }

    // Match against configured gateway URL
    if (gatewayUrl) {
      try {
        const configuredHost = new URL(gatewayUrl).hostname.toLowerCase();
        if (hostname === configuredHost || hostname.endsWith("." + configuredHost)) {
          return true;
        }
      } catch {}
    }

    // Match against public gateways
    for (const gw of PUBLIC_GATEWAYS) {
      try {
        const gwHost = new URL(gw).hostname.toLowerCase();
        if (hostname === gwHost) {
          return true;
        }
      } catch {}
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Fetch content from IPFS via Pinata gateway
 */
export async function fetchContent(cid: string): Promise<FetchResult> {
  if (!gatewayUrl || !pinata) {
    throw new Error("Pinata client not initialized");
  }

  // Validate and sanitize CID format
  const cleanCid = sanitizeCid(cid);

  let url: string;

  if (isDedicatedGateway) {
    // SDK v2.x: Use gateways.private.createAccessLink for dedicated gateways
    try {
      const signedUrl = await pinata.gateways.private.createAccessLink({
        cid: cleanCid,
        expires: 300, // 5 minutes
      });
      url = signedUrl;
    } catch (err) {
      const error = err as Error;
      throw new Error(`Failed to create signed URL: ${error.message}`, {
        cause: err,
      });
    }
  } else {
    // Public gateway - direct URL
    url = `${gatewayUrl}/ipfs/${cleanCid}`;
  }

  if (!isAllowedGatewayUrl(url)) {
    throw new Error("Target URL is not an allowed gateway or resolves to a restricted IP address");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const fetchStart = performance.now();
  try {
    const response = await ipfsGatewayBreaker.execute(async () => {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!res.ok) {
        throw new Error(
          `Failed to fetch from IPFS: ${res.status} ${res.statusText}`,
        );
      }
      return res;
    });

    const contentType =
      response.headers.get("content-type") || "application/json";

    if (
      contentType.includes("text/html") ||
      contentType.includes("application/javascript") ||
      contentType.includes("text/javascript")
    ) {
      throw new Error(`Forbidden response content-type: ${contentType}`);
    }

    let data: unknown;
    if (contentType.includes("application/json")) {
      data = await response.json();
      ipfsCacheHits.inc();
    } else {
      data = await response.text();
      ipfsCacheHits.inc();
    }

    return {
      data,
      contentType,
    };
  } catch (err) {
    ipfsCacheMisses.inc();
    throw err;
  } finally {
    clearTimeout(timeout);
    const fetchDuration = (performance.now() - fetchStart) / 1000;
    ipfsFetchDuration.observe({ type: "json" }, fetchDuration);
  }
}

/**
 * Fetch raw content (e.g., image) from IPFS via Pinata gateway
 * Returns the raw buffer and content type for binary data
 */
export async function fetchRawContent(cid: string): Promise<RawFetchResult> {
  if (!gatewayUrl || !pinata) {
    throw new Error("Pinata client not initialized");
  }

  // Validate and sanitize CID format
  const cleanCid = sanitizeCid(cid);

  let url: string;

  if (isDedicatedGateway) {
    // SDK v2.x: Use gateways.private.createAccessLink for dedicated gateways
    try {
      const signedUrl = await pinata.gateways.private.createAccessLink({
        cid: cleanCid,
        expires: 300, // 5 minutes
      });
      url = signedUrl;
    } catch (err) {
      const error = err as Error;
      throw new Error(`Failed to create signed URL: ${error.message}`, {
        cause: err,
      });
    }
  } else {
    // Public gateway - direct URL
    url = `${gatewayUrl}/ipfs/${cleanCid}`;
  }

  if (!isAllowedGatewayUrl(url)) {
    throw new Error("Target URL is not an allowed gateway or resolves to a restricted IP address");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const fetchStart = performance.now();
  try {
    const response = await ipfsGatewayBreaker.execute(async () => {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!res.ok) {
        throw new Error(
          `Failed to fetch from IPFS: ${res.status} ${res.statusText}`,
        );
      }
      return res;
    });

    const contentType =
      response.headers.get("content-type") || "application/octet-stream";

    if (
      contentType.includes("text/html") ||
      contentType.includes("application/javascript") ||
      contentType.includes("text/javascript")
    ) {
      throw new Error(`Forbidden response content-type: ${contentType}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    ipfsCacheHits.inc();

    return {
      buffer,
      contentType,
    };
  } catch (err) {
    ipfsCacheMisses.inc();
    throw err;
  } finally {
    clearTimeout(timeout);
    const fetchDuration = (performance.now() - fetchStart) / 1000;
    ipfsFetchDuration.observe({ type: "raw" }, fetchDuration);
  }
}

/**
 * Check if Pinata is initialized and healthy (SDK v2.x)
 */
export async function isHealthy(): Promise<boolean> {
  if (!pinata) {
    return false;
  }

  try {
    // SDK v2.x: Test by listing public files
    await pinata.files.public.list().limit(1);
    return true;
  } catch (error) {
    const err = error as Error;
    log("error", "pinata_health_failed", { error: err.message });
    return false;
  }
}

/**
 * Enhanced health check that includes pin verification status.
 */
export function getEnhancedHealth(): MonitorStatus {
  return getMonitorStatus();
}

/**
 * Get public gateway URLs for a CID
 * These URLs are accessible without authentication and provide redundancy.
 */
export function getPublicUrls(cid: string): PublicUrls {
  return {
    primary: `https://ipfs.io/ipfs/${cid}`,
    fallbacks: PUBLIC_GATEWAYS.map((gw) => `${gw}/${cid}`),
  };
}

/**
 * Manually trigger propagation of a CID to public gateways
 * Use this to ensure older content is propagated.
 */
export function ensurePublicAvailability(cid: string): void {
  if (isValidCid(cid)) {
    propagateToPublicGateways(cid);
  }
}

/**
 * Re-pin callback for the pin monitor.
 * Reads content from the backup path and re-uploads to Pinata.
 */
export async function repinCallback(
  backupPath: string,
  contentType: "json" | "file",
  name: string,
  mimeType?: string,
): Promise<string> {
  if (!pinata) {
    throw new Error("Pinata client not initialized");
  }

  if (contentType === "json") {
    const raw = fs.readFileSync(backupPath, "utf-8");
    const data = JSON.parse(raw);
    const result = await pinata.upload.public.json(data).name(name).keyvalues({
      app: "zkvote",
      type: "proposal-metadata",
    });
    propagateToPublicGateways(result.cid);
    return result.cid;
  } else {
    const buffer = fs.readFileSync(backupPath);
    const file = new File([buffer as unknown as BlobPart], name, {
      type: mimeType || "application/octet-stream",
    });
    const result = await pinata.upload.public.file(file).name(name).keyvalues({
      app: "zkvote",
      type: "proposal-image",
    });
    propagateToPublicGateways(result.cid);
    return result.cid;
  }
}
