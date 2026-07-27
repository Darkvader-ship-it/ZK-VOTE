/**
 * IPFS Pin Monitor — Periodic Verification & Alerting
 *
 * Runs a configurable interval loop that:
 *  1. Verifies all pinned CIDs are still retrievable
 *  2. Attempts re-pin for any content that has become unavailable
 *  3. Logs alerts for persistent failures
 *  4. Exposes status for the /ipfs/health endpoint
 */

import { createLogger } from "./logger.js";
import * as pinManager from "./ipfs-pin-manager.js";

const log = createLogger("pin-monitor");

// ============================================
// TYPES
// ============================================

export interface MonitorConfig {
  /** Interval between full verification scans (ms). Default: 1 hour */
  scanIntervalMs: number;
  /** Number of consecutive failures before triggering an alert. Default: 3 */
  alertThreshold: number;
  /** Whether to auto-repin failed CIDs from local backup. Default: true */
  autoRepin: boolean;
  /** Callback for re-pinning from backup */
  repinFn?: (
    backupPath: string,
    contentType: "json" | "file",
    name: string,
    mimeType?: string,
  ) => Promise<string>;
}

export interface MonitorStatus {
  running: boolean;
  scanIntervalMs: number;
  lastScanAt: string | null;
  lastScanDurationMs: number | null;
  nextScanAt: string | null;
  stats: pinManager.PinManagerStats;
  alerts: PinAlert[];
}

export interface PinAlert {
  cid: string;
  severity: "warning" | "critical";
  message: string;
  timestamp: string;
  consecutiveFailures: number;
}

// ============================================
// MODULE STATE
// ============================================

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
let monitorConfig: MonitorConfig | null = null;
let lastScanAt: string | null = null;
let lastScanDurationMs: number | null = null;
let nextScanAt: string | null = null;
let activeAlerts: PinAlert[] = [];
let isScanning = false;

// ============================================
// LIFECYCLE
// ============================================

/**
 * Start the periodic pin verification monitor.
 */
export function startMonitor(config: MonitorConfig): void {
  if (intervalHandle) {
    log.warn("monitor_already_running");
    return;
  }

  monitorConfig = config;

  log.info("pin_monitor_starting", {
    scanIntervalMs: config.scanIntervalMs,
    alertThreshold: config.alertThreshold,
    autoRepin: config.autoRepin,
  });

  // Schedule the first scan after a short delay (let startup finish)
  const initialDelay = Math.min(config.scanIntervalMs, 60_000); // max 1 min
  nextScanAt = new Date(Date.now() + initialDelay).toISOString();

  timeoutHandle = setTimeout(() => {
    timeoutHandle = null;
    _runScan();
    // Then schedule repeating scans
    intervalHandle = setInterval(_runScan, config.scanIntervalMs);
  }, initialDelay);
}

/**
 * Stop the pin verification monitor.
 */
export function stopMonitor(): void {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  log.info("pin_monitor_stopped");
}

/**
 * Manually trigger a verification scan (e.g. from admin endpoint).
 */
export async function triggerScan(): Promise<void> {
  if (isScanning) {
    log.warn("scan_already_in_progress");
    return;
  }
  await _runScan();
}

/**
 * Get the current monitor status for the health endpoint.
 */
export function getMonitorStatus(): MonitorStatus {
  return {
    running: intervalHandle !== null || timeoutHandle !== null,
    scanIntervalMs: monitorConfig?.scanIntervalMs ?? 0,
    lastScanAt,
    lastScanDurationMs,
    nextScanAt,
    stats: pinManager.getStats(),
    alerts: [...activeAlerts],
  };
}

/**
 * Get all active alerts.
 */
export function getAlerts(): PinAlert[] {
  return [...activeAlerts];
}

// ============================================
// INTERNAL SCAN LOGIC
// ============================================

async function _runScan(): Promise<void> {
  if (isScanning) return;
  isScanning = true;

  log.info("pin_verification_scan_started");

  try {
    const { healthy, failed, duration } = await pinManager.verifyAllPins();

    lastScanAt = new Date().toISOString();
    lastScanDurationMs = duration;
    nextScanAt = monitorConfig
      ? new Date(Date.now() + monitorConfig.scanIntervalMs).toISOString()
      : null;

    // Process failures — generate alerts and optionally re-pin
    const newAlerts: PinAlert[] = [];

    for (const cid of failed) {
      const record = pinManager.getPinRecord(cid);
      if (!record) continue;

      const threshold = monitorConfig?.alertThreshold ?? 3;

      if (record.consecutiveFailures >= threshold) {
        const alert: PinAlert = {
          cid,
          severity: record.consecutiveFailures >= threshold * 2 ? "critical" : "warning",
          message: `CID ${cid} unreachable for ${record.consecutiveFailures} consecutive checks`,
          timestamp: new Date().toISOString(),
          consecutiveFailures: record.consecutiveFailures,
        };
        newAlerts.push(alert);

        log.warn("pin_alert", {
          cid,
          severity: alert.severity,
          failures: record.consecutiveFailures,
        });

        // Auto re-pin if configured
        if (monitorConfig?.autoRepin && monitorConfig.repinFn) {
          log.info("auto_repin_attempt", { cid });
          const newCid = await pinManager.repinFromBackup(cid, monitorConfig.repinFn);
          if (newCid) {
            log.info("auto_repin_success", { oldCid: cid, newCid });
          } else {
            log.error("auto_repin_failed", { cid });
          }
        }
      }
    }

    // Replace old alerts with fresh ones (stale alerts auto-clear if CID recovers)
    activeAlerts = newAlerts;

    log.info("pin_verification_scan_complete", {
      healthy: healthy.length,
      failed: failed.length,
      alerts: newAlerts.length,
      durationMs: duration,
    });
  } catch (err) {
    log.error("pin_verification_scan_error", {
      error: (err as Error).message,
    });
  } finally {
    isScanning = false;
  }
}
