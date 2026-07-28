/**
 * Voting Routes
 *
 * Handles anonymous vote submission with ZK proofs and proposal results retrieval.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";

import { config } from "../config.js";
import { log } from "../services/logger.js";
import {
  server,
  relayerKeypair,
  callWithTimeout,
  simulateWithBackoff,
  waitForTransaction,
  withSequenceLock,
  u256ToScVal,
  proofToScVal,
  scValToU256Hex,
} from "../services/stellar.js";
import {
  authGuard,
  auditLog,
  voteLimiter,
  queryLimiter,
  validateBody,
  validateParams,
} from "../middleware/index.js";
import { voteSchema, proposalParamsSchema, daoParamsSchema } from "../validation/schemas.js";
import { type AsyncHandler, ErrorCode } from "../types/index.js";
import { ApiError } from "../utils/errors.js";
import {
  getTransactionLog,
  recordTransactionLog,
  updateTransactionLogStatus,
} from "../services/db.js";
import { votesProcessed } from "../services/metrics.js";
import { sharedSingleFlight } from "../utils/singleflight.js";

const router = Router();

/**
 * POST /vote - Submit anonymous vote with ZK proof
 */
router.post("/vote", authGuard, auditLog("vote_relay"), voteLimiter, validateBody(voteSchema), (async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Validated by voteSchema middleware
  const { daoId, proposalId, choice, nullifier, root, proof } =
    config.stripRequestBodies ? {} : req.body;

  try {
    log("info", "vote_request", { daoId, proposalId });

    // Replay protection: check local transaction log
    if (nullifier) {
      const existingTx = getTransactionLog(nullifier);
      if (existingTx && (existingTx.status === "SUCCESS" || existingTx.status === "PENDING")) {
        log("info", "vote_replay_prevented", { nullifier, txHash: existingTx.tx_hash, status: existingTx.status });
        return res.json({
          success: true,
          txHash: existingTx.tx_hash,
          status: existingTx.status === "SUCCESS" ? "SUCCESS" : "PENDING",
          replayed: true,
        });
      }
    }

    // Convert inputs to Soroban types
    let scNullifier: StellarSdk.xdr.ScVal;
    let scRoot: StellarSdk.xdr.ScVal;
    let scProof: StellarSdk.xdr.ScVal;
    try {
      scNullifier = u256ToScVal(nullifier);
      scRoot = u256ToScVal(root);
      scProof = proofToScVal(proof);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    if (config.testMode) {
      return res.status(400).json({ error: "Simulation failed (test mode)" });
    }

    // Build contract call
    const contract = new StellarSdk.Contract(config.votingContractId!);

    const args = [
      StellarSdk.nativeToScVal(daoId, { type: "u64" }),
      StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
      StellarSdk.nativeToScVal(choice, { type: "bool" }),
      scNullifier,
      scRoot,
      scProof,
    ];

    const operation = contract.call("vote", ...args);

    // Serialize account fetch + build + simulate + sign + submit under sequence lock
    // to prevent nonce race conditions between concurrent requests
    const { sendResult, result } = await withSequenceLock(async () => {
      // Get relayer account
      const account = await (server as StellarSdk.rpc.Server).getAccount(
        relayerKeypair.publicKey(),
      );

      // Build transaction
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "100000",
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      // Simulate
      log("info", "simulate_vote", { daoId, proposalId });
      const simResult = await callWithTimeout(
        () =>
          simulateWithBackoff(() =>
            (server as StellarSdk.rpc.Server).simulateTransaction(tx),
          ),
        "simulate_vote",
      );

      if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
        log("warn", "simulation_failed", {
          daoId,
          proposalId,
          error: simResult.error,
        });

        let errorMessage = "Transaction simulation failed";
        let errorCode = ErrorCode.INTERNAL_ERROR;
        if (simResult.error) {
          const errorStr = JSON.stringify(simResult.error);
          if (errorStr.includes("already voted")) {
            errorMessage = "You have already voted on this proposal";
            errorCode = ErrorCode.VOTE_ALREADY_CAST;
          } else if (errorStr.includes("voting period closed")) {
            errorMessage = "Voting period has ended";
            errorCode = ErrorCode.VOTING_PERIOD_CLOSED;
          } else if (errorStr.includes("invalid proof")) {
            errorMessage = "Invalid vote proof";
            errorCode = ErrorCode.INVALID_PROOF;
          } else if (errorStr.includes("root must match")) {
            errorMessage = "You are not eligible to vote on this proposal";
            errorCode = ErrorCode.NOT_ELIGIBLE;
          } else if (errorStr.includes("proposal not found")) {
            errorMessage = "Proposal not found";
            errorCode = ErrorCode.PROPOSAL_NOT_FOUND;
          } else if (errorStr.includes("UnreachableCodeReached")) {
            errorMessage =
              "Invalid proof or contract error (proof verification failed)";
            errorCode = ErrorCode.INVALID_PROOF;
          }
        }

        throw new ApiError(400, errorCode, errorMessage, simResult.error);
      }

      // Prepare and sign
      const preparedTx = StellarSdk.rpc
        .assembleTransaction(tx, simResult)
        .build();
      preparedTx.sign(relayerKeypair as StellarSdk.Keypair);

      // Submit
      log("info", "submit_vote", { daoId, proposalId });
      const sr = await callWithTimeout(
        () => (server as StellarSdk.rpc.Server).sendTransaction(preparedTx),
        "send_vote",
      );

      if (sr.status === "ERROR") {
        if (nullifier) updateTransactionLogStatus(nullifier, "FAILED");
        log("error", "submit_failed", {
          daoId,
          proposalId,
          error: sr.errorResult,
        });
        throw new Error("SUBMIT_FAILED");
      }

      if (nullifier && sr.hash) {
        recordTransactionLog(nullifier, sr.hash, "PENDING");
      }

      // Wait for confirmation
      log("info", "submitted", { txHash: sr.hash, daoId, proposalId });
      const r = await callWithTimeout(
        () => waitForTransaction(sr.hash),
        "wait_for_vote",
      );

      return { sendResult: sr, result: r };
    });

    if (result.status === "SUCCESS") {
      if (nullifier && sendResult.hash) {
        updateTransactionLogStatus(nullifier, "SUCCESS", sendResult.hash);
      }
      votesProcessed.inc({ status: "success" });
      log("info", "vote_success", {
        txHash: sendResult.hash,
        daoId,
        proposalId,
      });
      res.json({
        success: true,
        txHash: sendResult.hash,
        status: result.status,
      });
    } else {
      if (nullifier && sendResult.hash) {
        updateTransactionLogStatus(nullifier, "FAILED", sendResult.hash);
      }
      votesProcessed.inc({ status: "failed" });
      log("error", "vote_failed", {
        txHash: sendResult.hash,
        status: result.status,
      });
      res.status(500).json({
        error: "Transaction failed",
        txHash: sendResult.hash,
        status: result.status,
      });
    }
  } catch (err) {
    if (nullifier) {
      updateTransactionLogStatus(nullifier, "FAILED");
    }
    votesProcessed.inc({ status: "error" });
    log("error", "vote_exception", {
      message: (err as Error).message,
      stack: (err as Error).stack,
    });

    if (err instanceof ApiError) {
      return next(err);
    }

    const errMsg = (err as Error).message || "";
    let statusCode = 500;
    let errorCode = ErrorCode.INTERNAL_ERROR;
    let userMessage = "Internal server error";

    if (errMsg === "SUBMIT_FAILED") {
      statusCode = 500;
      userMessage = "Transaction submission failed";
    } else if (errMsg.includes("Timeout:")) {
      statusCode = 504;
      errorCode = ErrorCode.TIMEOUT;
      userMessage = "Request timeout - please try again";
    } else if (errMsg.includes("Transaction not found after timeout")) {
      statusCode = 504;
      errorCode = ErrorCode.TIMEOUT;
      userMessage =
        "Transaction confirmation timeout - vote may have succeeded, please check proposal results";
    } else if (errMsg.includes("getAccount")) {
      statusCode = 503;
      errorCode = ErrorCode.SERVICE_UNAVAILABLE;
      userMessage = "Blockchain RPC temporarily unavailable - please retry";
    } else if (
      errMsg.includes("ECONNREFUSED") ||
      errMsg.includes("ETIMEDOUT")
    ) {
      statusCode = 503;
      errorCode = ErrorCode.SERVICE_UNAVAILABLE;
      userMessage = "Network error - please retry";
    } else if (errMsg.includes("sequence")) {
      statusCode = 503;
      errorCode = ErrorCode.SERVICE_UNAVAILABLE;
      userMessage = "Transaction sequence error - please retry";
    }

    return next(new ApiError(statusCode, errorCode, userMessage, errMsg));
  }
}) as AsyncHandler);

