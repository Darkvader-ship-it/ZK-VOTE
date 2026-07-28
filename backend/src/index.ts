/**
 * ZKVote Backend - Main Entry Point
 *
 * TypeScript backend relayer for anonymous voting on Stellar/Soroban.
 * Provides vote submission, IPFS integration, event indexing, and DAO caching.
 * Supports backend process clustering for multi-core utilization.
 */

import cluster from "node:cluster";
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";

import { buildOpenApiDocument } from "./openapi.js";

// Configuration and types
import { config, validateEnv, isValidContractId } from "./config.js";

// Cluster Service
import {
  startClusterMaster,
  initWorkerIpc,
  isLeaderWorker,
  onLeaderChange,
  registerWorkerShutdownHandler,
} from "./services/cluster.js";

// Services
import { log, logger } from "./services/logger.js";
import * as ipfsService from "./services/ipfs.js";
import { initPinManager } from "./services/ipfs-pin-manager.js";
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
import { metricsMiddleware } from "./middleware/metrics.js";

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
import metricsRoutes from "./routes/metrics.js";
import remediationRoutes from "./routes/remediation.js";

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
// BACKGROUND SERVICES MANAGEMENT
// ============================================

let backgroundServicesStarted = false;

async function startBackgroundServices(): Promise<void> {
  if (backgroundServicesStarted) return;
  backgroundServicesStarted = true;

  log("info", "starting_background_services", { pid: process.pid, isLeader: isLeaderWorker() });

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

  // Start periodic memory monitoring
  startMemoryMonitor(() => {
    log("warn", "memory_threshold_exceeded_triggering_shutdown", { pid: process.pid });
    if (config.clusterEnabled && process.exit) {
      process.exit(1); // Master will restart worker automatically
    }
  });
}

function stopBackgroundServices(): void {
  if (!backgroundServicesStarted) return;
  backgroundServicesStarted = false;

  log("info", "stopping_background_services", { pid: process.pid });

  stopIndexer();
  stopDaoSync();
  stopMembershipSync();
  stopTTLRenewal();
  stopPinMonitor();
  stopMemoryMonitor();
}

// ============================================
// SERVER STARTUP & CLUSTER CONTROLLER
// ============================================

if (import.meta.url === `file://${process.argv[1]}`) {
  if (config.clusterEnabled && cluster.isPrimary) {
    startClusterMaster();
  } else {
    initWorkerIpc();
    const PORT = config.port;

    const httpServer = app.listen(PORT, async () => {
      logger.info("server_started", {
        port: PORT,
        pid: process.pid,
        isCluster: config.clusterEnabled,
        isLeader: isLeaderWorker(),
        network: config.networkPassphrase,
        rpcUrl: config.rpcUrl,
        relayer: relayerKeypair.publicKey(),
      });

      console.log(`\nZKVote Relayer worker (${process.pid}) running on http://localhost:${PORT}`);

      if (config.clusterEnabled) {
        onLeaderChange(async (isLeader) => {
          if (isLeader) {
            log("info", "worker_elected_as_primary_starting_background_services", { pid: process.pid });
            await startBackgroundServices();
          } else {
            log("info", "worker_demoted_stopping_background_services", { pid: process.pid });
            stopBackgroundServices();
          }
        });

        if (isLeaderWorker()) {
          await startBackgroundServices();
        }
      } else {
        // Single process mode - start background services directly
        await startBackgroundServices();
      }
    });

    const DRAIN_TIMEOUT_MS = 25_000;
    let shuttingDown = false;

    function gracefulShutdown(reason: string): void {
      if (shuttingDown) return;
      shuttingDown = true;

      log("info", "shutdown_start", { reason, pid: process.pid });

      stopBackgroundServices();

      const forceExitTimer = setTimeout(() => {
        log("warn", "shutdown_forced", { reason, timeoutMs: DRAIN_TIMEOUT_MS, pid: process.pid });
        process.exit(1);
      }, DRAIN_TIMEOUT_MS);
      forceExitTimer.unref();

      httpServer.close((err) => {
        if (err) {
          log("error", "shutdown_close_error", { error: err.message, pid: process.pid });
        } else {
          log("info", "shutdown_complete", { reason, pid: process.pid });
        }
        clearTimeout(forceExitTimer);
        process.exit(0);
      });
    }

    registerWorkerShutdownHandler((reason) => gracefulShutdown(reason));

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  }
}

export { app };
