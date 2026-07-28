/**
 * Voting Routes
 *
 * Handles anonymous vote submission with ZK proofs and proposal results retrieval.
 */

import { Router, type Request, type Response } from "express";
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
  tlsClientCertGuard,
  voteLimiter,
  walletRateLimiter,
  queryLimiter,
  validateBody,
  validateParams,
} from "../middleware/index.js";
import {
  voteSchema,
  commitSchema,
  proposalParamsSchema,
  daoParamsSchema,
} from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";
import {
  getTransactionLog,
  recordTransactionLog,
  updateTransactionLogStatus,
  recordProofCommitment,
  getProofCommitment,
  updateProofCommitmentStatus,
} from "../services/db.js";
import {
  calculateProofHash,
  decryptProofPayload,
  createSubmissionReceipt,
  getRelayerPublicKey,
} from "../services/proof-encryption.js";
import { votesProcessed } from "../services/metrics.js";

const router = Router();

/**
 * GET /relayer/pubkey - Get relayer public key for proof encryption
 */
router.get("/relayer/pubkey", (_req: Request, res: Response) => {
  res.json({ publicKey: getRelayerPublicKey() });
});

/**
 * POST /vote/commit - Commit to a proof hash before revealing
 */
router.post(
  "/vote/commit",
  authGuard,
  tlsClientCertGuard,
  walletRateLimiter,
  validateBody(commitSchema),
  (async (req: Request, res: Response) => {
    const { daoId, proposalId, nullifier, commitmentHash, timestamp, walletAddress } = req.body;

    const now = Date.now();
    const ageSeconds = (now - timestamp) / 1000;

    if (ageSeconds > config.maxProofAgeSeconds) {
      return res.status(400).json({ error: "Proof expired: submission timestamp is too old" });
    }

    if (timestamp > now + 10000) {
      return res.status(400).json({ error: "Invalid timestamp: timestamp is in the future" });
    }

    const existingCommitment = getProofCommitment(commitmentHash);
    if (existingCommitment && existingCommitment.status === "REVEALED") {
      return res.status(400).json({ error: "Proof commitment already revealed" });
    }

    recordProofCommitment(commitmentHash, nullifier, daoId, proposalId, timestamp, walletAddress);

    log("info", "proof_committed", { daoId, proposalId, nullifier, commitmentHash });

    res.json({
      success: true,
      commitmentHash,
      status: "COMMITTED",
      expiresAt: new Date(timestamp + config.maxProofAgeSeconds * 1000).toISOString(),
    });
  }) as AsyncHandler,
);