/**
 * GET /proposal/:daoId/:proposalId - Get proposal results
 */
router.get("/proposal/:daoId/:proposalId", queryLimiter, validateParams(proposalParamsSchema), (async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { daoId, proposalId } = (req as any).validatedParams;

  try {
    const result = await sharedSingleFlight.do(`proposal:${daoId}:${proposalId}`, async () => {
      const contract = new StellarSdk.Contract(config.votingContractId!);
      const args = [
        StellarSdk.nativeToScVal(daoId, { type: "u64" }),
        StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
      ];

      const operation = contract.call("get_results", ...args);

      const account = await (server as StellarSdk.rpc.Server).getAccount(
        relayerKeypair.publicKey(),
      );
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "100000",
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await (
        server as StellarSdk.rpc.Server
      ).simulateTransaction(tx);

      if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
        throw new Error("PROPOSAL_NOT_FOUND");
      }

      // Parse results from simulation
      const resultScVal = simResult.result?.retval;
      if (!resultScVal) {
        throw new Error("NO_RESULT_RETURNED");
      }

      // Parse the tuple (yes_votes, no_votes, closed)
      const resultVec = resultScVal.vec();
      if (!resultVec || resultVec.length < 3) {
        throw new Error("INVALID_RESULT_FORMAT");
      }

      const yesVotes = resultVec[0].u64().toString();
      const noVotes = resultVec[1].u64().toString();
      const closed = resultVec[2].b();

      return {
        daoId,
        proposalId,
        yesVotes,
        noVotes,
        closed,
      };
    });

    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    
    const errMsg = (err as Error).message;
    if (errMsg === "PROPOSAL_NOT_FOUND") {
      return next(new ApiError(404, ErrorCode.PROPOSAL_NOT_FOUND, "Proposal not found"));
    } else if (errMsg === "NO_RESULT_RETURNED") {
      return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "No result returned"));
    } else if (errMsg === "INVALID_RESULT_FORMAT") {
      return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "Invalid result format"));
    }
    log("error", "proposal_fetch_error", {
      daoId,
      proposalId,
      error: errMsg,
    });
    return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "Failed to fetch proposal results", errMsg));
  }
}) as AsyncHandler);

