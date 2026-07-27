/**
 * ZKVote Backend - Main Entry Point
 *
 * TypeScript backend relayer for anonymous voting on Stellar/Soroban.
 * Provides vote submission, IPFS integration, event indexing, and DAO caching.
 */

import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";

// Configuration and types
import { config, validateEnv, isValidContractId } from "./config.js";

// Services
import { log, logger } from "./services/logger.js";
import * as ipfsService from "./services/ipfs.js";
import { initPinManager } from "./services/ipfs-pin-manager.js";
import { startMonitor as startPinMonitor, stopMonitor as stopPinMonitor } from "./services/ipfs-monitor.js";
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

// Middleware
import { csrfGuard, requestLogger, errorHandler } from "./middleware/index.js";

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

// CSRF protection (applied globally)
app.use(csrfGuard);

// ============================================
// ROUTE INITIALIZATION
// ============================================

// Initialize routes that need dependencies
initHealthRoutes(server, relayerKeypair.publicKey());
initIndexerRoutes(triggerDaoMembershipSync);

// Mount route handlers
app.use(healthRoutes);
app.use(votingRoutes);
app.use(daoRoutes);
app.use(ipfsRoutes);
app.use(commentsRoutes);
app.use(indexerRoutes);
app.use(bridgeRoutes);
app.use(circuitRoutes);

// Global error handler (must be last)
app.use(errorHandler);

// ============================================
// SERVER STARTUP
// ============================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = config.port;

  app.listen(PORT, async () => {
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
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    log("info", "shutdown_signal");
    stopIndexer();
    stopDaoSync();
    stopMembershipSync();
    stopTTLRenewal();
    stopPinMonitor();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    log("info", "shutdown_signal");
    stopIndexer();
    stopDaoSync();
    stopMembershipSync();
    stopTTLRenewal();
    stopPinMonitor();
    process.exit(0);
  });
}

export { app };