router.post(
  "/vote",
  authGuard,
  tlsClientCertGuard,
  walletRateLimiter,
  voteLimiter,
  validateBody(voteSchema),
  (async (req: Request, res: Response) => {
    let body = config.stripRequestBodies ? {} : req.body;

    if (body.encryptedPayload) {
      try {
        body = decryptProofPayload(body.encryptedPayload);
      } catch (err) {
        return res.status(400).json({ error: "Failed to decrypt proof payload" });
      }
    }

    const { daoId, proposalId, choice, nullifier, root, proof, nonce, timestamp } = body;

    try {
      log("info", "vote_request", { daoId, proposalId });

      // Proof freshness validation
      if (timestamp) {
        const now = Date.now();
        const ageSeconds = (now - timestamp) / 1000;
        if (ageSeconds > config.maxProofAgeSeconds) {
          return res
            .status(400)
            .json({ error: "Proof expired: submission timestamp is too old" });
        }
        if (timestamp > now + 10000) {
          return res
            .status(400)
            .json({ error: "Invalid timestamp: timestamp is in the future" });
        }
      }

      // Proof commitment validation
      let commitmentHash: string | undefined;
      if (proof && nullifier && timestamp) {
        commitmentHash = calculateProofHash(proof, nullifier, timestamp, nonce);
        const commitmentRecord = getProofCommitment(commitmentHash);
        if (commitmentRecord) {
          if (commitmentRecord.status === "REVEALED") {
            return res
              .status(400)
              .json({ error: "Proof commitment already revealed" });
          }
          updateProofCommitmentStatus(commitmentHash, "REVEALED");
        }
      }

      // Replay protection: check local transaction log
      if (nullifier) {
        const existingTx = getTransactionLog(nullifier);
        if (
          existingTx &&
          (existingTx.status === "SUCCESS" || existingTx.status === "PENDING")
        ) {
          log("info", "vote_replay_prevented", {
            nullifier,
            txHash: existingTx.tx_hash,
            status: existingTx.status,
          });
          const receipt = createSubmissionReceipt(
            existingTx.tx_hash,
            nullifier,
            daoId,
            proposalId,
            commitmentHash || nullifier,
          );
          return res.json({
            success: true,
            txHash: existingTx.tx_hash,
            status: existingTx.status === "SUCCESS" ? "SUCCESS" : "PENDING",
            replayed: true,
            receipt,
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
          if (simResult.error) {
            const errorStr = JSON.stringify(simResult.error);
            if (errorStr.includes("already voted")) {
              errorMessage = "You have already voted on this proposal";
            } else if (errorStr.includes("voting period closed")) {
              errorMessage = "Voting period has ended";
            } else if (errorStr.includes("invalid proof")) {
              errorMessage = "Invalid vote proof";
            } else if (errorStr.includes("root must match")) {
              errorMessage = "You are not eligible to vote on this proposal";
            } else if (errorStr.includes("proposal not found")) {
              errorMessage = "Proposal not found";
            } else if (errorStr.includes("UnreachableCodeReached")) {
              errorMessage =
                "Invalid proof or contract error (proof verification failed)";
            }
          }

          throw new Error(`SIMULATION_FAILED:${errorMessage}`);
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
        const receipt = createSubmissionReceipt(
          sendResult.hash,
          nullifier,
          daoId,
          proposalId,
          commitmentHash || nullifier,
        );
        res.json({
          success: true,
          txHash: sendResult.hash,
          status: result.status,
          receipt,
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

    const errMsg = (err as Error).message || "";
    let statusCode = 500;
    let userMessage = "Internal server error";

    if (errMsg.startsWith("SIMULATION_FAILED:")) {
      statusCode = 400;
      userMessage = errMsg.slice("SIMULATION_FAILED:".length);
    } else if (errMsg === "SUBMIT_FAILED") {
      statusCode = 500;
      userMessage = "Transaction submission failed";
    } else if (errMsg.includes("Timeout:")) {
      statusCode = 504;
      userMessage = "Request timeout - please try again";
    } else if (errMsg.includes("Transaction not found after timeout")) {
      statusCode = 504;
      userMessage =
        "Transaction confirmation timeout - vote may have succeeded, please check proposal results";
    } else if (errMsg.includes("getAccount")) {
      statusCode = 503;
      userMessage = "Blockchain RPC temporarily unavailable - please retry";
    } else if (
      errMsg.includes("ECONNREFUSED") ||
      errMsg.includes("ETIMEDOUT")
    ) {
      statusCode = 503;
      userMessage = "Network error - please retry";
    } else if (errMsg.includes("sequence")) {
      statusCode = 503;
      userMessage = "Transaction sequence error - please retry";
    }

    res
      .status(statusCode)
      .json(
        config.genericErrors
          ? { error: userMessage }
          : { error: userMessage, details: errMsg },
      );
  }
}) as AsyncHandler);

/**
 * GET /proposal/:daoId/:proposalId - Get proposal results
 */
router.get("/proposal/:daoId/:proposalId", queryLimiter, validateParams(proposalParamsSchema), (async (
  req: Request,
  res: Response,
) => {
  const { daoId, proposalId } = (req as any).validatedParams;

  try {
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
      return res.status(404).json({ error: "Proposal not found" });
    }

    // Parse results from simulation
    const resultScVal = simResult.result?.retval;
    if (!resultScVal) {
      return res.status(500).json({ error: "No result returned" });
    }

    // Parse the tuple (yes_votes, no_votes, closed)
    const resultVec = resultScVal.vec();
    if (!resultVec || resultVec.length < 3) {
      return res.status(500).json({ error: "Invalid result format" });
    }

    const yesVotes = resultVec[0].u64().toString();
    const noVotes = resultVec[1].u64().toString();
    const closed = resultVec[2].b();

    res.json({
      daoId,
      proposalId,
      yesVotes,
      noVotes,
      closed,
    });
  } catch (err) {
    log("error", "proposal_fetch_error", {
      daoId,
      proposalId,
      error: (err as Error).message,
    });
    res.status(500).json({ error: "Failed to fetch proposal results" });
  }
}) as AsyncHandler);

/**
 * GET /root/:daoId - Get current Merkle root for a DAO
 */
router.get("/root/:daoId", queryLimiter, validateParams(daoParamsSchema), (async (
  req: Request,
  res: Response,
) => {
  const { daoId } = (req as any).validatedParams;

  try {
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
      return res
        .status(404)
        .json({ error: "DAO not found or tree not initialized" });
    }

    const resultScVal = simResult.result?.retval;
    if (!resultScVal) {
      return res.status(500).json({ error: "No result returned" });
    }

    const root = scValToU256Hex(resultScVal);

    res.json({
      daoId,
      root,
    });
  } catch (err) {
    log("error", "root_fetch_error", { daoId, error: (err as Error).message });
    res.status(500).json({ error: "Failed to fetch Merkle root" });
  }
}) as AsyncHandler);

export default router;