/**
 * GET /root/:daoId - Get current Merkle root for a DAO
 */
router.get("/root/:daoId", queryLimiter, validateParams(daoParamsSchema), (async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { daoId } = (req as any).validatedParams;

  try {
    const result = await sharedSingleFlight.do(`root:${daoId}`, async () => {
      const contract = new StellarSdk.Contract(config.treeContractId!);
      const args = [StellarSdk.nativeToScVal(daoId, { type: "u64" })];

      const operation = contract.call("get_root", ...args);

      const account = await (server as StellarSdk.rpc.Server).getAccount(
        relayerKeypair.publicKey(),
      );
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "100000",
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await (
        server as StellarSdk.rpc.Server
      ).simulateTransaction(tx);

      if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
        throw new Error("DAO_NOT_FOUND");
      }

      const resultScVal = simResult.result?.retval;
      if (!resultScVal) {
        throw new Error("NO_RESULT_RETURNED");
      }

      const root = scValToU256Hex(resultScVal);

      return {
        daoId,
        root,
      };
    });

    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    
    const errMsg = (err as Error).message;
    if (errMsg === "DAO_NOT_FOUND") {
      return next(new ApiError(404, ErrorCode.DAO_NOT_FOUND, "DAO not found or tree not initialized"));
    } else if (errMsg === "NO_RESULT_RETURNED") {
      return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "No result returned"));
    }
    log("error", "root_fetch_error", { daoId, error: errMsg });
    return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "Failed to fetch Merkle root", errMsg));
  }
}) as AsyncHandler);

export default router;
