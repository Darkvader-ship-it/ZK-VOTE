/**
 * ZKVote Backend - Main Entry Point
 *
 * TypeScript backend relayer for anonymous voting on Stellar/Soroban.
 * Provides vote submission, IPFS integration, event indexing, and DAO caching.
 */

import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";

import { buildOpenApiDocument } from "./openapi.js";

// Configuration and types
import { config, validateEnv, isValidContractId } from "./config.js";

// Services
import { log, logger } from "./services/logger.js";
import * as ipfsService from "./services/ipfs.js";
import { initPinManager } from "./services/ipfs-pin-manager.js";
import { getDb } from "./services/db.js";
import {
  startWalCheckpointing,
  stopWalResilience,
  startWalMonitor,
  startPeriodicBackups,
  performInitialCheckpoint,
  detectAndHandleWalIssue,
} from "./services/walResilience.js";
import {
  startMonitor as startPinMonitor,
  stopMonitor as stopPinMonitor,
} from "./services/ipfs-monitor.js";
import { server, relayerKeypair } from "./services/stellar.js";
import {
  startDaoSync,
  stopDaoSync,
  startMembershipSync,
  stopMembershipSync,
  triggerDaoMembershipSync,
} from "./services/sync.js";
import { startIndexer, stopIndexer } from "./services/indexer.js";
import { startTTLRenewal, stopTTLRenewal } from "./services/ttl.js";
import { startMemoryMonitor, stopMemoryMonitor } from "./services/memory-monitor.js";

// Middleware
import {
  csrfGuard,
  requestLogger,
  errorHandler,
  graduatedSlowDown,
} from "./middleware/index.js";

// Routes
import {
  healthRoutes,
  initHealthRoutes,
  votingRoutes,
  daoRoutes,
  ipfsRoutes,
  commentsRoutes,
  indexerRoutes,
  initIndexerRoutes,
  bridgeRoutes,
  circuitRoutes,
  adminRoutes,
} from "./routes/index.js";

// ============================================
// ENVIRONMENT VALIDATION
// ============================================

validateEnv();

// ============================================
// EXPRESS APP SETUP
// ============================================

const app: Express = express();

// Security: HTTP headers
app.use(helmet());

// Metrics middleware (before other middleware to capture all requests)
app.use(metricsMiddleware);

// Security: CORS configuration
const corsOrigins = config.corsOrigins === "*" ? "*" : config.corsOrigins;
const corsOptions: cors.CorsOptions = {
  origin: corsOrigins,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Relayer-Auth"],
  maxAge: 86400, // 24 hours
};
app.use(cors(corsOptions));

// Security: Request body size limit
app.use(express.json({ limit: "100kb" }));

// Logging middleware
app.use(requestLogger);

// Graduated throttling (delays before a client is hard rate-limited)
app.use(graduatedSlowDown);

// CSRF protection (applied globally)
app.use(csrfGuard);

// ============================================
// ROUTE INITIALIZATION
// ============================================

// Initialize routes that need dependencies
initHealthRoutes(server, relayerKeypair.publicKey());
initIndexerRoutes(triggerDaoMembershipSync);

// Mount route handlers (metrics first, before CSRF/auth middleware)
app.use(metricsRoutes);
app.use(healthRoutes);
app.use(remediationRoutes);
app.use(votingRoutes);
app.use(daoRoutes);
app.use(ipfsRoutes);
app.use(commentsRoutes);
app.use(indexerRoutes);
app.use(bridgeRoutes);
app.use(circuitRoutes);
app.use(adminRoutes);

// OpenAPI spec + interactive docs
const openApiDocument = buildOpenApiDocument();
app.get("/api-docs/openapi.json", (_req, res) => res.json(openApiDocument));
app.use(
  "/api-docs",
  // helmet's default CSP blocks the inline scripts/styles Swagger UI's
  // bundled assets need; relax it for this documentation-only route.
  (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    res.removeHeader("Content-Security-Policy");
    next();
  },
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument),
);

// Global error handler (must be last)
app.use(errorHandler);

// ============================================
// SERVER STARTUP
// ============================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = config.port;

  const httpServer = app.listen(PORT, async () => {
    logger.info("server_started", {
      port: PORT,
      network: config.networkPassphrase,
      rpcUrl: config.rpcUrl,
      relayer: relayerKeypair.publicKey(),
    });

    // Keep the startup banner on stdout for human-readable output
    console.log(`\nZKVote Relayer running on http://localhost:${PORT}`);

    logger.info("endpoints_registered", {
      core: [
        "/health",
        "/ready",
        "/config",
        "/vote",
        "/proposal/:dao/:prop",
        "/root/:dao",
        "/events/:daoId",
        "/events/notify",
        "/indexer/status",
      ],
      comments: [
        "/comment/anonymous",
        "/comments/:dao/:prop",
        "/comments/:dao/:prop/nonce",
        "/comment/:dao/:prop/:id",
        "/comment/edit",
        "/comment/delete",
      ],
      bridge: [
        "/bridge/vote",
        "/bridge/nullifier/:daoId/:proposalId/:nullifier",
        "/bridge/relay",
      ],
      ipfs: config.ipfsEnabled
        ? [
            "/ipfs/image",
            "/ipfs/metadata",
            "/ipfs/:cid",
            "/ipfs/image/:cid",
            "/ipfs/health",
          ]
        : [],
    });

    // Initialize Pinata and IPFS redundancy layer
    if (config.ipfsEnabled && config.pinataJwt) {
      try {
        ipfsService.initPinata(config.pinataJwt, config.pinataGateway);
        log("info", "pinata_initialized");

        // Initialize pin manager (local backup + secondary pinning)
        try {
          initPinManager(config.ipfsBackupDir, config.web3StorageToken);
          log("info", "pin_manager_initialized", {
            backupDir: config.ipfsBackupDir,
            hasWeb3Storage: !!config.web3StorageToken,
          });

          // Start pin verification monitor
          startPinMonitor({
            scanIntervalMs: config.pinVerifyIntervalMs,
            alertThreshold: config.pinAlertThreshold,
            autoRepin: config.pinAutoRepin,
            repinFn: ipfsService.repinCallback,
          });
          log("info", "pin_monitor_started", {
            intervalMs: config.pinVerifyIntervalMs,
            alertThreshold: config.pinAlertThreshold,
            autoRepin: config.pinAutoRepin,
          });
        } catch (err) {
          log("warn", "pin_manager_init_failed", {
            error: (err as Error).message,
          });
        }
      } catch (err) {
        log("error", "pinata_init_failed", { error: (err as Error).message });
      }
    }

    // Start event indexer
    if (config.indexerEnabled) {
      const contractIds = [config.votingContractId!, config.treeContractId!];
      if (
        config.daoRegistryContractId &&
        isValidContractId(config.daoRegistryContractId)
      ) {
        contractIds.push(config.daoRegistryContractId);
      }
      if (
        config.membershipSbtContractId &&
        isValidContractId(config.membershipSbtContractId)
      ) {
        contractIds.push(config.membershipSbtContractId);
      }

      try {
        await startIndexer(
          server as any,
          contractIds,
          config.indexerPollIntervalMs,
        );
        log("info", "indexer_enabled", { contracts: contractIds.length });
      } catch (err) {
        log("warn", "indexer_start_failed", { error: (err as Error).message });
      }
    }

    // Start DAO sync
    if (
      config.daoRegistryContractId &&
      isValidContractId(config.daoRegistryContractId)
    ) {
      console.log("\nDAO Cache Endpoints:");
      console.log("  GET  /daos                - Get all DAOs (cached)");
      console.log(
        "  GET  /daos?user=ADDRESS   - Get DAOs with membership info",
      );
      console.log("  GET  /dao/:daoId          - Get single DAO (cached)");
      console.log("  POST /daos/sync           - Trigger DAO sync (admin)");
      startDaoSync();

      // Start membership sync
      if (
        config.membershipSbtContractId &&
        isValidContractId(config.membershipSbtContractId)
      ) {
        startMembershipSync();
      }
    }

    // Start TTL renewal service (prevents contract data from expiring)
    startTTLRenewal();

    // Start WAL resilience services (checkpointing, monitoring, backups)
    try {
      const database = getDb();
      const dbPath = database.name;
      performInitialCheckpoint(database);
      detectAndHandleWalIssue(database, dbPath);
      startWalCheckpointing(database);
      startWalMonitor(database, dbPath);
      startPeriodicBackups(database, dbPath);
    } catch (err) {
      log("warn", "wal_resilience_start_failed", { error: (err as Error).message });
    }

    // Start periodic memory monitoring; triggers a graceful restart if
    // usage crosses the critical threshold (see #191).
    startMemoryMonitor(() => gracefulShutdown("memory_threshold"));
  });

  // ============================================
  // GRACEFUL SHUTDOWN (zero-downtime deploys, see #190)
  // ============================================
  //
  // Stops accepting new connections and lets in-flight requests finish
  // (draining) before exiting, instead of killing the process immediately.
  // Fly.io's [http_service.checks] fail the instance out of rotation
  // before SIGTERM is sent, so no new traffic should arrive during drain;
  // this still protects requests already in flight. `kill_timeout` in
  // fly.toml must be >= DRAIN_TIMEOUT_MS below or the platform will
  // SIGKILL before the drain completes.
  const DRAIN_TIMEOUT_MS = 25_000;
  let shuttingDown = false;

  function gracefulShutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    log("info", "shutdown_start", { reason });

    // Stop background interval services immediately — they don't need to
    // finish an in-flight cycle, and stopping them frees timers/handles.
    stopIndexer();
    stopDaoSync();
    stopMembershipSync();
    stopTTLRenewal();
    stopPinMonitor();
    stopMemoryMonitor();
    stopWalResilience();

    const forceExitTimer = setTimeout(() => {
      log("warn", "shutdown_forced", { reason, timeoutMs: DRAIN_TIMEOUT_MS });
      process.exit(1);
    }, DRAIN_TIMEOUT_MS);
    forceExitTimer.unref();

    httpServer.close((err) => {
      if (err) {
        log("error", "shutdown_close_error", { error: err.message });
      } else {
        log("info", "shutdown_complete", { reason });
      }
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

export { app };
